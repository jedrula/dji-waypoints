// The survey itself, with the mission inside it.
//
// js/view3d.js draws the flight over a flat plane with map imagery painted on
// it. That is a photograph of the ground, not the ground: anything with height
// leans away from nadir, so a roof is painted metres from the walls holding it
// up, and the only real geometry in the picture is the boxes you drew. This is
// the other thing -- the national LiDAR as a surface, at half-metre cells, with
// the flight in the same space. What the aircraft would hit is what you can see
// it nearly hitting.
//
// Two renderers in one app is a cost, taken deliberately. view3d.js is canvas
// 2D with a painter's algorithm and no depth buffer, and a million-cell surface
// is not something it can be taught: even decimated hard you would lose the
// texture and gain a slideshow. This is WebGL through three.js, loaded from a
// CDN the way Leaflet already is and only when the view is first opened, so an
// ordinary session never fetches it.
//
// What this does NOT do yet: draw the obstacles you tapped, and let you move a
// waypoint. The first is nearly redundant here -- the buildings and trees ARE
// in the surface, which is the whole point -- and the second is the next step
// and wants picking, which is most of why three.js is here rather than the
// hand-written GL in server/public/scene.html.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { toPuwg92 } from './puwg92.js';
import { groundAt, puwgToLocal, drapeWire } from './surface.js';
import { serviceUrl, serviceHeaders } from './service.js';
import { PASS_COLOR, PASS_FALLBACK, LEG_COLOR, asHex } from './palette.js';
import { fov, orientation } from './camera.js';

// How much ground round the flight, and how fine. The tile is 500 m of
// half-metre cells -- a million of them -- and a site is a couple of hundred
// metres, so cropping to the flight and its margin is both smaller and sharper
// than decimating the lot. The vertex cap is what keeps a big site from asking
// for ten million triangles: past it the step coarsens instead.
// How much ground around the flight. 60 m was the flight plus a shoulder, and
// on a small site in a dense block that put the camera at street level facing
// a wall with no neighbourhood behind it -- which is why the service's own
// viewer, which always draws the whole 500 m tile, looked so much better than
// this did. A site is usually tens of metres and the interesting hazards are
// the things around it, so the margin is now most of a tile.
const MARGIN_M = 200;
// Enough that the 200 m margin above stays at the survey's own half-metre
// cells instead of being halved to one metre. Measured over Cybulskiego 22,
// tile 725/724: the crop is 857x622 = 533k vertices with 54,936 wall triangles
// and takes 335 ms to build, against 214 ms for the same crop decimated to
// 1 m. 121 ms, once, on a view whose first tile is minutes of downloading --
// and a metre is the width of the things this picture exists to show.
const MAX_VERTS = 600_000;

// A step between neighbouring cells this big is a vertical face rather than a
// slope. Same 1.75 m the service's viewer defaults its "mark walls at" slider
// to -- see the vertex shader in server/public/scene.html, which these two
// rules are deliberately a copy of.
const WALL_STEP_M = 1.75;
const KIND_BUILDING = 2;

// The same four the map uses, so a red line is a red line in both pictures.
const WIRE_COLOUR = {
  WN: 0xff5d5d, SN: 0xff9c3d, 'n/n': 0xffd85e, LTK: 0x6aa9ff,
};

// A cell's classification, for when there is no orthophoto to drape -- which is
// most of the country, outside the towns.
//
// These were dark and desaturated on the reasoning that this is data and not a
// rendering. Daylight values now. A view you do not want to look at is a view
// you will not check your flight against, and being pretty costs nothing here:
// the classification is a flat lookup either way.
// Ground is stone and not grass, on purpose. Lawn green there was the first
// thing tried and it painted the Rynek's paving as a meadow -- the LiDAR class
// means "bare earth", which is a field, a car park or a market square alike,
// and vegetation is a class of its own that this one is precisely not.
const KIND_COLOUR = [
  [0.60, 0.58, 0.55],   // none, guessed by filling a hole
  [0.70, 0.66, 0.58],   // ground
  [0.82, 0.78, 0.72],   // building
  [0.37, 0.55, 0.33],   // vegetation
  [0.38, 0.56, 0.72],   // water
];

