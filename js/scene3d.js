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

// How much ground round the flight, and how fine. The tile is 500 m of
// half-metre cells -- a million of them -- and a site is a couple of hundred
// metres, so cropping to the flight and its margin is both smaller and sharper
// than decimating the lot. The vertex cap is what keeps a big site from asking
// for ten million triangles: past it the step coarsens instead.
const MARGIN_M = 60;
const MAX_VERTS = 420_000;

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
    // Sun high and to the south for the shaping, and a hemisphere for the
    // fill: sky above, ground bounce below.
    //
    // The numbers are not taste. three.js lights a MeshStandardMaterial
    // physically, so a lit-up surface leaves as albedo * irradiance / PI --
    // meaning the old sun 1.6 plus flat ambient 0.85 showed flat ground at
    // (1.6 * 0.9 + 0.85) / PI = 0.7 of the orthophoto's real brightness, and
    // every steep face darker still. That is why it looked like dusk: an
    // orthophoto is a photograph taken in sunlight, so shading it again dims a
    // picture that already has the sun in it. These add to PI over flat
    // ground, so the photo is shown at the brightness it was taken at, and the
    // relief still reads because slopes fall off from there.
    const sun = new THREE.DirectionalLight(0xfff6e8, 1.5);
    sun.position.set(-0.45, 1, 0.55);
    // Sky and ground bounce rather than one flat number, so a north wall is
    // lit by something with a direction to it instead of going grey.
    scene.add(sun, new THREE.HemisphereLight(0xbcd8f2, 0x6f6455, 1.8));
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

    const index = [];
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const a = r * cols + c;
        index.push(a, a + cols, a + 1, a + 1, a + cols, a + cols + 1);
      }
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    geom.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geom.setAttribute('color', new THREE.BufferAttribute(colours, 3));
    geom.setIndex(index);
    geom.computeVertexNormals();

    if (surfaceMesh) { scene.remove(surfaceMesh); surfaceMesh.geometry.dispose(); }
    const material = new THREE.MeshStandardMaterial({
      map: loaded.ortho ?? null,
      vertexColors: !loaded.ortho,
      roughness: 0.95,
      metalness: 0,
    });
    surfaceMesh = new THREE.Mesh(geom, material);
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
    const span = Math.max(size.x, size.z, 60) * 1.35;
    const dist = (span / 2) / Math.tan((camera.fov * Math.PI) / 360);
    controls.target.set(centre.x, 0, centre.z);
    camera.position.set(centre.x, dist * 0.45, centre.z + dist * 0.9);
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
