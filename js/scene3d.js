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
  let groundSpec = null;
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
    controls.addEventListener('change', () => { render(); scheduleRedrape(); });
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
    loaded.missing = (meta.wanted ?? 1) - (meta.tiles?.length ?? 1);

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
    const want = [];
    for (let tn = tnA; tn <= tnB; tn++) {
      for (let te = teA; te <= teB; te++) want.push({ tn, te });
    }
    const key = `${cells}|${e0}|${n0}|${want.map((t) => `${t.tn}/${t.te}`).join(',')}`;
    if (loaded && loaded.key === key) return loaded;

    // Every tile is asked for, and a tile nobody has built yet gets built --
    // which is minutes and a couple of hundred megabytes of LiDAR from GUGiK,
    // so the status says which one and how many are left rather than sitting
    // silent. A tile that fails is skipped: better a surface with a hole in it,
    // marked as unmeasured, than no surface at all.
    const parts = [];
    for (let i = 0; i < want.length; i++) {
      const t = want[i];
      const which = want.length > 1 ? ` (${i + 1} of ${want.length})` : '';
      onStatus(`Asking for the survey${which}…`);
      try {
        const metaRes = await poll(`/v1/scene/${t.tn}/${t.te}.json`, {
          signal,
          onWait: () => onStatus(
            `First look at this ground${which} — building it from the LiDAR. A few minutes.`,
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
        console.warn(`tile ${t.tn}/${t.te} could not be loaded:`, e);
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