const POLL_MS = 4000;
const GIVE_UP_MS = 240_000;   // a cold scene is minutes; see js/heights.js

async function ask(path, { signal } = {}) {
  const res = await fetch(`${serviceUrl()}${path}`, { headers: serviceHeaders(), signal });
  return res;
}

// The service answers 202 while it builds, which for new ground means pulling
// hundreds of megabytes of LiDAR from GUGiK. Never a held-open request -- the
// tunnel in front of it cuts one at about 100 s -- so poll, and say so.
async function poll(path, { onWait, signal } = {}) {
  const until = Date.now() + GIVE_UP_MS;
  let told = false;
  for (;;) {
    const res = await ask(path, { signal });
    if (res.status === 200) return res;
    if (res.status !== 202) {
      const why = await res.json().catch(() => ({}));
      throw new Error(why.error ?? `the service answered ${res.status}`);
    }
    if (Date.now() > until) throw new Error('the survey is still building — try again shortly');
    if (!told) { told = true; onWait?.(); }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

export function createScene3D(canvas) {
  let renderer = null;
  let scene = null;
  let camera = null;
  let controls = null;
  let missionGroup = null;
  let wireGroup = null;
  let wirePaths = [];
  let looksOn = true;
  let surfaceMesh = null;
  let loaded = null;       // { tn, te, meta, height, kind, base }
  let mission = null;
  let hazard = null;
  let onStatus = () => {};
  let running = false;
  let opening = false;
  let inFlight = null;

  function boot() {
    if (renderer) return;
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    scene = new THREE.Scene();
    // A sky, not a void. The clear colour was the app's own near-black panel
    // colour, which hung the model in an empty room and left nothing to tell
    // you which way was up in a view you orbit by hand. The horizon does that.
    scene.background = sky();
    camera = new THREE.PerspectiveCamera(55, 1, 1, 8000);
    controls = new OrbitControls(camera, canvas);
    controls.maxPolarAngle = Math.PI / 2 - 0.02;   // never under the ground
    // Drawn on demand, from the controls' own change event -- no animation
    // loop. Two reasons, and the second one bit: a loop spins the GPU while
    // nobody is moving anything, and requestAnimationFrame does not fire in a
    // window that is not being painted, which is exactly how this gets driven
    // under test.
    //
    // Damping is off BECAUSE of that. It needs a frame after the last input to
    // settle, so it only works inside a loop -- and wired to a change event it
    // is an infinite recursion, because update() emits change. Which is the
    // bug this comment is standing on: "Maximum call stack size exceeded", the
    // first time the view was ever opened.
    controls.enableDamping = false;
    controls.addEventListener('change', () => render());
    // The service's own viewer shades the same surface as
    //
    //     lambert = 0.42 + 0.58 * max(dot(normal, SUN), 0)
    //
    // applied straight to the orthophoto -- see the fragment shader in
    // server/public/scene.html. A wall therefore never falls below 0.42 of the
    // photo, and nothing ever exceeds it. That is the right model for a drape:
    // the photo is a photograph taken in sunlight and already has the sun in
    // it, so the shading is only there to give the relief an edge.
    //
    // three.js lights physically -- what leaves a diffuse surface is
    // albedo * irradiance / PI -- so multiplying both terms by PI reproduces
    // that expression exactly, with no shader of our own.
    //
    // A HemisphereLight was tried here and is what made this view so much
    // worse than the viewer on a dense street: its fill is keyed to how far a
    // normal points at the sky, so every facade collapsed towards the
    // ground-bounce colour, and in a city block seen from a low camera almost
    // everything you look at IS a facade. Flat ambient is the honest one,
    // because a drape has no more information about a wall than a floor.
    const sun = new THREE.DirectionalLight(0xffffff, Math.PI * 0.58);
    // The viewer's SUN, in the same frame: x east, y up, z south.
    sun.position.set(0.45, 0.8, 0.35);
    scene.add(sun, new THREE.AmbientLight(0xffffff, Math.PI * 0.42));
  }

  // The sky, as a vertical two-stop gradient on a 2 px-wide canvas. Cheaper
  // than a cube map and there is nothing here a cube map would add.
  function sky() {
    const c = document.createElement('canvas');
    c.width = 2;
    c.height = 256;
    const ctx = c.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0, '#22405f');
    g.addColorStop(0.62, '#7ba2c6');
    g.addColorStop(1, '#cfdce6');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 2, 256);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  function size() {
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;
    const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  function render() {
    if (!renderer || !running) return;
    size();
    renderer.render(scene, camera);
  }

  // Y is metres above the mission's home point, which is what every altitude in
  // this app already means. So the surface is shifted down by its own height at
  // the home point and nothing else has to be converted at all.
  function buildSurface() {
    if (!loaded || !mission) return;
    const { meta, height, kind } = loaded;
    const N = meta.grid;
    const cell = meta.cellMetres;
    const { east: e0, north: n0 } = meta.origin;
    const frame = mission.frame;
    const toLocal = puwgToLocal(frame, e0, n0);

    // Where the flight is, in this tile's own grid.
    const path = mission.exported ?? mission.waypoints ?? [];
    let eMin = Infinity; let eMax = -Infinity; let nMin = Infinity; let nMax = -Infinity;
    for (const w of path) {
      const p = toPuwg92(w.lat, w.lon);
      if (p.east < eMin) eMin = p.east;
      if (p.east > eMax) eMax = p.east;
      if (p.north < nMin) nMin = p.north;
      if (p.north > nMax) nMax = p.north;
    }
    if (!Number.isFinite(eMin)) return;

    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const c0 = clamp(Math.floor((eMin - MARGIN_M - e0) / cell), 0, N - 2);
    const c1 = clamp(Math.ceil((eMax + MARGIN_M - e0) / cell), c0 + 1, N - 1);
    // Row 0 is the NORTH edge of the tile, so north and row run opposite ways.
    const r0 = clamp(Math.floor((n0 + meta.tileMetres - (nMax + MARGIN_M)) / cell), 0, N - 2);
    const r1 = clamp(Math.ceil((n0 + meta.tileMetres - (nMin - MARGIN_M)) / cell), r0 + 1, N - 1);

    let step = 1;
    while (((c1 - c0) / step + 1) * ((r1 - r0) / step + 1) > MAX_VERTS) step *= 2;
    const cols = Math.floor((c1 - c0) / step) + 1;
    const rows = Math.floor((r1 - r0) / step) + 1;

    const heightAt = (row, col) => meta.base + height[row * N + col] / 100;
    // The zero everything is measured from: the ground under the home point.
    // Off the tile there is nothing to measure from, so the lowest corner of
    // the crop stands in -- wrong by a metre or two, and not silently absent.
    const datum = (path[0] && groundAt(meta, height, path[0].lat, path[0].lon))
      ?? heightAt(r0, c0);

    const verts = new Float32Array(cols * rows * 3);
    const uvs = new Float32Array(cols * rows * 2);
    const colours = new Float32Array(cols * rows * 3);
    let i = 0;
    for (let r = 0; r < rows; r++) {
      const row = r0 + r * step;
      for (let c = 0; c < cols; c++) {
        const col = c0 + c * step;
        const east = e0 + (col + 0.5) * cell;
        const north = n0 + meta.tileMetres - (row + 0.5) * cell;
        const l = toLocal(east, north);
        // three.js is Y-up, and the local frame is x east / y north.
        verts[i * 3] = l.x;
        verts[i * 3 + 1] = heightAt(row, col) - datum;
        verts[i * 3 + 2] = -l.y;
        uvs[i * 2] = (col + 0.5) / N;
        uvs[i * 2 + 1] = 1 - (row + 0.5) / N;
        const k = KIND_COLOUR[kind[row * N + col]] ?? KIND_COLOUR[0];
        colours[i * 3] = k[0]; colours[i * 3 + 1] = k[1]; colours[i * 3 + 2] = k[2];
        i++;
      }
    }

    // A wall is a smear. The survey was flown looking straight down, so there
    // are no pixels for a vertical face: whatever the photo puts there is the
    // roof edge stretched down the side of the building, and a stretched roof
    // is the one thing in this picture that is not evidence. The service's
    // viewer paints those cells flat instead of dressing them up, and not
    // doing the same here is most of why ours looked worse on a street of
    // tenements -- every facade in shot was a smear being presented as ground
    // truth.
    //
    // Only a BUILDING, and only where the step is real -- the same two guards
    // the viewer's shader carries, for its reasons: a tree crown has metres of
    // variance between neighbouring half-metre cells, so the step test fires
    // all over a canopy where there is no flat face and nothing being
    // occluded; and a step between cells nothing was measured in is the
    // hole-filling showing through, which points at the wrong thing entirely.
    const isWall = (row, col) => {
      if (kind[row * N + col] !== KIND_BUILDING) return false;
      const l = heightAt(row, Math.max(col - 1, 0));
      const r = heightAt(row, Math.min(col + 1, N - 1));
      const u = heightAt(Math.max(row - 1, 0), col);
      const d = heightAt(Math.min(row + 1, N - 1), col);
      // Full-resolution neighbours whatever the decimation, because the step is
      // a property of the ground and not of how coarsely we chose to draw it.
      return Math.max(Math.abs(r - l), Math.abs(d - u)) * 0.5 >= WALL_STEP_M;
    };
    const wallVert = new Uint8Array(cols * rows);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        wallVert[r * cols + c] = isWall(r0 + r * step, c0 + c * step) ? 1 : 0;
      }
    }

    // Two index buffers over one set of vertices: the photographed surface, and
    // the faces that photograph cannot speak for. A quad goes to the second if
    // any corner of it is a wall, so a facade is marked whole rather than
    // dithered.
    const skin = [];
    const walls = [];
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const a = r * cols + c;
        const to = (wallVert[a] || wallVert[a + 1] || wallVert[a + cols] || wallVert[a + cols + 1])
          ? walls : skin;
        to.push(a, a + cols, a + 1, a + 1, a + cols, a + cols + 1);
      }
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    geom.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geom.setAttribute('color', new THREE.BufferAttribute(colours, 3));
    // Both draws share these vertices and so share one normal per vertex,
    // which is what makes the marked faces sit flush in the same light.
    geom.setIndex(skin.concat(walls));
    geom.computeVertexNormals();
    geom.clearGroups();
    geom.addGroup(0, skin.length, 0);
    geom.addGroup(skin.length, walls.length, 1);

    if (surfaceMesh) { scene.remove(surfaceMesh); surfaceMesh.geometry.dispose(); }
    // Lambert, not Standard: the viewer's rule is pure Lambert with no
    // specular term, and a roughness lobe over a photograph of a roof is
    // inventing a highlight that nothing measured.
    const skinMat = new THREE.MeshLambertMaterial({
      map: loaded.ortho ?? null,
      vertexColors: !loaded.ortho,
    });
    // The viewer's own "building wall (not seen)" brown, so the two pictures
    // agree about what the colour means as well as where it goes.
    const wallMat = new THREE.MeshLambertMaterial({ color: 0x8a6a4a });
    surfaceMesh = new THREE.Mesh(geom, [skinMat, wallMat]);
    scene.add(surfaceMesh);

    // Did the crop hit the edge of the tile rather than the margin it asked
    // for? A tile is 500 m and a site can sit anywhere in it, so this is the
    // common case rather than the exotic one -- and a surface that stops in a
    // straight line under half your flight has to say why. Stitching the
    // neighbouring tiles is the fix; saying so is the honest stopgap.
    const wantC0 = Math.floor((eMin - MARGIN_M - e0) / cell);
    const wantC1 = Math.ceil((eMax + MARGIN_M - e0) / cell);
    const wantR0 = Math.floor((n0 + meta.tileMetres - (nMax + MARGIN_M)) / cell);
    const wantR1 = Math.ceil((n0 + meta.tileMetres - (nMin - MARGIN_M)) / cell);
    loaded.clipped = wantC0 < 0 || wantR0 < 0 || wantC1 > N - 1 || wantR1 > N - 1;

    loaded.datum = datum;
    loaded.cells = cols * rows;
    loaded.step = step;
    buildMission();
    buildWires();
    frameCamera();
  }

  // Overhead lines, at the height the voltage implies, over the ground that is
  // actually under them.
  //
  // That last part is why this waits for the surface: a wire's height is
  // metres above the ground beneath it, not above the takeoff point, so every
  // vertex is lifted by the surface it crosses. Drawn flat at one altitude the
  // whole run would sink into the first hill it met.
  //
  // The register knows where they run and not how high they hang -- see
  // js/lines.js -- so this is an assumption drawn as confidently as the
  // geometry it hangs on, which is worth remembering when it looks precise.
  function buildWires() {
    if (!scene) return;
    if (wireGroup) { scene.remove(wireGroup); wireGroup = null; }
    if (!wirePaths.length || !loaded?.meta || !mission || loaded.datum === undefined) return;
    const { meta, height } = loaded;
    const frame = mission.frame;
    wireGroup = new THREE.Group();
    for (const w of wirePaths) {
      const pts = drapeWire(meta, height, frame, loaded.datum, w)
        .map((p) => new THREE.Vector3(p.x, p.y, p.z));
      if (pts.length < 2) continue;
      const g = new THREE.BufferGeometry().setFromPoints(pts);
      wireGroup.add(new THREE.Line(g, new THREE.LineBasicMaterial({
        color: WIRE_COLOUR[w.kind] ?? 0xff9c3d,
      })));
    }
    scene.add(wireGroup);
  }

  function buildMission() {
    if (!scene || !mission) return;
    if (missionGroup) scene.remove(missionGroup);
    missionGroup = new THREE.Group();
    const frame = mission.frame;
    const path = mission.exported ?? mission.waypoints ?? [];
    const at = (w) => {
      const l = frame.toLocal(w.lat, w.lon);
      return new THREE.Vector3(l.x, w.alt, -l.y);
    };

    // One line per RUN of same-pass waypoints, in that pass's own colour --
    // the way the map and the flat view both draw it. This was a single blue
    // polyline for the whole flight, which made the survey view a picture of a
    // different mission: on the left a green orbit and an orange grid, on the
    // right one blue scribble.
    let run = [];
    let runPass = path[0]?.pass;
    const flushRun = () => {
      if (run.length > 1) {
        const g = new THREE.BufferGeometry().setFromPoints(run);
        missionGroup.add(new THREE.Line(g, new THREE.LineBasicMaterial({
          color: asHex(PASS_COLOR[runPass] ?? PASS_FALLBACK),
        })));
      }
      run = run.length ? [run[run.length - 1]] : [];
    };
    for (const w of path) {
      if (w.pass !== runPass) { flushRun(); runPass = w.pass; }
      run.push(at(w));
    }
    flushRun();

    // The stations themselves, so a pass reads as the shots it is rather than
    // as one continuous stroke. Grouped by pass so each keeps its own colour.
    const byPass = new Map();
    for (const w of path) {
      if (!byPass.has(w.pass)) byPass.set(w.pass, []);
      byPass.get(w.pass).push(at(w));
    }
    for (const [pass, pts] of byPass) {
      const g = new THREE.BufferGeometry().setFromPoints(pts);
      missionGroup.add(new THREE.Points(g, new THREE.PointsMaterial({
        color: asHex(PASS_COLOR[pass] ?? PASS_FALLBACK), size: 2.2, sizeAttenuation: true,
      })));
    }

    if (looksOn) buildLooks(path, at);

    // The legs the collision check flagged, drawn over the top in its colours.
    // A strike and a near miss are not the same news, so they are not the same
    // colour here either.
    for (const leg of hazard?.legs ?? []) {
      const g = new THREE.BufferGeometry().setFromPoints([at(leg.a), at(leg.b)]);
      missionGroup.add(new THREE.Line(g, new THREE.LineBasicMaterial({
        color: asHex(LEG_COLOR[leg.grade] ?? LEG_COLOR.near),
      })));
    }
    scene.add(missionGroup);
  }

  // Where each camera is pointed, as the pyramid it actually sees -- apex at
  // the aircraft, base a rectangle at the camera's real field of view. Which is
  // the picture you cannot get from the route alone: an orbit and a nadir grid
  // can fly the same circle and photograph completely different things, and
  // "inward", "outward" and "straight down" are properties of the camera and
  // not of the path.
  //
  // The same wedges js/view3d.js draws over its flat plane, and deliberately
  // the same numbers, so the two views agree about where the lens is looking:
  // yaw and pitch come resolved from the planner (js/planner.js sets w.yaw for
  // every heading mode, and w.shots is the pitch fan at the stop), the cone
  // comes from the camera in js/camera.js, and the direction comes from the
  // orientation() that the coverage scorer uses -- so a wedge drawn here and a
  // frame counted as covered can never disagree.
  //
  // One LineSegments per pass rather than per wedge: 200 waypoints with a fan
  // at each is thousands of lines, and thousands of draw calls is how an
  // on-demand renderer becomes a slideshow when you drag.
  function buildLooks(path, at) {
    if (!path.length) return;
    // ENU (x east, y north, z up) to three.js (x east, y up, z south).
    const dir = (o) => new THREE.Vector3(o.x, o.z, -o.y);

    // Readable rather than to scale, and the same rule view3d.js uses so a
    // wedge is the same size in both views: a tenth of the site, capped by the
    // height flown so a low pass cannot draw a cone through the ground.
    const box = new THREE.Box3();
    for (const w of path) box.expandByPoint(at(w));
    const size = box.getSize(new THREE.Vector3());
    const span = Math.max(size.x, size.z, 20);
    const len = Math.max(2, Math.min(span * 0.09, Math.max(box.max.y, 1) * 0.7));

    // Every waypoint is too many to see through, and this is a diagram of the
    // camera work rather than an inventory. Same thinning rule as view3d.
    const step = Math.max(1, Math.ceil(path.length / 70));
    const fv = fov(mission.cam);
    const th = Math.tan(fv.h / 2);
    const tv = Math.tan(fv.v / 2);
    const corners = [[1, 1], [1, -1], [-1, -1], [-1, 1]];

    const byPass = new Map();
    for (let i = 0; i < path.length; i += step) {
      const w = path[i];
      const apex = at(w);
      for (const pitch of w.shots?.length ? w.shots : [w.pitch ?? -90]) {
        const o = orientation(w.yaw ?? 0, pitch);
        const f = dir(o.forward);
        const r = dir(o.right);
        const u = dir(o.up);
        const far = corners.map(([sx, sy]) => apex.clone().add(
          f.clone().addScaledVector(r, sx * th).addScaledVector(u, sy * tv)
            .normalize().multiplyScalar(len)));
        if (!byPass.has(w.pass)) byPass.set(w.pass, []);
        const seg = byPass.get(w.pass);
        // Four rays out to the corners, and the rectangle they land on.
        for (let k = 0; k < 4; k++) {
          seg.push(apex, far[k]);
          seg.push(far[k], far[(k + 1) % 4]);
        }
      }
    }

    for (const [pass, pts] of byPass) {
      const g = new THREE.BufferGeometry().setFromPoints(pts);
      missionGroup.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({
        color: asHex(PASS_COLOR[pass] ?? PASS_FALLBACK),
        // Faint: they are context for the route, and there are a lot of them.
        transparent: true, opacity: 0.34,
      })));
    }
  }

  // The flight is the subject and the ground is what it is in, so the frame is
  // the flight's own extent with room around it -- not the surface's, which can
  // be bigger than the flight and off to one side of it when the crop runs into
  // the edge of a tile.
  //
  // Aimed at ground level under the middle of the flight rather than at the
  // flight's own middle, and set low: looking ACROSS a place is what shows a
  // tower standing beside your orbit. Looking down on it is a map.
  function frameCamera() {
    const path = mission?.exported ?? mission?.waypoints ?? [];
    if (!path.length || !surfaceMesh) return;
    const frame = mission.frame;
    const box = new THREE.Box3();
    for (const w of path) {
      const l = frame.toLocal(w.lat, w.lon);
      box.expandByPoint(new THREE.Vector3(l.x, w.alt, -l.y));
    }
    const centre = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    // Floored at 180 m, which is the fix for the thing that made this view
    // unreadable on a tight site: fitting a 30 m flight put the camera 40 m
    // out, and 40 m from the middle of a street of tenements is inside the
    // block, facing a wall, with no neighbourhood behind it. The flight is
    // still the subject; it just is not the whole picture.
    const span = Math.max(size.x, size.z, 180) * 1.35;
    const dist = (span / 2) / Math.tan((camera.fov * Math.PI) / 360);
    controls.target.set(centre.x, 0, centre.z);
    // 0.62 rad above the horizon, the angle the service's viewer opens at, so
    // the two pictures of the same ground start from the same place. Still low
    // enough that you are looking ACROSS the site -- which is what shows a
    // tower standing beside your orbit -- rather than down on a map of it.
    camera.position.set(centre.x, dist * Math.sin(0.62), centre.z + dist * Math.cos(0.62));
    // The one place update() belongs: the camera was moved from code, so the
    // controls have to be told before the next draw.
    controls.update();
  }

  async function loadFor(lat, lon, { signal } = {}) {
    boot();
    const here = await ask(`/v1/locate?lat=${lat}&lon=${lon}`, { signal });
    if (!here.ok) throw new Error('outside the survey');
    const { tile } = await here.json();
    if (loaded && loaded.tn === tile.tn && loaded.te === tile.te) return loaded;

    onStatus('Asking for the survey…');
    const metaRes = await poll(`/v1/scene/${tile.tn}/${tile.te}.json`, {
      signal,
      onWait: () => onStatus('First look at this ground — building it from the LiDAR. A few minutes.'),
    });
    const meta = await metaRes.json();
    if (meta.empty) throw new Error(meta.reason ?? 'no LiDAR here');

    onStatus('Downloading the surface…');
    const raw = await poll(`/v1/scene/${tile.tn}/${tile.te}`, { signal }).then((r) => r.arrayBuffer());
    const N = meta.grid;
    const next = {
      tn: tile.tn,
      te: tile.te,
      meta,
      base: meta.base,
      height: new Uint16Array(raw, 0, N * N),
      kind: new Uint8Array(raw, N * N * 2, N * N),
      ortho: null,
    };

    // The photograph, when the country has one here. It is the same orthophoto
    // the geometry was measured with and in the same projection, so it is a
    // straight drape -- no warping, unlike the third-party basemap the flat
    // view uses. Without it the surface is coloured by classification, which is
    // less pretty and no less true.
    if (!meta.ortho?.empty) {
      onStatus('Downloading the orthophoto…');
      try {
        const jpg = await ask(`/v1/scene/${tile.tn}/${tile.te}.jpg`, { signal });
        if (jpg.ok) {
          const bitmap = await createImageBitmap(await jpg.blob());
          const tex = new THREE.Texture(bitmap);
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.needsUpdate = true;
          next.ortho = tex;
        }
      } catch { /* colour by classification instead */ }
    }

    loaded = next;
    return loaded;
  }

  const api = {
    // The mission is pushed on every replan, like view3d's. Rebuilding the
    // flight is cheap; the surface is not, so it is only rebuilt when the frame
    // it is expressed in has actually moved.
    setMission(m, h) {
      const moved = !mission || !m
        || mission.frame.lat0 !== m.frame.lat0 || mission.frame.lon0 !== m.frame.lon0;
      mission = m;
      hazard = h;
      if (!renderer || !mission) return;
      // The view can be open before there is anything to look at -- picked
      // straight from the address bar, before a single point is tapped -- and
      // then it is the arrival of a flight that has to start the loading. Not
      // doing this left the survey blank for exactly that entry, which is the
      // one a shared link uses.
      if (!loaded) { api.open(); return; }
      if (moved) buildSurface(); else { buildMission(); render(); }
    },

    // The same list the map draws, so the two pictures cannot disagree about
    // where a wire is.
    setWires(paths) {
      wirePaths = paths ?? [];
      if (!renderer) return;
      buildWires();
      render();
    },

    // Whether to draw what each camera is pointed at.
    setLooks(on) {
      looksOn = !!on;
      if (!renderer || !mission) return;
      buildMission();
      render();
    },

    onStatus(fn) { onStatus = fn ?? (() => {}); },

    // Opening the view is what fetches three.js, the surface and the photo. The
    // first time over new ground that is minutes, and the status says so.
    async open() {
      boot();
      running = true;
      if (!mission) { onStatus('Tap out a site first — this draws the ground under a flight.'); return; }
      // setMission fires on every replan, and a replan lands on every slider
      // tick, so without this a slow first load would be started a hundred
      // times over.
      if (opening) return;
      opening = true;
      const c = mission.frame;
      inFlight?.abort?.();
      const ctl = new AbortController();
      inFlight = ctl;
      try {
        await loadFor(c.lat0, c.lon0, { signal: ctl.signal });
        buildSurface();
        onStatus(`${loaded.meta.sources?.[0]?.year ?? 'LiDAR'} survey, `
          + `${loaded.meta.cellMetres * loaded.step} m cells, `
          + `${(loaded.cells / 1000).toFixed(0)}k points, `
          + 'heights above your takeoff point.'
          + (loaded.clipped
            ? ' The site runs off the edge of this survey tile — what you see stops there.'
            : ''));
        render();
      } catch (e) {
        if (e.name !== 'AbortError') onStatus(`No surface — ${e.message}`);
      } finally {
        opening = false;
      }
    },

    // The same two calls js/view3d.js answers, so the app can sync whichever
    // 3D view is up without asking which. A place on the ground and how much
    // of it is in shot; the camera's height above the target is its own
    // business and is left alone.
    where() {
      if (!mission || !controls) return null;
      const t = controls.target;
      const g = mission.frame.toLatLon(t.x, -t.z);
      const dist = camera.position.distanceTo(t);
      return { lat: g.lat, lon: g.lon,
               spanM: Math.max(20, 2 * dist * Math.tan((camera.fov * Math.PI) / 360)) };
    },

    lookAt({ lat, lon, spanM }) {
      if (!mission || !controls) return;
      const l = mission.frame.toLocal(lat, lon);
      // Keep the direction the camera is already pointing from and only move
      // it: a sync that also reset the angle would throw away the view you had
      // spent time getting to.
      const offset = camera.position.clone().sub(controls.target);
      const want = (spanM / 2) / Math.tan((camera.fov * Math.PI) / 360);
      offset.setLength(Math.max(20, want));
      controls.target.set(l.x, 0, -l.y);
      camera.position.copy(controls.target).add(offset);
      controls.update();
      render();
    },

    close() { running = false; inFlight?.abort?.(); inFlight = null; },
    resize() { render(); },
    ready: () => Boolean(loaded),
  };
  return api;
}
