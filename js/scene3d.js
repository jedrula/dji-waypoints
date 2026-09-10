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
import { toPuwg92, toWgs84 } from './puwg92.js';
import { tileRange, tileCount, tileBounds, mPerPx, TILE_PX } from './tiles.js';
import { groundAt, puwgToLocal, localToTile, drapeWire, stitch } from './surface.js';
import { toWgs84 as puwgToWgs84 } from './puwg92.js';
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
  let meshGroup = null;
  // Tile name -> Mesh, so a neighbour asked for twice is fetched once.
  const meshTiles = new Map();
  // The mesh is the picture wherever there is one, and the LiDAR heightfield is
  // the fallback where there is not -- which is most of the country. There is
  // no switch: coverage decides, and an option nobody can answer better than
  // the data can is not worth carrying.
  let meshMode = false;
  let wirePaths = [];
  let groundSpec = null;
  let looksOn = true;
  let surfaceMesh = null;
  let loaded = null;       // { tn, te, meta, height, kind, base }
  let mission = null;
  let hazard = null;
  let onStatus = () => {};
  let onMesh = () => {};
  let meshHazard = null;
  let framedMesh = false;
  let collisionMode = false;
  let onLevel = () => {};
  let onLevelDone = () => {};
  let onRadius = () => {};
  let chipBox = null;
  const chips = [];
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
    controls.addEventListener('change', () => { render(); scheduleRedrape(); });
    // The chips live over the canvas, and a drag on one is not an orbit.
    chipBox = document.createElement('div');
    chipBox.id = 'levelchips';
    canvas.parentElement?.append(chipBox);
    globalThis.addEventListener('pointermove', moveChip);
    globalThis.addEventListener('pointerup', endChip);
    globalThis.addEventListener('pointercancel', endChip);
    // Ring drags end wherever the pointer happens to be, which is regularly
    // outside the canvas -- the same reason the chip handlers are global.
    globalThis.addEventListener('pointermove', moveRing);
    globalThis.addEventListener('pointerup', endRing);
    globalThis.addEventListener('pointercancel', endRing);

    canvas.addEventListener('pointerdown', meshDown);
    canvas.addEventListener('pointermove', meshMove);
    canvas.addEventListener('click', meshClick);
    // No lights. The surface shades itself -- see surfaceMaterial() -- and
    // everything else in this scene is lines and points, which are unlit.
    //
    // A HemisphereLight used to be here and it is what made this view so much
    // worse than the service's own viewer on a dense street: its fill is keyed
    // to how far a normal points at the sky, so every facade collapsed towards
    // the ground-bounce colour, and in a city block seen from a low camera
    // almost everything you look at IS a facade.
  }

  // The one shading rule in this view, and the reason it is a string: the
  // surface and the buildings must be lit identically or a wall reads as a
  // different material from the roof it holds up, and they are different
  // shaders because one samples a photograph and the other has nothing to
  // sample. Straight from server/public/scene.html.
  const LAMBERT_GLSL = `
    // The viewer's SUN, in the same frame: x east, y up, z south.
    const vec3 SUN = normalize(vec3(0.45, 0.8, 0.35));
    float lambert(vec3 n) {
      return 0.42 + 0.58 * max(dot(normalize(n), SUN), 0.0);
    }`;

  // Re-drape at the scale you are actually looking at.
  //
  // This is what makes zooming in worth doing. The picture is a fixed number
  // of pixels over whatever patch it covers, so zooming into a whole-tile
  // drape just magnifies 24 cm pixels while the map beside it keeps fetching
  // sharper tiles. Settling the camera asks for the ground now in shot, at the
  // zoom the map itself would use for that scale.
  //
  // On settling, not on moving: composing is up to 160 tile fetches and a
  // 2048-square canvas, and doing that per frame of a drag would be absurd.
  let redrapeAt = 0;
  let redraping = false;

  function visibleBox() {
    if (!loaded?.meta || !camera || !controls) return null;
    const span = loaded.meta.tileMetres;
    // What the camera can see of the ground plane, as a square about the point
    // it is looking at. A square, and generous, because an oblique camera sees
    // a trapezoid running off towards the horizon and there is no point being
    // clever about a bound that only decides how much picture to fetch.
    const dist = camera.position.distanceTo(controls.target);
    const half = Math.max(30, dist * Math.tan((camera.fov * Math.PI) / 360) * 1.4);
    // controls.target is in the mission's local frame and the drape is in the
    // tile's, so it has to come back the other way. three.js z is south.
    if (!loaded.toTile) return null;
    const { e, n } = loaded.toTile(controls.target.x, -controls.target.z);
    const clamp = (v) => Math.max(0, Math.min(span, v));
    const box = {
      e0: clamp(e - half), n0: clamp(n - half),
      e1: clamp(e + half), n1: clamp(n + half),
    };
    if (box.e1 - box.e0 < 20 || box.n1 - box.n0 < 20) return null;
    return box;
  }

  function scheduleRedrape() {
    if (!loaded?.meta || !groundSpec?.url) return;
    const at = ++redrapeAt;
    setTimeout(async () => {
      if (at !== redrapeAt || redraping || !running) return;
      const box = visibleBox();
      if (!box) return;
      const have = loaded.orthoBox;
      // Only when it would actually be sharper, or when the patch has moved
      // off what is drawn. Otherwise every nudge of the mouse refetches the
      // same picture.
      const want = (box.e1 - box.e0) / 2048;
      const sharper = !loaded.orthoMpp || want < loaded.orthoMpp * 0.7;
      const outside = !have || box.e0 < have.e0 - 1 || box.e1 > have.e1 + 1
        || box.n0 < have.n0 - 1 || box.n1 > have.n1 + 1;
      if (!sharper && !outside) return;
      redraping = true;
      try {
        const got = await basemapTexture(loaded.meta, box);
        if (!got || at !== redrapeAt) return;
        loaded.ortho?.dispose?.();
        loaded.ortho = got.tex;
        loaded.orthoBox = got.box;
        loaded.orthoMpp = got.metresPerPixel;
        if (surfaceMesh) {
          surfaceMesh.material.uniforms.uOrtho.value = got.tex;
          surfaceMesh.material.uniforms.uHasOrtho.value = 1;
          surfaceMesh.material.uniforms.uPatch.value = patchUv();
        }
        render();
      } catch (e) { console.warn('re-drape failed:', e); } finally { redraping = false; }
    }, 350);
  }

  // Where the drape sits, as the tile-wide UV rect the shader needs.
  function patchUv() {
    const span = loaded?.meta?.tileMetres ?? 1;
    const b = loaded?.orthoBox;
    if (!b) return new THREE.Vector4(0, 0, 1, 1);
    return new THREE.Vector4(
      b.e0 / span, b.n0 / span,
      (b.e1 - b.e0) / span, (b.n1 - b.n0) / span,
    );
  }

  // The surface's own shader, which is the service viewer's fragment shader
  // ported: see server/public/scene.html. The two draw the same tile from the
  // same bytes and they should not disagree about what it looks like, so the
  // rules here are its rules and the constants here are its constants.
  //
  // Why not a stock material. Three of the four things this does are per
  // FRAGMENT -- how much of this face is vertical, was anything measured here,
  // and shade a photograph that already contains its own sunlight. A
  // MeshLambertMaterial can do the last one (ambient PI*0.42 plus a
  // directional PI*0.58 reproduces the expression below exactly), but the
  // other two need to blend inside a triangle, and the version of this that
  // tried to do it by splitting the mesh into two materials painted 40% of its
  // brown onto surfaces that were not walls at all.
  //
  // It also puts the lighting where you can read it. There are no lights in
  // this scene now: everything else drawn here is lines and points, which are
  // unlit, so the surface carrying its own one-line shading rule is the whole
  // of it.
  function surfaceMaterial() {
    return new THREE.ShaderMaterial({
      uniforms: {
        uOrtho: { value: loaded.ortho ?? null },
        uHasOrtho: { value: loaded.ortho ? 1 : 0 },
        // Which part of the tile the picture covers, in the tile's own 0..1
        // UV space: origin then size. The whole tile is (0,0,1,1); a patch
        // draped at a higher zoom is a smaller rect inside it.
        uPatch: { value: patchUv() },
      },
      vertexShader: `
        attribute vec3 color;
        attribute float aWall;
        attribute float aKind;
        varying vec2 vUv;
        varying vec3 vColor, vNormal2;
        varying float vWall, vKind;
        void main() {
          vUv = uv;
          vColor = color;
          vWall = aWall;
          vKind = aKind;
          vNormal2 = normalMatrix * normal;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform sampler2D uOrtho;
        uniform int uHasOrtho;
        uniform vec4 uPatch;
        varying vec2 vUv;
        varying vec3 vColor, vNormal2;
        varying float vWall, vKind;

        ${LAMBERT_GLSL}

        void main() {
          // No photo here means most of the country outside the towns, and
          // then the classification stands in -- one palette, KIND_COLOUR,
          // arriving as a vertex colour so it is not written twice.
          // The picture covers a patch of the tile, not always the whole of
          // it, so the tile-wide UV is mapped into the patch. Outside it the
          // clamp would smear the edge pixel across the rest of the ground, so
          // the classification colour stands in instead -- honest, and it is
          // ground you are not looking at.
          vec2 pUv = (vUv - uPatch.xy) / uPatch.zw;
          bool inPatch = pUv.x >= 0.0 && pUv.x <= 1.0 && pUv.y >= 0.0 && pUv.y <= 1.0;
          vec3 base = (uHasOrtho == 1 && inPatch) ? texture2D(uOrtho, pUv).rgb : vColor;

          // Cells nothing was measured in -- the river, mostly, and 38% of
          // this tile -- read as a flat sheet, and saying so is better than
          // pretending the photo is ground truth.
          if (vKind < 0.5) base = mix(base, vec3(0.26, 0.45, 0.63), 0.22);

          // A wall is a smear: the survey was flown looking straight down, so
          // a vertical face has no pixels of its own and whatever the photo
          // puts there is the roof edge stretched down the side. Paint it as
          // unknown rather than dressing it up.
          base = mix(base, vec3(0.54, 0.42, 0.29), vWall * 0.88);

          // A photograph taken in sunlight already has the sun in it, so this
          // only gives the relief an edge: never below 0.42 of the photo,
          // never above it.
          gl_FragColor = vec4(base * lambert(vNormal2), 1.0);
        }`,
    });
  }

  // One image, loaded. Basemap tiles do send CORS headers -- measured, see the
  // note in js/tiles.js -- and without asking for it the canvas would be
  // tainted and could not become a WebGL texture at all.
  const loadTile = (url) => new Promise((done) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => done(img);
    img.onerror = () => done(null);
    img.src = url;
  });

  // Does this zoom hold real imagery here?
  //
  // Worth asking rather than declaring. ArcGIS answers a request past its own
  // coverage with an enlargement of the deepest real tile rather than an error,
  // so asking too deep costs four times the tiles for a blur -- and `maxNative`
  // in js/basemap.js is one number for the whole world, which the truth is not.
  // Measured 2026-09-09 through this very endpoint: zoom 21 exists over
  // Wroclaw, Krakow and the Tatras, and does not exist over rural Mazowieckie.
  //
  // The first attempt at this compared a tile against its parent enlarged and
  // called the higher zoom real if it carried a quarter more high-frequency
  // detail. It does work on a textured roof -- zoom 20 over Cybulskiego scored
  // 1.8x -- and it fails on a car park, because smooth ground has little
  // detail to carry at any resolution. It rejected native tiles and cost the
  // picture more than it saved. A service that will simply tell you is better
  // than a heuristic about pixels.
  //
  // Measured through this endpoint 2026-09-09, which shows the declared number
  // was wrong in BOTH directions:
  //
  //     Wroclaw Cybulskiego   z20 held   z21 held   z22 held
  //     rural Mazowieckie     z20 held   z21 NOT held
  //
  // So 21 was costing detail in the city and buying enlargements in the
  // countryside. Nothing here clamps to maxNative any more; the zoom is what
  // the output needs, bounded by the tile budget and by what is actually held.
  //
  // Cached per service, zoom and neighbourhood, and the PROMISE is cached, so
  // a run of re-drapes over the same ground asks once. A probe that fails
  // answers yes: not knowing must not cost detail.
  const probes = new Map();
  function nativeAt(z, x, y) {
    if (!groundSpec?.tilemap) return Promise.resolve(true);
    const key = `${groundSpec.url(0, 0, 0)}|${z}|${x >> 3}|${y >> 3}`;
    if (probes.has(key)) return probes.get(key);
    const job = fetch(groundSpec.tilemap(z, x, y, 2, 2))
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => !Array.isArray(j?.data) || j.data.some(Boolean))
      .catch(() => true);
    probes.set(key, job);
    return job;
  }

  // The map's own imagery, reprojected onto the tile. The only source of
  // colour this view has.
  //
  // The basemap has a picture of everywhere, which the national orthophoto does
  // not -- that was the original complaint, a Krakow tile with no photo falling
  // back to flat classification colours and reading as a grey abstraction.
  //
  // It is a FALLBACK, but NOT for the reason first given. The worry was that a
  // third-party basemap is orthorectified against its own terrain model and
  // would slide against this geometry, putting a roof off its walls. Measured
  // instead, by cross-correlating the two pictures of tile 725/724 resampled to
  // 0.98 m and shifting one against the other:
  //
  //     offset 0.0 m   r = 0.984      <- the peak, at zero
  //            1.0 m   r = 0.906
  //            4.9 m   r = 0.649
  //           19.5 m   r = 0.285
  //
  // A sharp peak exactly at no shift, so over Poland these agree to under a
  // metre -- an r of 0.984 between two supposedly independent photographs is
  // itself the hint, since Esri licenses national orthophoto and this is very
  // likely the same picture GUGiK gave us.
  //
  // What keeps GUGiK first is resolution and honesty about resampling: its
  // photo is 24 cm per pixel in the projection the heights were measured in and
  // needs no transform at all, where this is 37 cm at zoom 18 and goes through
  // a reprojection. Where the country has a photo, that one wins.
  //
  // The reprojection is per source tile and affine. A basemap tile is
  // axis-aligned in Web Mercator; this canvas is axis-aligned in PUWG92; and
  // the two are not parallel -- grid north and true north differ by up to a
  // degree in Poland, which is 8 m of skew across 500 m, so blitting the tiles
  // square would visibly shear the picture. Over one tile the mapping is affine
  // to well under a pixel, so three corners give the transform and drawImage
  // does the rest. Same trick view3d.js uses per triangle, needed once per tile
  // here because the target is flat rather than a perspective camera.
  //
  // `box` is the patch of the tile to cover, in the tile's own metres, and it
  // is what makes this behave like a map rather than like a photograph. Draped
  // once over the whole 500 m tile the picture has a fixed 24 cm a pixel, so
  // zooming in magnifies it and nothing new arrives -- the map beside it keeps
  // getting sharper and this did not. Covering a smaller patch at a higher
  // zoom is how a map answers that, and it is the same answer here.
  async function basemapTexture(meta, box = null) {
    if (!groundSpec?.url) return null;
    const span = meta.tileMetres;
    const b = box ?? { e0: 0, n0: 0, e1: span, n1: span };
    const { east: E0, north: N0 } = meta.origin;
    // The patch, in lat/lon, for choosing a zoom and listing the tiles.
    const sw = toWgs84(E0 + b.e0, N0 + b.n0);
    const ne = toWgs84(E0 + b.e1, N0 + b.n1);
    const bbox = { south: sw.lat, west: sw.lon, north: ne.lat, east: ne.lon };

    // 2048 across the patch. Over a whole tile that is 24 cm a pixel -- what
    // the national orthophoto was, and finer than the half-metre height grid it
    // is draped on. Over a 100 m patch it is 5 cm. Declared here rather than
    // beside the canvas it sizes, because the zoom below is chosen FROM it: it
    // was below, and `const` in a temporal dead zone threw a ReferenceError
    // that both callers swallowed, so the drape silently never happened.
    const P = 2048;

    // Deep enough to fill the output and no deeper. tiles.js's pickZoom answers
    // a different question -- the most detail that fits a budget -- and using
    // it here fetched four times the tiles for pixels the canvas cannot hold.
    const target = (b.e1 - b.e0) / P;
    const midLat = (bbox.south + bbox.north) / 2;
    let z = 14;
    while (z < 23 && mPerPx(midLat, z) > target) z++;

    // Then within reach: a budget, because this is a burst of requests at a
    // public CDN, and then the probe, because asking for detail the service
    // does not hold costs four times the tiles for an enlargement.
    while (z > 14 && tileCount(tileRange(bbox, z)) > 160) z--;
    for (let guard = 0; guard < 6 && z > 14; guard++) {
      const at = tileRange(bbox, z);
      if (await nativeAt(z, at.x0, at.y0)) break;
      z--;
    }
    const r = tileRange(bbox, z);

    const c = document.createElement('canvas');
    c.width = P;
    c.height = P;
    const ctx = c.getContext('2d');
    // PUWG92 metres to canvas pixels, over the patch. Row 0 is the NORTH edge,
    // which is the convention the surface's own UVs already use.
    const px = (e, n) => ({
      x: ((e - (E0 + b.e0)) / (b.e1 - b.e0)) * P,
      y: (((N0 + b.n1) - n) / (b.n1 - b.n0)) * P,
    });

    const jobs = [];
    for (let ty = r.y0; ty <= r.y1; ty++) {
      for (let tx = r.x0; tx <= r.x1; tx++) jobs.push({ tx, ty });
    }
    const imgs = await Promise.all(jobs.map((j) => loadTile(groundSpec.url(z, j.tx, j.ty))));

    let drawn = 0;
    for (let i = 0; i < jobs.length; i++) {
      const img = imgs[i];
      if (!img) continue;
      const b = tileBounds(z, jobs[i].tx, jobs[i].ty);
      const corner = (lat, lon) => {
        const g = toPuwg92(lat, lon);
        return px(g.east, g.north);
      };
      // The tile's top-left, top-right and bottom-left, in canvas pixels.
      const p0 = corner(b.north, b.west);
      const p1 = corner(b.north, b.east);
      const p2 = corner(b.south, b.west);
      ctx.setTransform(
        (p1.x - p0.x) / TILE_PX, (p1.y - p0.y) / TILE_PX,
        (p2.x - p0.x) / TILE_PX, (p2.y - p0.y) / TILE_PX,
        p0.x, p0.y,
      );
      // Half a source pixel of overlap, or the seams between tiles show as a
      // grid of hairlines where two affines disagree by a rounding.
      ctx.drawImage(img, -0.5, -0.5, TILE_PX + 1, TILE_PX + 1);
      drawn++;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (!drawn) return null;

    const tex = new THREE.CanvasTexture(c);
    // Written straight out by our shader with no encode, so no decode on the
    // way in either.
    tex.colorSpace = THREE.NoColorSpace;
    // The patch does not tile: sampling past its edge must not wrap round to
    // the far side of the picture.
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    // The rect goes with the texture, because the shader has to know which
    // part of the tile these pixels are of.
    return { tex, box: b, zoom: z, metresPerPixel: (b.e1 - b.e0) / P };
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
    placeLevelChips();
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
    //
    // A smoothstep and not a yes/no, and this is the whole reason the surface
    // is drawn by a shader of ours instead of a stock three.js material. The
    // first attempt split the mesh into a photographed group and a brown group
    // and put a quad in the brown one if ANY of its corners was a wall. That
    // painted big horizontal slabs of roof and of hole-filled apron, which is
    // what made the picture worse rather than better -- measured over
    // Cybulskiego 22, tile 725/724: of 19,333 quads it marked, 40% had less
    // than the 1.75 m of vertical extent that defines a wall, and 16.7% were
    // under 0.25 m, which is flat. A per-quad material split cannot do better
    // than that, because "how much of this face is vertical" is a question
    // about a fragment and not about a quad.
    // Known walls when the footprints arrived, the step heuristic only when
    // they did not -- the same degrade-to-yesterday rule as everywhere else,
    // so a tile outside the building coverage, or a service that has not been
    // redeployed, still gets the marking it always had.
    const known = wallMask();
    const wallAt = (row, col) => {
      if (known) return known[row * N + col] ? 1 : 0;
      if (kind[row * N + col] !== KIND_BUILDING) return 0;
      const l = heightAt(row, Math.max(col - 1, 0));
      const r = heightAt(row, Math.min(col + 1, N - 1));
      const u = heightAt(Math.max(row - 1, 0), col);
      const d = heightAt(Math.min(row + 1, N - 1), col);
      // Full-resolution neighbours whatever the decimation, because the step is
      // a property of the ground and not of how coarsely we chose to draw it.
      const drop = Math.max(Math.abs(r - l), Math.abs(d - u)) * 0.5;
      // smoothstep(cut * 0.6, cut, drop), the viewer's own ramp.
      const t = Math.min(Math.max((drop - WALL_STEP_M * 0.6) / (WALL_STEP_M * 0.4), 0), 1);
      return t * t * (3 - 2 * t);
    };
    const wall = new Float32Array(cols * rows);
    const kinds = new Float32Array(cols * rows);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const row = r0 + r * step;
        const col = c0 + c * step;
        wall[r * cols + c] = wallAt(row, col);
        kinds[r * cols + c] = kind[row * N + col];
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
    geom.setAttribute('aWall', new THREE.BufferAttribute(wall, 1));
    geom.setAttribute('aKind', new THREE.BufferAttribute(kinds, 1));
    geom.setIndex(index);
    geom.computeVertexNormals();

    if (surfaceMesh) { scene.remove(surfaceMesh); surfaceMesh.geometry.dispose(); }
    surfaceMesh = new THREE.Mesh(geom, surfaceMaterial());
    scene.add(surfaceMesh);

    // Does the surface still stop short of the flight? It used to, always, at
    // the edge of the one 500 m tile -- the raster is stitched from every tile
    // the flight crosses now, so this is left to catch the two cases that can
    // still bite: the MAX_SIDE_M cap on a very large site, and a tile the
    // service could not build.
    const wantC0 = Math.floor((eMin - MARGIN_M - e0) / cell);
    const wantC1 = Math.ceil((eMax + MARGIN_M - e0) / cell);
    const wantR0 = Math.floor((n0 + meta.tileMetres - (nMax + MARGIN_M)) / cell);
    const wantR1 = Math.ceil((n0 + meta.tileMetres - (nMin - MARGIN_M)) / cell);
    loaded.clipped = wantC0 < 0 || wantR0 < 0 || wantC1 > N - 1 || wantR1 > N - 1;
    // Ground that is simply not surveyed here yet, as opposed to ground this
    // view declined to commission -- see loadFor. The first is worth saying;
    // the second is the normal state of the neighbourhood.
    loaded.missing = (meta.wanted ?? 1) - (meta.tiles?.length ?? 1) - (meta.unbuilt ?? 0);

    loaded.datum = datum;
    // The inverse of toLocal, for turning where the camera is looking back
    // into a patch of the tile -- see visibleBox.
    loaded.toTile = localToTile(frame, e0, n0);
    // The crop, so the buildings are clipped to the ground that was actually
    // drawn. Without this they arrive for the whole 500 m tile and the ones
    // past the edge of the crop hang in the sky with nothing under them.
    loaded.crop = { c0, c1, r0, r1 };
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
  // The footprints, rasterised to the cells their walls pass through.
  //
  // This is what the buildings are FOR in this view, and drawing them as
  // solids was the wrong idea. They were drawn, briefly: a prism per building,
  // walls to the eaves. Almost every one was invisible, because a BDOT10k
  // footprint sits INSIDE the roof outline the raster measured -- a roof
  // overhangs and a half-metre grid smears it further out -- so the prism hid
  // inside the plateau. The ones that did show were the ones past the crop,
  // hanging in the sky. Raising them to the measured maximum only fenced each
  // roof off and hid the photograph. A second brown building on top of a good
  // photographic one is clutter whichever way it is drawn.
  //
  // What a footprint is good for is telling the surface the truth about its
  // own cliffs. The step heuristic guesses which cells are vertical faces and
  // is measurably bad at it: of the 19,333 quads it marked over tile 725/724,
  // 40% had less than the 1.75 m that defines a wall and 16.7% were flat,
  // because a parapet, a chimney and a tree beside a building all fire it. A
  // footprint edge does not guess. So this adds no geometry at all -- the same
  // one surface, told where the walls actually are.
  function wallMask() {
    const list = loaded?.buildings;
    if (!list?.length || !loaded?.meta) return null;
    const { meta } = loaded;
    const N = meta.grid;
    const cell = meta.cellMetres;
    const mask = new Uint8Array(N * N);
    const mark = (e, n) => {
      const col = Math.floor(e / cell);
      const row = Math.floor((meta.tileMetres - n) / cell);
      if (col < 0 || col >= N || row < 0 || row >= N) return;
      mask[row * N + col] = 1;
    };
    // Walked at half a cell, so no cell along a diagonal edge is stepped over.
    const STRIDE = cell / 2;
    for (const b of list) {
      const ring = b.ring;
      for (let i = 0; i < ring.length; i++) {
        const [ea, na] = ring[i];
        const [eb, nb] = ring[(i + 1) % ring.length];
        const steps = Math.max(1, Math.ceil(Math.hypot(eb - ea, nb - na) / STRIDE));
        for (let k = 0; k <= steps; k++) {
          mark(ea + ((eb - ea) * k) / steps, na + ((nb - na) * k) / steps);
        }
      }
    }
    return mask;
  }

  // The photogrammetric mesh: real walls, with the pixels the oblique cameras
  // actually saw on them. A PROTOTYPE, behind `?mesh=1`.
  //
  // One tile is 100 m of ground and 7.3 MB on the wire, ~638 MB per square
  // kilometre at source -- the heaviest thing this app can ask for -- so tiles
  // arrive ONE AT A TIME and only when asked for. Click the ground where you
  // want more; see meshClick.
  //
  // In this mode the LiDAR surface is not loaded at all. It used to be: the
  // view built the whole stitched heightfield, drew it, and then hid it the
  // moment the mesh arrived, which meant waiting through minutes of the worse
  // picture to get the better one and fetching hundreds of megabytes to throw
  // away.
  //
  // See server/src/mesh.js. Vertices arrive in PUWG92 metres from an origin the
  // request chose -- the mission's own frame origin -- so the conversion left
  // here is the affine the surface uses: PUWG92 grid north is not true north,
  // and over 100 m the convergence is about 1.7 m of sideways error.
  async function loadMeshTile(lat, lon, { signal } = {}) {
    const { lat0, lon0 } = mission.frame;
    const res = await ask(`/v1/mesh?lat=${lat}&lon=${lon}`, { signal });
    if (!res.ok) return { ok: false, why: 'no mesh model covers that' };
    const name = (res.headers.get('X-Mesh-Tile') ?? `${lat.toFixed(5)},${lon.toFixed(5)}`);
    if (meshTiles.has(name)) return { ok: true, already: true, name };
    const raw = await res.arrayBuffer();

    const head = new Uint32Array(raw, 0, 2);
    const nv = head[0];
    const nt = head[1];
    let at = 8;
    const position = new Float32Array(raw.slice(at, at + nv * 12));
    at += nv * 12;
    const uv = new Float32Array(raw.slice(at, at + nv * 8));
    at += nv * 8;
    const index = new Uint32Array(raw.slice(at, at + nt * 3 * 4));

    // The offsets are from the tile's OWN request point, so they are shifted to
    // the mission frame's origin before projecting -- otherwise every neighbour
    // would stack on top of the first.
    const here = toPuwg92(lat, lon);
    const home = toPuwg92(lat0, lon0);
    const toLocal = puwgToLocal(mission.frame, home.east, home.north);
    const datum = meshDatum(position, nv);
    for (let i = 0; i < nv; i++) {
      const e = here.east + position[i * 3];
      const n = here.north - position[i * 3 + 2];        // z is south
      const l = toLocal(e, n);
      position[i * 3] = l.x;
      position[i * 3 + 1] -= datum;                      // metres above takeoff
      position[i * 3 + 2] = -l.y;
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(position, 3));
    geom.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geom.setIndex(new THREE.BufferAttribute(index, 1));

    const tex = await ask(`/v1/mesh.jpg?lat=${lat}&lon=${lon}`, { signal })
      .then((r) => (r.ok ? r.blob() : null))
      // FLIPPED HERE, not on the texture. Texture.flipY is IGNORED for an
      // ImageBitmap -- three.js can only flip a source it uploads itself -- so
      // setting it did nothing, twice, and the mesh came up with black patches
      // where faces sampled the mirrored position of a chart. OBJ counts v from
      // the bottom and the JPEG decodes from the top; this is the only place
      // the two conventions can meet.
      .then((b) => (b ? createImageBitmap(b, { imageOrientation: 'flipY' }) : null))
      .catch(() => null);
    let map = null;
    if (tex) {
      map = new THREE.Texture(tex);
      map.colorSpace = THREE.NoColorSpace;
      // The atlas is 8192 x 4096 over 100 m -- about 2 cm of ground per pixel
      // -- and without this the ground reads as a smear at any oblique angle,
      // which is every angle you look from.
      map.anisotropy = renderer.capabilities.getMaxAnisotropy();
      map.needsUpdate = true;
    }

    const tile = new THREE.Mesh(geom, new THREE.ShaderMaterial({
      uniforms: { uMap: { value: map }, uHas: { value: map ? 1 : 0 } },
      side: THREE.DoubleSide,
      // The normal comes from the DERIVATIVES of the view-space position, not
      // from computeVertexNormals: a photogrammetric mesh is full of zero-area
      // triangles and one of those normalises to NaN, which poisons the shading
      // term however high its floor. A fragment always has a derivative.
      vertexShader: `
        varying vec2 vUv;
        varying vec3 vPos;
        void main() {
          vUv = uv;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vPos = mv.xyz;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform sampler2D uMap;
        uniform int uHas;
        varying vec2 vUv;
        varying vec3 vPos;
        ${LAMBERT_GLSL}
        void main() {
          vec3 n = normalize(cross(dFdx(vPos), dFdy(vPos)));
          vec3 base = uHas == 1 ? texture2D(uMap, vUv).rgb : vec3(0.72, 0.70, 0.66);
          gl_FragColor = vec4(base * lambert(gl_FrontFacing ? n : -n), 1.0);
        }`,
    }));
    meshGroup ??= new THREE.Group();
    if (!meshGroup.parent) scene.add(meshGroup);
    meshGroup.add(tile);
    meshTiles.set(name, tile);
    // Rebuilt here because this is where the set of tiles changes, and both
    // the wires and the flight check read it.
    buildHeights();
    return { ok: true, name, triangles: nt, bytes: raw.byteLength };
  }

  // Where the ground is under the takeoff point, from the mesh itself.
  //
  // Without the LiDAR there is nothing else to measure it against, and the mesh
  // has it: the lowest vertex within ten metres of the request point is the
  // ground the aircraft leaves from. Ten metres because a footpath beside the
  // house is ground and the roof twelve metres away is not; the lowest of a
  // small neighbourhood is the floor, not a chimney.
  function meshDatum(position, nv) {
    let lowest = Infinity;
    for (let i = 0; i < nv; i++) {
      const x = position[i * 3];
      const z = position[i * 3 + 2];
      if (x * x + z * z > 100) continue;
      if (position[i * 3 + 1] < lowest) lowest = position[i * 3 + 1];
    }
    // Nothing within ten metres -- a tile fetched for a neighbour, not for the
    // takeoff point -- so fall back to the lowest thing in it.
    if (!Number.isFinite(lowest)) {
      for (let i = 0; i < nv; i++) if (position[i * 3 + 1] < lowest) lowest = position[i * 3 + 1];
    }
    return Number.isFinite(lowest) ? lowest : 0;
  }

  // A plate on the ground where a tile is missing, because "click the ground to
  // fetch more" in a status line is not an affordance -- it was there, and it
  // was missed. A square you can see and click is.
  //
  // These also make the click exact. Ray-testing against real objects says
  // which tile you meant; an earlier version intersected an infinite plane at
  // the datum, which on a slope answers with the wrong square.
  let padGroup = null;
  const PAD = 100;                       // a mesh tile is 100 m of ground

  function buildPads() {
    if (padGroup) { scene.remove(padGroup); padGroup = null; }
    if (!meshMode || !meshTiles.size || !mission) return;
    const { lat0, lon0 } = mission.frame;
    const home = toPuwg92(lat0, lon0);
    const toLocal = puwgToLocal(mission.frame, home.east, home.north);
    const back = localToTile(mission.frame, home.east, home.north);

    // Where each loaded tile sits, in PUWG metres from home, snapped to the
    // 100 m grid the tiles come on.
    const cell = (e, n) => `${Math.round(e / PAD)},${Math.round(n / PAD)}`;
    const taken = new Set();
    const centres = [];
    for (const tile of meshTiles.values()) {
      tile.geometry.computeBoundingBox();
      const b = tile.geometry.boundingBox;
      const c = back((b.min.x + b.max.x) / 2, -(b.min.z + b.max.z) / 2);
      taken.add(cell(c.e, c.n));
      centres.push(c);
    }

    padGroup = new THREE.Group();
    const seen = new Set();
    for (const c of centres) {
      for (const [de, dn] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const e = c.e + de * PAD;
        const n = c.n + dn * PAD;
        const key = cell(e, n);
        if (taken.has(key) || seen.has(key)) continue;
        seen.add(key);
        const p = toLocal(home.east + e, home.north + n);
        // Slightly under the datum so it never fights the mesh for a pixel.
        const pad = new THREE.Mesh(
          new THREE.PlaneGeometry(PAD - 4, PAD - 4),
          new THREE.MeshBasicMaterial({
            color: 0x7ec8ff, transparent: true, opacity: 0.16,
            side: THREE.DoubleSide, depthWrite: false,
          }),
        );
        pad.rotation.x = -Math.PI / 2;
        pad.position.set(p.x, -0.2, -p.y);
        pad.userData.at = { e, n };
        padGroup.add(pad);

        const edge = new THREE.LineSegments(
          new THREE.EdgesGeometry(new THREE.PlaneGeometry(PAD - 4, PAD - 4)),
          new THREE.LineBasicMaterial({ color: 0x9fd8ff, transparent: true, opacity: 0.55 }),
        );
        edge.rotation.x = -Math.PI / 2;
        edge.position.copy(pad.position);
        padGroup.add(edge);
      }
    }
    scene.add(padGroup);
  }

  // Does the flight clear the mesh?
  //
  // This is the point of having real geometry: not "is it above the tallest
  // measured cell", which the raster already answered, but "does this line pass
  // through that building". Two questions, two kinds of ray.
  //
  // DOWN from each waypoint says how much air is under it -- catching a pass
  // too low over a roof, which is the common mistake.
  //
  // ALONG each leg says whether the aircraft flies INTO something between one
  // waypoint and the next. A heightfield cannot answer that at all: a wall is
  // between two of its cells, so a leg threading a gap and a leg going through
  // a facade look identical to it.
  //
  // Geometry only. What counts as too close is a clearance the user chose, and
  // that belongs to the readout in js/app.js, not here.
  function checkMesh() {
    if (!meshMode || !meshGroup?.children.length || !mission) return null;
    const path = mission.exported ?? mission.waypoints ?? [];
    if (!path.length) return null;
    const t0 = performance.now();
    const frame = mission.frame;
    const at = (w) => {
      const l = frame.toLocal(w.lat, w.lon);
      return new THREE.Vector3(l.x, w.alt, -l.y);
    };

    const legs = [];
    // Every leg's verdict, not only the bad ones: collision mode paints the
    // clear ones green, and "clear" and "never checked" are different answers.
    const verdict = new Uint8Array(path.length);
    let tallest = -Infinity;      // the highest thing under any waypoint
    let lowestGap = Infinity;     // the least air under any waypoint
    let over = 0;                 // waypoints with mesh under them at all
    let hits = 0;                 // legs that fly into something

    const pts = path.map(at);
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const g = groundUnder(p.x, p.z);
      if (g !== null) {
        over++;
        if (g > tallest) tallest = g;
        if (p.y - g < lowestGap) lowestGap = p.y - g;
      }
      if (i === 0) continue;
      // Walked in half-metre steps along the leg, comparing its height at each
      // step against the tallest thing in that square metre. Stepping rather
      // than ray-tracing is what makes this fast, and half a metre is finer
      // than the grid it reads, so no cell is stepped over.
      const a = pts[i - 1];
      const dx = p.x - a.x;
      const dy = p.y - a.y;
      const dz = p.z - a.z;
      const len = Math.hypot(dx, dz);
      const steps = Math.max(1, Math.ceil(len / (HCELL / 2)));
      let through = false;
      let anyGround = false;
      for (let k = 0; k <= steps && !through; k++) {
        const f = k / steps;
        const g2 = groundUnder(a.x + dx * f, a.z + dz * f);
        if (g2 === null) continue;
        anyGround = true;
        if (a.y + dy * f < g2) through = true;
      }
      // 1 hits, 2 clear, 0 not judged -- and a leg with no mesh anywhere under
      // it is NOT clear, it is unjudged. This said `through ? 1 : 2` for one
      // afternoon and collision mode painted the whole flight green over a
      // site with a single tile fetched, which is the exact failure this
      // repo's rule about never claiming a number it does not have is about.
      verdict[i] = through ? 1 : (anyGround ? 2 : 0);
      if (through) {
        hits++;
        legs.push({ a: path[i - 1], b: path[i], grade: 'strike' });
      }
    }

    return {
      tiles: meshTiles.size,
      over,
      of: pts.length,
      tallest: Number.isFinite(tallest) ? +tallest.toFixed(1) : null,
      gap: Number.isFinite(lowestGap) ? +lowestGap.toFixed(1) : null,
      hits,
      legs,
      verdict,
      ms: Math.round(performance.now() - t0),
      gridMs: heights?.ms ?? null,
    };
  }

  // The check, plus the legs it flagged drawn over the flight in the collision
  // colours the map and the flat view already use for a strike.
  function reportMesh() {
    const found = checkMesh();
    meshHazard = found;
    buildMission();
    buildLevelChips();
    onMesh(found);
  }

  // The lowest each orbit ring can fly and still clear what the mesh measured.
  //
  // This is the shape of the thing worth having: tight, not high. Raising the
  // altitude lifts everything and throws away the close work; this lifts each
  // ring by exactly what that ring needs, so a ring in a courtyard clears the
  // courtyard and a ring outside it stays where it was.
  //
  // Per ring rather than per flight because that is where the problem lives.
  // The ground under a ring is the roofline it circles, and the rings differ:
  // over Cybulskiego the lowest sat at 6.3 m under 24 m of building while the
  // top one was already clear.
  //
  // One pass, deliberately. Lifting a ring makes the dome pull in, so the
  // waypoints move and the answer shifts slightly -- and the collision check
  // runs again straight after and says whether it is clear. Iterating to a
  // fixed point would be a solver where a number and a re-check will do.
  //
  // Waypoints over ground no tile covers are skipped, not assumed clear. A
  // ring only partly seen is lifted by what can be seen of it, and the readout
  // says how much was not.
  function fitRings(clearanceM) {
    if (!meshMode || !heights || !mission) return null;
    const rings = mission.heights?.orbit;
    if (!rings?.length) return null;
    const path = mission.exported ?? mission.waypoints ?? [];
    const frame = mission.frame;

    const needed = rings.map(() => -Infinity);
    let judged = 0;
    let skipped = 0;
    for (const w of path) {
      if (w.pass !== 'orbit') continue;
      // Which ring this waypoint belongs to: the one whose height it flies.
      let ri = -1;
      for (let i = 0; i < rings.length; i++) {
        if (Math.abs(rings[i] - w.alt) < 0.05) { ri = i; break; }
      }
      if (ri < 0) continue;
      const l = frame.toLocal(w.lat, w.lon);
      const g = groundUnder(l.x, -l.y);
      if (g === null) { skipped++; continue; }
      judged++;
      if (g + clearanceM > needed[ri]) needed[ri] = g + clearanceM;
    }
    if (!judged) return null;

    // Never lower than it flies now: this only ever lifts. A ring the mesh
    // says is already clear is left exactly where you put it.
    const to = rings.map((h, i) => (Number.isFinite(needed[i])
      ? Math.round(Math.max(h, needed[i]) * 10) / 10
      : h));
    return { rings, to, judged, skipped, changed: to.some((z, i) => z > rings[i] + 0.05) };
  }

  const sayMesh = () => onStatus(
    `Photogrammetric mesh, ${meshTiles.size} tile${meshTiles.size === 1 ? '' : 's'} `
    + 'of 100 m, 0.09 m in position. '
    + 'Click a blue square to load that ground — about 7 MB each.',
  );

  // Click bare ground to fetch the tile under it.
  //
  // One tile is 7.3 MB and covers 100 m, so they cannot all arrive at once and
  // guessing which neighbours somebody wants would fetch eight to be useful.
  // Pointing at the ground is the smallest way to say which.
  //
  // The click lands on the horizontal plane through the takeoff point rather
  // than on any geometry -- the whole point is to click where there IS no
  // geometry -- so it is a ray against y = 0, which is flat ground at the
  // datum. On a hill that is out by the slope over the distance clicked, and
  // it only has to land in the right 100 m square.
  let dragged = false;
  function meshDown(ev) {
    dragged = false;
    // A ring under the pointer takes the press; anything else is an orbit of
    // the camera, or a click on a pad, exactly as before.
    if (startRing(ev)) dragged = true;
  }
  function meshMove(ev) {
    if (ev.buttons) { dragged = true; return; }
    // Hovering says what a press would do, because a grip you cannot see is a
    // grip nobody finds. One projection per station per move: measured 0.28 ms
    // a move over a 104-station flight in Chrome, against a 16 ms frame. The
    // drag itself is the expensive half -- a move replans, and a replan with
    // the mesh loaded measured 48-93 ms -- and that is the cost of drawing the
    // real flight while you drag rather than a preview of one.
    canvas.style.cursor = ringUnder(ev) ? (ev.shiftKey ? 'nwse-resize' : 'ns-resize') : '';
  }
  async function meshClick(ev) {
    // A drag is how you orbit, so only a press that never moved counts. The
    // native click event decides what a click IS -- an earlier version compared
    // pointerdown and pointerup coordinates by hand and silently rejected every
    // one of them, which cost an evening.
    if (dragged || !meshMode || !mission || !camera || !padGroup) return;
    try {
      const rect = canvas.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((ev.clientX - rect.left) / rect.width) * 2 - 1,
        -((ev.clientY - rect.top) / rect.height) * 2 + 1,
      );
      const ray = new THREE.Raycaster();
      ray.setFromCamera(ndc, camera);
      // Against the pads themselves, so the answer is which SQUARE you meant.
      // Intersecting an infinite plane at the datum was the earlier way and it
      // picks the wrong square on any slope.
      const hits = ray.intersectObjects(padGroup.children, false);
      const pad = hits.find((h) => h.object.userData.at);
      if (!pad) return;

      const { lat0, lon0 } = mission.frame;
      const home = toPuwg92(lat0, lon0);
      const { e, n } = pad.object.userData.at;
      const g = puwgToWgs84(home.east + e, home.north + n);

      onStatus('Fetching that tile — about 7 MB…');
      const got = await loadMeshTile(g.lat, g.lon);
      if (!got.ok) {
        onStatus(`Nothing there — ${got.why}.`);
        // Take the plate away: there is no tile to fetch and offering it again
        // is a promise the data cannot keep.
        pad.object.userData.at = null;
        pad.object.material.color.set(0x6b7480);
        pad.object.material.opacity = 0.08;
        render();
        return;
      }
      buildPads();
      // A wire vertex over ground that was not loaded is dropped, so new ground
      // means the run can reach further than it did.
      buildWires();
      // And new ground can hold a conflict the flight did not know about.
      reportMesh();
      render();
      sayMesh();
    } catch (err) {
      onStatus(`That tile would not load — ${err.message}`);
    }
  }

  // The tallest thing in each square metre of the mesh.
  //
  // Everything that asks the mesh a question -- how high is the ground under
  // this wire, does this leg clear that roof -- was asking it with a raycast,
  // and three.js tests every triangle because nothing here builds a bounding
  // hierarchy. Measured: the flight check took **20.5 seconds** for 223 rays
  // against 417k triangles. So the questions are answered off a grid built once
  // per set of tiles instead, which is one pass over the triangles.
  //
  // The MAXIMUM in each cell, which makes every answer conservative: a leg is
  // flagged against the tallest thing in the metre it crosses, so the error is
  // always towards saying something is in the way. That is the direction this
  // app is allowed to be wrong in.
  //
  // It does cost the one thing true 3D gave us -- you cannot fly under an arch
  // in a max-height grid -- and that is the trade, taken deliberately. The
  // walls still do the work that matters: a cell holding a facade is as tall as
  // its roof, so a leg at six metres crossing it is caught, which is exactly
  // what a heightfield could never see.
  let heights = null;                      // { x0, z0, nx, nz, cell, max: Float32Array }
  const HCELL = 1;

  function buildHeights() {
    heights = null;
    if (!meshGroup?.children.length) return;
    const t0 = performance.now();
    const box = new THREE.Box3();
    for (const t of meshGroup.children) {
      t.geometry.computeBoundingBox();
      box.union(t.geometry.boundingBox);
    }
    const x0 = Math.floor(box.min.x) - 1;
    const z0 = Math.floor(box.min.z) - 1;
    const nx = Math.ceil(box.max.x - x0) + 2;
    const nz = Math.ceil(box.max.z - z0) + 2;
    const max = new Float32Array(nx * nz).fill(-Infinity);

    for (const t of meshGroup.children) {
      const pos = t.geometry.getAttribute('position').array;
      const idx = t.geometry.getIndex().array;
      for (let i = 0; i < idx.length; i += 3) {
        // One triangle: write its highest corner into every cell its footprint
        // touches. Corner rather than interpolated, again because high is safe.
        let xa = Infinity; let xb = -Infinity; let za = Infinity; let zb = -Infinity; let top = -Infinity;
        for (let k = 0; k < 3; k++) {
          const o = idx[i + k] * 3;
          const x = pos[o];
          const y = pos[o + 1];
          const z = pos[o + 2];
          if (x < xa) xa = x;
          if (x > xb) xb = x;
          if (z < za) za = z;
          if (z > zb) zb = z;
          if (y > top) top = y;
        }
        const ca = Math.max(Math.floor(xa - x0), 0);
        const cb = Math.min(Math.ceil(xb - x0), nx - 1);
        const ra = Math.max(Math.floor(za - z0), 0);
        const rb = Math.min(Math.ceil(zb - z0), nz - 1);
        for (let r = ra; r <= rb; r++) {
          for (let c = ca; c <= cb; c++) {
            const at = r * nx + c;
            if (top > max[at]) max[at] = top;
          }
        }
      }
    }
    heights = { x0, z0, nx, nz, cell: HCELL, max, ms: Math.round(performance.now() - t0) };
  }

  // The tallest thing under a point, or null where no tile has been fetched.
  // The caller drops the point rather than guessing, the same rule drapeWire
  // uses off the edge of a tile: a wire drawn at an invented height is worse
  // than a wire that stops.
  const groundUnder = (x, z) => {
    if (!heights) return null;
    const c = Math.floor(x - heights.x0);
    const r = Math.floor(z - heights.z0);
    if (c < 0 || c >= heights.nx || r < 0 || r >= heights.nz) return null;
    const v = heights.max[r * heights.nx + c];
    return Number.isFinite(v) ? v : null;
  };

  // Every height the flight uses, as a chip you can drag.
  //
  // This is the flat view's own gesture brought here, deliberately unchanged:
  // the same chips down the left edge, the same grip, the same drag. The flat
  // view had it and the mesh view -- the one that can actually tell you a ring
  // is inside a building -- had nothing, so adjusting meant one view and
  // checking meant the other.
  //
  // HTML over the canvas rather than geometry in it. A ring is a thin thing to
  // hit and it can be behind a building; a chip is always reachable, always
  // legible, and the browser does the hit-testing. `mission.levels` already
  // tags every height with the knob that owns it -- altitude, orbit or transect
  // -- which is what makes a drag land back on the right one.
  function buildLevelChips() {
    for (const c of chips) c.el.remove();
    chips.length = 0;
    if (!chipBox || !mission) return;
    const levels = mission.levels ?? [];
    if (!levels.length) return;

    // Owners grouped by height: several passes can share one, and dragging it
    // must move all of them or the flight would tear apart.
    const byZ = new Map();
    for (const lv of levels) {
      const key = Math.round(lv.z * 10) / 10;
      if (!byZ.has(key)) byZ.set(key, []);
      byZ.get(key).push(lv);
    }
    // What flies at each height, so a chip says what it is and not just a
    // number.
    const passesAt = new Map();
    for (const w of mission.exported ?? mission.waypoints ?? []) {
      const key = Math.round(w.alt * 10) / 10;
      if (!passesAt.has(key)) passesAt.set(key, new Set());
      passesAt.get(key).add(w.pass);
    }

    for (const [z, handles] of [...byZ].sort((a, b) => b[0] - a[0])) {
      const el = document.createElement('div');
      el.className = 'levelchip';
      const near = [...passesAt.keys()].reduce((best, k) => (Math.abs(k - z) < Math.abs(best - z) ? k : best), z);
      const what = [...(passesAt.get(near) ?? [])].join(' + ') || handles[0].kind;
      el.innerHTML = `<b></b><span></span>`;
      el.querySelector('b').textContent = `${z < 10 ? z.toFixed(1) : z.toFixed(0)} m`;
      el.querySelector('span').textContent = what;
      chipBox.append(el);
      const chip = { el, z, handles };
      chips.push(chip);
      el.addEventListener('pointerdown', (ev) => startChip(ev, chip));
    }
    placeLevelChips();
  }

  // Chips follow their height as you orbit, so the one you want is the one
  // beside the ring it moves.
  function placeLevelChips() {
    if (!chipBox || !camera || !controls) return;
    const h = canvas.clientHeight || 1;
    const want = [];
    for (const c of chips) {
      const p = new THREE.Vector3(controls.target.x, c.z, controls.target.z).project(camera);
      const y = ((1 - p.y) / 2) * h;
      c.el.hidden = p.z > 1;
      want.push({ c, y });
    }

    // Pushed apart, because zoomed out the levels project within a couple of
    // pixels of each other and three chips became one illegible pile. Sorted
    // by height and separated downwards, so the order still reads as the order
    // they fly at even where the spacing no longer matches the metres.
    const GAP = 25;
    want.sort((a, b) => a.y - b.y);
    for (let i = 1; i < want.length; i++) {
      if (want[i].y - want[i - 1].y < GAP) want[i].y = want[i - 1].y + GAP;
    }
    // And if that pushed the stack off the bottom, slide the whole thing back
    // up rather than letting the last ones fall out of the view.
    const overflow = want.length ? want[want.length - 1].y - (h - 16) : 0;
    if (overflow > 0) for (const w of want) w.y -= overflow;

    for (const w of want) {
      w.c.el.style.top = `${Math.max(4, w.y - 11)}px`;
    }
  }

  let chipDrag = null;
  function startChip(ev, chip) {
    ev.stopPropagation();          // not an orbit, and not a pad click
    ev.preventDefault();
    // Metres per pixel at this height, measured rather than assumed: it depends
    // on the camera distance and the projection, and it changes as you zoom.
    const at = (z) => {
      const p = new THREE.Vector3(controls.target.x, z, controls.target.z).project(camera);
      return ((1 - p.y) / 2) * (canvas.clientHeight || 1);
    };
    const per = at(chip.z) - at(chip.z + 1);
    chipDrag = { chip, y: ev.clientY, z0: chip.z, per: Math.abs(per) > 0.2 ? per : 4 };
    chip.el.classList.add('dragging');
    chip.el.setPointerCapture?.(ev.pointerId);
  }
  function moveChip(ev) {
    if (!chipDrag) return;
    const { chip, y, z0, per } = chipDrag;
    // Up on screen is up in the air, which is why this subtracts.
    const z = Math.round(Math.max(1, Math.min(500, z0 + (y - ev.clientY) / per)) * 10) / 10;
    if (z === chip.z) return;
    chip.z = z;
    chip.el.querySelector('b').textContent = `${z < 10 ? z.toFixed(1) : z.toFixed(0)} m`;
    onLevel(chip.handles, z);
  }
  function endChip() {
    if (!chipDrag) return;
    chipDrag.chip.el.classList.remove('dragging');
    chipDrag = null;
    onLevelDone();
  }

  // Dragging the RING, not only its chip.
  //
  // The chips came first and they are still the reliable grip -- always
  // reachable, never behind a building. But the thing you are looking at when
  // you decide a ring is too low is the ring, and reaching for a label at the
  // side of the screen to move it is a translation you have to do in your head.
  // So the ring itself takes the drag: up and down moves it, shift pulls it in.
  //
  // Picked in SCREEN space against the projected stations rather than by
  // raycasting the lines. Two reasons: a THREE.Line is a one-pixel thing that a
  // ray misses at any sane threshold, and the stations are already the handles
  // -- 14 px of slack round a station is a grab, and everything else is an
  // orbit of the camera as before.
  const GRAB_PX = 14;
  let ringDrag = null;

  // Where a waypoint lands on screen, in client coordinates, or null behind
  // the camera.
  function onScreen(w, rect) {
    const l = mission.frame.toLocal(w.lat, w.lon);
    const v = new THREE.Vector3(l.x, w.alt, -l.y).project(camera);
    if (v.z > 1) return null;
    return {
      x: rect.left + ((v.x + 1) / 2) * rect.width,
      y: rect.top + ((1 - v.y) / 2) * rect.height,
    };
  }

  // What is under the pointer: the nearest station within GRAB_PX, the chip
  // whose height owns it, and -- for an orbit -- the contiguous run of
  // same-height stations that make up that one dome.
  //
  // The run is how the centre and the radius are found without the planner
  // telling us either: a dome's ring is emitted as consecutive waypoints, so
  // walking outwards from the grabbed station while the pass and the height
  // hold gives exactly that ring and not the dome next to it.
  function ringUnder(ev) {
    if (!camera || !mission || !chips.length) return null;
    const path = mission.exported ?? mission.waypoints ?? [];
    if (!path.length) return null;
    const rect = canvas.getBoundingClientRect();
    let best = null;
    for (let i = 0; i < path.length; i++) {
      if (path[i].transit) continue;         // the climb between domes is not a ring
      const p = onScreen(path[i], rect);
      if (!p) continue;
      const d = Math.hypot(p.x - ev.clientX, p.y - ev.clientY);
      if (d > GRAB_PX || (best && d >= best.d)) continue;
      best = { d, i };
    }
    if (!best) return null;

    const w = path[best.i];
    // Which knob owns that height. Chips are already grouped by height and
    // carry the handles `mission.levels` tagged, so this is the same answer a
    // chip drag gets -- which is the point: two grips, one edit.
    let chip = null;
    for (const c of chips) {
      if (!chip || Math.abs(c.z - w.alt) < Math.abs(chip.z - w.alt)) chip = c;
    }
    if (!chip || Math.abs(chip.z - w.alt) > 1.5) return null;

    let a = best.i;
    let b = best.i;
    const same = (q) => q && q.pass === w.pass && !q.transit && Math.abs(q.alt - w.alt) < 0.05;
    while (same(path[a - 1])) a--;
    while (same(path[b + 1])) b++;
    return { chip, pass: w.pass, ring: path.slice(a, b + 1) };
  }

  function startRing(ev) {
    const hit = ringUnder(ev);
    if (!hit) return false;
    const rect = canvas.getBoundingClientRect();
    // Metres per pixel vertically at this height, measured the same way a chip
    // drag measures it, because it changes with every zoom.
    const at = (z) => {
      const p = new THREE.Vector3(controls.target.x, z, controls.target.z).project(camera);
      return ((1 - p.y) / 2) * (canvas.clientHeight || 1);
    };
    const per = at(hit.chip.z) - at(hit.chip.z + 1);

    // And the same thing for the radius, in the plane rather than in height:
    // the ring's own stations give both the metres (their mean distance from
    // their centre) and the pixels (theirs, projected), so the scale comes out
    // of the picture on screen instead of a guess about the projection.
    let cx = 0;
    let cy = 0;
    for (const q of hit.ring) {
      const l = mission.frame.toLocal(q.lat, q.lon);
      cx += l.x / hit.ring.length;
      cy += l.y / hit.ring.length;
    }
    const centre = mission.frame.toLatLon(cx, cy);
    const cs = onScreen({ ...centre, alt: hit.chip.z }, rect);
    let rM = 0;
    let rPx = 0;
    let seen = 0;
    for (const q of hit.ring) {
      const l = mission.frame.toLocal(q.lat, q.lon);
      rM += Math.hypot(l.x - cx, l.y - cy);
      const p = cs && onScreen(q, rect);
      if (p) { rPx += Math.hypot(p.x - cs.x, p.y - cs.y); seen++; }
    }
    rM /= hit.ring.length;
    rPx = seen ? rPx / seen : 0;

    ringDrag = {
      ...hit,
      y: ev.clientY,
      z0: hit.chip.z,
      per: Math.abs(per) > 0.2 ? per : 4,
      centre: cs,
      d0: cs ? Math.hypot(ev.clientX - cs.x, ev.clientY - cs.y) : 0,
      // Metres of ground per pixel across the ring. Falls back to the vertical
      // scale -- the same order of magnitude at any camera angle -- rather than
      // to a constant, which would make one drag jump and the next crawl.
      perR: rPx > 8 ? rM / rPx : 1 / Math.max(0.2, Math.abs(per)),
      // Which of the two edits this drag IS, decided at the press and not
      // re-decided per move: letting go of shift halfway would otherwise apply
      // the vertical travel you had already made as a height change.
      mode: ev.shiftKey ? 'radius' : 'height',
      base: mission.params?.orbitTighten ?? 0,
      rM,
      told: false,
    };
    // The camera does not also orbit. OrbitControls checks `enabled` at the top
    // of its own pointermove, so clearing it here is enough even though its
    // pointerdown has already been and gone.
    controls.enabled = false;
    // A synthesised pointerdown carries an id no pointer ever had, and capture
    // throws NotFoundError on it -- which is how this is driven from a browser
    // test, so the drag must survive it.
    try { canvas.setPointerCapture(ev.pointerId); } catch { /* not a real pointer */ }
    canvas.style.cursor = ev.shiftKey ? 'nwse-resize' : 'ns-resize';
    return true;
  }

  function moveRing(ev) {
    if (!ringDrag) return;
    const { chip, pass, centre, d0, perR, base, rM, mode } = ringDrag;
    if (mode === 'radius') {
      // Only the domes have a radius this can write to: it comes from framing
      // the subject's height, and the grids and the transects are not framing
      // anything. Say so once rather than moving something else.
      if (pass !== 'orbit') {
        if (!ringDrag.told) { ringDrag.told = true; onStatus('Only the orbit rings have a radius — drag up or down instead.'); }
        return;
      }
      if (!centre) return;
      const d = Math.hypot(ev.clientX - centre.x, ev.clientY - centre.y);
      // Towards the middle is smaller, which is why this is d0 - d.
      const want = base + (d0 - d) * perR;
      onStatus(`Ring radius ${Math.max(0, rM - (want - base)).toFixed(0)} m`);
      onRadius(want);
      return;
    }
    const z = Math.round(Math.max(1, Math.min(500, ringDrag.z0 + (ringDrag.y - ev.clientY) / ringDrag.per)) * 10) / 10;
    if (z === chip.z) return;
    chip.z = z;
    onLevel(chip.handles, z);
  }

  function endRing() {
    if (!ringDrag) return;
    ringDrag = null;
    if (controls) controls.enabled = true;
    canvas.style.cursor = '';
    onLevelDone();
  }

  function buildWires() {
    if (!scene) return;
    if (wireGroup) { scene.remove(wireGroup); wireGroup = null; }
    if (!wirePaths.length || !mission) return;
    if (!meshMode && (!loaded?.meta || loaded.datum === undefined)) return;
    const frame = mission.frame;
    wireGroup = new THREE.Group();
    for (const w of wirePaths) {
      const pts = (meshMode
        ? w.path.flatMap((q) => {
          const l = frame.toLocal(q.lat, q.lon);
          const g = groundUnder(l.x, -l.y);
          return g === null ? [] : [{ x: l.x, y: g + w.height, z: -l.y }];
        })
        : drapeWire(loaded.meta, loaded.height, frame, loaded.datum, w))
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

    // Collision mode: forget which pass a leg belongs to and say only whether
    // it can be flown. Green clear, red into something, grey never checked --
    // because the question is no longer "what is this pass" but "which of
    // these do I have to move", and a red ring answers it at a glance.
    //
    // Two buffers rather than a line per leg: a hundred and eleven draw calls
    // to say one thing is a hundred and ten too many.
    if (collisionMode && meshHazard?.verdict) {
      const parts = { 1: [], 2: [], 0: [] };
      for (let i = 1; i < path.length; i++) {
        parts[meshHazard.verdict[i] ?? 0].push(at(path[i - 1]), at(path[i]));
      }
      for (const [state, colour] of [[2, 0x2fd07a], [0, 0x6b7480], [1, 0xff3b3b]]) {
        if (!parts[state].length) continue;
        const g = new THREE.BufferGeometry().setFromPoints(parts[state]);
        missionGroup.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({
          color: colour,
          // The red is drawn last and never hidden by the ground, because a
          // leg inside a building is BEHIND the wall it is inside.
          depthTest: state !== 1,
          transparent: state === 0,
          opacity: state === 0 ? 0.5 : 1,
        })));
      }
      scene.add(missionGroup);
      if (looksOn) buildLooks(path, at);
      // The tally, because "which ones are red" is answerable by looking and
      // "are there any" is not -- a single red leg on the far side of a
      // building is invisible until you orbit round to it.
      const n = (state) => parts[state].length / 2;
      onStatus(`${n(1)} leg${n(1) === 1 ? '' : 's'} into something, ${n(2)} clear`
        + (n(0) ? `, ${n(0)} over ground not fetched` : ''));
      return;
    }

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
    for (const leg of [...(hazard?.legs ?? []), ...(meshHazard?.legs ?? [])]) {
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

    // How far a wedge reaches: to whatever its camera is actually looking at.
    //
    // It used to be a tenth of the FLIGHT's extent, capped by the altitude --
    // which on a tight site is 5.4 m, so every wedge was a stub, and the low
    // orbit rings were stubs hidden behind the buildings they were pointing at.
    // Length carried no information either: a camera aimed at a wall ten metres
    // away drew the same cone as one aimed at the ground forty metres below.
    //
    // Now each one is marched along its own axis against the height grid the
    // collision check uses, and stops where it meets something. So the wedge
    // lands ON the roof or facade it is framing, which is the thing you wanted
    // to see, and its length tells you the shot distance. 8,400 grid lookups
    // for seventy wedges, which is nothing.
    const box = new THREE.Box3();
    for (const w of path) box.expandByPoint(at(w));
    const span = Math.max(box.getSize(new THREE.Vector3()).x, 20);
    const fallback = Math.max(6, Math.min(span * 0.25, Math.max(box.max.y, 1) * 0.8));
    const REACH = 140;
    const reachOf = (apex, fwd) => {
      if (!heights) return fallback;
      for (let d = 2; d <= REACH; d += 1) {
        const g = groundUnder(apex.x + fwd.x * d, apex.z + fwd.z * d);
        if (g !== null && apex.y + fwd.y * d <= g) return d;
      }
      // Nothing in shot -- pointing at the sky, or off the fetched ground.
      return fallback;
    };

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
        const len = reachOf(apex, f);
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
        // Faint, but not invisible. 0.34 was lost against a photographic
        // surface once the mesh replaced flat classification colours.
        transparent: true, opacity: 0.62,
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
    if (!path.length || (!surfaceMesh && !meshGroup)) return;
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

  // One raster over the ground the flight actually crosses, stitched from
  // however many 500 m tiles that takes.
  //
  // The view used to load the ONE tile /v1/locate named, and a site near a tile
  // edge -- which is most of them, since the grid knows nothing about where
  // anybody flies -- had half its orbit hanging over nothing. The status line
  // admitted it and that was all.
  //
  // Stitching rather than drawing a mesh per tile, because every other thing
  // here already reads one `meta`: the crop, the wall mask, the drape, the
  // datum, groundAt. A synthesised meta over the crop keeps all of it working
  // and is one array instead of a scene graph.
  //
  // Square, because the grid is indexed as `row * grid + col` throughout, and
  // capped, because this is memory: 1200 m of side is 2400 cells, 5.8 M of
  // them, 17 MB across the two arrays.
  const MAX_SIDE_M = 1200;

  async function loadFor(lat, lon, { signal } = {}) {
    boot();
    const here = await ask(`/v1/locate?lat=${lat}&lon=${lon}`, { signal });
    if (!here.ok) throw new Error('outside the survey');
    const { tile } = await here.json();

    // The ground to cover: the flight, plus the margin, squared off.
    const path = mission?.exported ?? mission?.waypoints ?? [];
    let eMin = Infinity; let eMax = -Infinity; let nMin = Infinity; let nMax = -Infinity;
    for (const w of path) {
      const q = toPuwg92(w.lat, w.lon);
      eMin = Math.min(eMin, q.east); eMax = Math.max(eMax, q.east);
      nMin = Math.min(nMin, q.north); nMax = Math.max(nMax, q.north);
    }
    if (!Number.isFinite(eMin)) {
      const q = toPuwg92(lat, lon);
      eMin = eMax = q.east; nMin = nMax = q.north;
    }
    const CELL = 0.5;
    const TILE = 500;
    const side = Math.min(
      MAX_SIDE_M,
      Math.max(eMax - eMin, nMax - nMin) + 2 * MARGIN_M,
    );
    const cells = Math.round(side / CELL);
    // Snapped to the cell grid the tiles use, so a stitched cell lines up with
    // the cell it is copied from and nothing is resampled.
    const e0 = Math.round(((eMin + eMax) / 2 - side / 2) / CELL) * CELL;
    const n0 = Math.round(((nMin + nMax) / 2 - side / 2) / CELL) * CELL;

    const teA = Math.floor(e0 / TILE);
    const teB = Math.floor((e0 + side - 0.001) / TILE);
    const tnA = Math.floor(n0 / TILE);
    const tnB = Math.floor((n0 + side - 0.001) / TILE);
    // WHICH TILES MAY COST SOMETHING, and this distinction is the whole reason
    // browsing around cannot quietly pull gigabytes.
    //
    // A cold tile is ~223 MB of LiDAR fetched from GUGiK and minutes of CPU. So
    // the margin -- which is context, there to stop the view being a patch of
    // ground with no neighbourhood -- is never allowed to commission one. Only
    // the ground the AIRCRAFT ACTUALLY CROSSES is worth that, because the
    // clearance depends on it.
    //
    // Without the split, a 30 m site dropped near a tile corner spans 430 m
    // with the margin and touches four tiles: ~892 MB, unasked, for one view.
    // A 200 m site reaches nine, which is 2 GB. With it, the same site
    // commissions the one or two tiles it is flown over and takes the rest only
    // if they happen to be built already.
    const inTiles = (a0, a1, b0, b1) => {
      const out = [];
      for (let tn = Math.floor(b0 / TILE); tn <= Math.floor((b1 - 0.001) / TILE); tn++) {
        for (let te = Math.floor(a0 / TILE); te <= Math.floor((a1 - 0.001) / TILE); te++) {
          out.push({ tn, te });
        }
      }
      return out;
    };
    // The flight's own footprint, with a few metres of slack so a waypoint on a
    // boundary does not depend on rounding.
    const flown = inTiles(eMin - 5, eMax + 5, nMin - 5, nMax + 5);
    const isFlown = (t) => flown.some((f) => f.tn === t.tn && f.te === t.te);
    const want = inTiles(e0, e0 + side, n0, n0 + side);
    const key = `${cells}|${e0}|${n0}|${want.map((t) => `${t.tn}/${t.te}`).join(',')}`;
    if (loaded && loaded.key === key) return loaded;

    // Flown tiles first, so the ground under the aircraft is there even if a
    // context tile is slow. A tile that fails is skipped: better a surface with
    // a hole in it, marked as unmeasured, than no surface at all.
    const order = [...want].sort((a, b) => Number(isFlown(b)) - Number(isFlown(a)));
    const building = order.filter(isFlown).length;
    const parts = [];
    let skipped = 0;
    for (let i = 0; i < order.length; i++) {
      const t = order[i];
      const flownOne = isFlown(t);
      const which = building > 1 && flownOne ? ` (${i + 1} of ${building})` : '';
      onStatus(`Asking for the survey${which}…`);
      try {
        // `peek=1` for context: it answers 404 for a tile nobody has built and
        // does not start building it.
        const metaRes = await poll(`/v1/scene/${t.tn}/${t.te}.json${flownOne ? '' : '?peek=1'}`, {
          signal,
          onWait: () => onStatus(
            `First look at this ground${which} — building it from the LiDAR. `
            + 'A few minutes and a few hundred megabytes.',
          ),
        });
        const m = await metaRes.json();
        if (m.empty) continue;
        onStatus(`Downloading the surface${which}…`);
        const buf = await poll(`/v1/scene/${t.tn}/${t.te}`, { signal }).then((r) => r.arrayBuffer());
        const g = m.grid;
        parts.push({
          t,
          meta: m,
          height: new Uint16Array(buf, 0, g * g),
          kind: new Uint8Array(buf, g * g * 2, g * g),
        });
      } catch (e) {
        if (signal?.aborted) throw e;
        // A context tile that is simply not built yet is the expected case, not
        // a failure: it is the reason `peek` exists.
        if (isFlown(t)) console.warn(`tile ${t.tn}/${t.te} could not be loaded:`, e);
        else skipped++;
      }
    }
    if (!parts.length) throw new Error('no LiDAR here');

    const { base, height, kind } = stitch(parts, { e0, n0, side, cell: CELL });

    const meta = {
      grid: cells,
      cellMetres: CELL,
      tileMetres: side,
      origin: { east: e0, north: n0 },
      base: +base.toFixed(2),
      bounds: (() => {
        const sw = toWgs84(e0, n0);
        const ne = toWgs84(e0 + side, n0 + side);
        return { south: sw.lat, west: sw.lon, north: ne.lat, east: ne.lon };
      })(),
      // Which tiles this is made of, so the buildings can be asked for per tile
      // and the status can say how wide the picture really is.
      tiles: parts.map((q) => q.t),
      wanted: want.length,
      // Context tiles nobody has built. Not an error, and not something to fix
      // by building them: they are neighbourhood, and the aircraft is not
      // going there.
      unbuilt: skipped,
    };
    const next = {
      key,
      tn: tile.tn,
      te: tile.te,
      meta,
      base: meta.base,
      height,
      kind,
      ortho: null,
    };

    // The picture comes from the map, always. The LiDAR measures the depth and
    // the map provides the graphics, and that division is the whole design:
    // look straight down at this surface and you are looking at the left-hand
    // pane, because it is the same imagery.
    //
    // GUGiK's own orthophoto used to be fetched here in preference and it is
    // gone. It was the better source on paper -- the same photograph the
    // heights were measured from, in the same projection, no transform at all
    // -- but it bought nothing that survived measurement, and it cost the
    // thing that matters. It does not exist over most of the country, so the
    // survey view fell back to flat classification colours and read as a grey
    // abstraction; that was the original complaint. And the two panes showed
    // different pictures of the same ground for no reason a user could see.
    //
    // The alignment worry that justified preferring it was tested rather than
    // asserted -- see basemapTexture -- and the two agree to under a metre.
    onStatus('Draping the map…');
    try {
      const got = await basemapTexture(meta);
      next.ortho = got?.tex ?? null;
      next.orthoBox = got?.box ?? null;
      next.orthoMpp = got?.metresPerPixel ?? null;
    } catch (e) {
      // Classification colours instead, which is no less true -- but say so.
      // A bare catch here hid a ReferenceError through several rounds of
      // testing, and "the picture is missing" is indistinguishable from "this
      // ground has no picture" unless the error is spoken.
      console.warn('the map could not be draped:', e);
    }

    // The buildings, as solids with walls -- the one thing the surface cannot
    // hold. Not fatal if it fails: the surface stands on its own and the wall
    // marking goes back to being the only thing said about a facade, which is
    // what yesterday's behaviour was.
    // Per tile, like the surface, and the rings arrive in THAT tile's metres --
    // so each is shifted into the stitch before anything downstream sees a
    // mixture. Getting this wrong would mark walls half a kilometre from the
    // buildings they belong to.
    onStatus('Asking for the buildings…');
    next.buildings = [];
    for (const t of meta.tiles) {
      try {
        const got = await ask(`/v1/buildings/${t.tn}/${t.te}`, { signal });
        if (!got.ok) continue;
        const de = t.te * TILE - e0;
        const dn = t.tn * TILE - n0;
        for (const b of (await got.json()).buildings ?? []) {
          next.buildings.push({ ...b, ring: b.ring.map(([e, n]) => [e + de, n + dn]) });
        }
      } catch (e) {
        // The surface stands on its own; the wall marking falls back to the
        // step heuristic, which is what it did before there were footprints.
        console.warn(`buildings for ${t.tn}/${t.te} could not be loaded:`, e);
      }
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
      // `loaded` is the LiDAR, and mesh mode never sets it -- so without the
      // second test every replan reopened the view and re-fetched the mesh,
      // which is 7.3 MB a time.
      if (!loaded && !meshTiles.size) { api.open(); return; }
      // Re-checked, not just redrawn. The whole point of the finding is that
      // acting on it makes it go away, and a stale "25 legs fly into
      // buildings" after you raised the flight is worse than no finding: it
      // says the fix did not work when it did.
      // Everything the mesh view draws from the mission, on every replan, in
      // whatever view is up. reportMesh builds the mission itself, so calling
      // buildMission first was drawing it twice; and buildWires was not called
      // at all, so wires kept the heights of the plan before last.
      if (meshTiles.size) { reportMesh(); buildWires(); render(); return; }
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

    // The basemap the map on the left is showing, which is where this view's
    // every pixel comes from. Switching the picker re-drapes, because the two
    // panes showing different pictures of the same ground is the thing this
    // arrangement exists to prevent.
    //
    // Keyed on a generated URL rather than on the spec: groundSpec.url is built
    // fresh on every call, so comparing the functions would re-drape forever.
    async setGround(spec) {
      const was = groundSpec?.url?.(0, 0, 0) ?? null;
      groundSpec = spec ?? null;
      const now = groundSpec?.url?.(0, 0, 0) ?? null;
      if (was === now || !loaded || !renderer) return;
      const got = await basemapTexture(loaded.meta, loaded.orthoBox)
        .catch((e) => { console.warn('re-drape failed:', e); return null; });
      if (!got) return;
      loaded.ortho?.dispose?.();
      loaded.ortho = got.tex;
      loaded.orthoMpp = got.metresPerPixel;
      const tex = got.tex;
      // Swap the texture on the material rather than rebuilding the surface.
      // buildSurface ends by re-framing the camera, so re-draping through it
      // threw away whatever view you had orbited to -- for a change of
      // basemap, which alters not one vertex.
      if (surfaceMesh) {
        surfaceMesh.material.uniforms.uOrtho.value = tex;
        surfaceMesh.material.uniforms.uHasOrtho.value = 1;
      }
      render();
    },

    onStatus(fn) { onStatus = fn ?? (() => {}); },

    // What the mesh says about the flight, for the readout to judge. Reported
    // rather than returned, because it is answered when a tile arrives and not
    // when anybody asks.
    onMesh(fn) { onMesh = fn ?? (() => {}); },

    // A level dragged in this view, and the end of that gesture -- the same two
    // callbacks js/view3d.js offers, so the app wires one behaviour for both.
    // Paint the flight by whether it can be flown rather than by what pass it
    // is. Rebuilt rather than recoloured, because the two pictures group the
    // legs differently: one by pass, one by verdict.
    setCollision(on) {
      collisionMode = !!on;
      if (!renderer || !mission) return;
      buildMission();
      render();
    },
    collision: () => collisionMode,

    onLevel(fn) { onLevel = fn ?? (() => {}); },
    onRadius(fn) { onRadius = fn ?? (() => {}); },
    onLevelDone(fn) { onLevelDone = fn ?? (() => {}); },

    // The lowest the rings can fly and still clear the mesh. Asked for by the
    // readout when somebody takes the offer, not computed speculatively.
    fitRings,

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
        // The mesh first, always, because where it exists it is the better
        // picture by a wide margin -- centimetres against half a metre, and
        // walls that were photographed rather than inferred. It is asked for
        // before the LiDAR rather than instead of it, so the fallback costs one
        // small request and not a heightfield built and thrown away.
        onStatus('Looking for a photogrammetric mesh…');
        const mesh = await loadMeshTile(c.lat0, c.lon0, { signal: ctl.signal })
          .catch(() => ({ ok: false, why: 'the mesh service did not answer' }));
        if (mesh.ok) {
          const first = !framedMesh;
          meshMode = true;
          reportMesh();
          buildPads();
          buildWires();
          // Only the first time. Leaving the view and coming back used to
          // reset the camera, so any trip to the map to click something cost
          // you the angle you had lined up.
          if (first) { frameCamera(); framedMesh = true; }
          render();
          sayMesh();
          return;
        }
        // No mesh over this ground, which is most of the country: the LiDAR
        // heightfield, exactly as before.
        // A site with no mesh must not inherit the last one's. meshMode used to
        // stay true, so the survey view kept drawing the previous city's tiles,
        // buildWires measured heights off its grid, and buildSurface was never
        // reached at all.
        meshMode = false;
        framedMesh = false;
        for (const t of meshTiles.values()) { meshGroup?.remove(t); t.geometry.dispose(); }
        meshTiles.clear();
        heights = null;
        meshHazard = null;
        if (padGroup) { scene.remove(padGroup); padGroup = null; }
        onMesh(null);
        onStatus('No mesh here — building the LiDAR surface instead…');
        await loadFor(c.lat0, c.lon0, { signal: ctl.signal });
        buildSurface();
        const n = loaded.meta.tiles?.length ?? 1;
        onStatus(`${loaded.meta.sources?.[0]?.year ?? 'LiDAR'} survey, `
          + `${loaded.meta.cellMetres * loaded.step} m cells, `
          + `${(loaded.cells / 1000).toFixed(0)}k points, `
          + `${n === 1 ? 'one tile' : `${n} tiles stitched`}, `
          + 'heights above your takeoff point.'
          + (loaded.missing
            ? ` ${loaded.missing} tile${loaded.missing === 1 ? '' : 's'} would not build, so there `
              + `${loaded.missing === 1 ? 'is a hole' : 'are holes'} in it.`
            : '')
          + (loaded.meta.unbuilt
            ? ` The ground around it is not surveyed yet — ${loaded.meta.unbuilt} `
              + `neighbouring tile${loaded.meta.unbuilt === 1 ? '' : 's'}, not fetched, `
              + 'because your flight does not go there.'
            : '')
          + (loaded.clipped
            ? ' The site is bigger than this view will stitch — what you see stops there.'
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

    // Reproduce the map: straight down, north up, the same width of ground.
    //
    // It used to keep whatever angle you had already orbited to, on the
    // reasoning that a sync should not throw away a view you spent time
    // getting. That was the wrong call for what this button is for. The reason
    // to point the 3D at the map is to CHECK the two against each other, and
    // that only works if looking down gives you the map back -- same place,
    // same scale, same way up. An oblique view at the right centre cannot be
    // compared with anything.
    //
    // The nudge is not a fudge. Directly above the target, the up vector is
    // degenerate and the screen rotation is undefined; a thousandth of the
    // distance to the south puts OrbitControls at azimuth 0, where screen-up
    // works out as north, and tilts the camera by 0.06 of a degree.
    lookAt({ lat, lon, spanM }) {
      if (!mission || !controls) return;
      const l = mission.frame.toLocal(lat, lon);
      // Half the span subtends half the field of view, so this is the height
      // at which exactly spanM of ground is in shot.
      const dist = Math.max(20, (spanM / 2) / Math.tan((camera.fov * Math.PI) / 360));
      controls.target.set(l.x, 0, -l.y);
      camera.position.set(l.x, dist, -l.y + dist * 0.001);
      controls.update();
      render();
    },

    close() { running = false; inFlight?.abort?.(); inFlight = null; },
    resize() { render(); },
    ready: () => Boolean(loaded),
  };
  return api;
}
