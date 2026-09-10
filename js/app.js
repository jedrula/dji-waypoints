// One page: a map you tap, and a band of controls above it.
//
// The app used to be five views -- a plan, an obstacle list, a walk, a library
// and a controller -- and the first three were the same job seen from three
// angles. All you ever want is one safe flight over a thing, and there are only
// two questions on the ground: what must the camera see, and what must the
// aircraft not hit. So there is one map and two kinds of tap, and everything
// else is a sheet that slides up over it and goes away again.
//
// What a tap means:
//   capture   the footprint (js/shape.js) of these is what gets flown, and the
//             tallest of them is how tall the subject is. They are the plan.
//   obstacle  a small box the flight is checked against. Global and synced,
//             because a tree is a tree whichever plan you are drawing.
//
// Startup order matters here and has bitten before: module setup calls into
// code written for a running app. Anything that runs during setup must either
// use only what is declared above it or bail on `ready` -- reaching forward for
// a `const` further down does not read as undefined, it throws, and it takes
// the whole module with it.

import { CAMERAS, gsdCm } from './camera.js';
import { planMission, proposePlan, splitMission, pointsFromRect, DEFAULTS, DJI_FLY_MAX_WAYPOINTS } from './planner.js';
import { SHAPES, DEFAULT_SHAPE, footprintOf, polygonArea } from './shape.js';
import { frame, mPerDegLat, mPerDegLon } from './geo.js';
import { mPerPx } from './tiles.js';
import { PASS_COLOR, LEG_COLOR, passColour } from './palette.js';
import { buildKmz } from './wpml.js';
import { createView3D } from './view3d.js';
import { scoreCoverage } from './coverage.js';
import { initInstall } from './install.js';
import { encodePlan, decodePlan } from './share.js';
import { initPlans } from './plansui.js';
import { routeFromRead } from './route.js';
import { createBasemaps } from './basemap.js';
import { createSite, parseHeight, DEFAULT_POINT_HEIGHT, MAX_CAPTURE_POINTS } from './site.js';
import { localPrisms, overlaps } from './prism.js';
import { spanQuads, LINE_SPAN } from './lines.js';
import { checkObstacles, clearingAltitude } from './collide.js';
import { createHistory } from './history.js';

import { bestFix, GPS_ERRORS, STALE_MS } from './gps.js';
import { sampleTerrain, verdict as terrainVerdict } from './terrain.js';
import { serviceUrl, serviceHeaders } from './service.js';

const cam = CAMERAS.mini5pro;
const $ = (id) => document.getElementById(id);


const CLEARANCE_KEY = 'dji.clearance';

let ready = false;
let urlFrozen = true;

// The address bar as it was when the page opened. writeUrl() rewrites it to
// just the view, so anything that arrived as a parameter has to be read before
// that happens -- and the pretend receiver has to be carried back through, or
// the first pan of the map would switch it off.
const opened = new URLSearchParams(location.search);
// Prototype switches the address bar carries. writeUrl rebuilds the query from
// the keys it knows, so anything not listed here is dropped on the first write.
//
// `mesh` was here and is gone: the survey view asks for the photogrammetric
// mesh first and falls back to the LiDAR surface where there is none, so
// coverage decides and there is nothing to switch.
const MOCK_KEYS = ['mockgps', 'acc', 'age'];

const state = {
  mode: 'capture',            // what a tap on the map means
  selected: null,             // { kind, id } -- the point the bar is editing
  mission: null,
  coverage: null,
  hazard: null,
  // What the photogrammetric mesh says about the flight, when the survey view
  // has one. Null until it reports, and null is "not checked", not "clear".
  mesh: null,
  clearAlt: null,
  terrain: null,              // what the ground under the site does
  onDevice: null,             // a route being looked at next to yours
};

// Whether the flight is drawn on the map. Not whether it exists -- it always
// exists and the numbers are always live -- just whether you want several
// hundred waypoints on top of the thing you are tapping. Remembered, because
// it is a preference about how you work rather than about this plan.
const ROUTE_KEY = 'dji.showroute';
let showRoute = true;
try { showRoute = localStorage.getItem(ROUTE_KEY) !== '0'; } catch { /* private window */ }

/* ---------- map ---------- */
const map = L.map('map', { zoomControl: true, attributionControl: true }).setView([50.0614, 19.9366], 16);

const layers = {
  footprint: L.polygon([], { color: '#4da3ff', weight: 1.5, dashArray: '5,4',
                             fill: true, fillOpacity: 0.05, interactive: false }).addTo(map),
  wires: L.layerGroup().addTo(map),
  path: L.layerGroup().addTo(map),
  dots: L.layerGroup().addTo(map),
  devicePath: L.layerGroup().addTo(map),
  deviceDots: L.layerGroup().addTo(map),
  devicePoses: L.layerGroup().addTo(map),
  conflicts: L.layerGroup().addTo(map),
  poses: L.layerGroup().addTo(map),
  gps: L.layerGroup().addTo(map),
  points: L.layerGroup().addTo(map),     // over everything: they are what you touch
};

const basemaps = createBasemaps({ map, onChange: () => { pushGround(); writeUrl(); } });

/* ---------- 3D ---------- */
const view3d = createView3D($('scene'));
let activeView = 'map';
// What the flight is drawn over. Three answers to one question, so one setting
// rather than two toggles that can disagree about it:
//
//   simple    the grid, and nothing else
//   imagery   the map's own tiles on a flat plane -- a photograph of the ground
//   survey    the LiDAR as a real surface, with the flight inside it
//
// `imagery` is the default. It was opt-in while it was the only thing this view
// could put under a flight and it looked like a debug overlay; a flight over
// bare grid is the least useful of the three.
//
// `survey` is a different renderer, not a different layer -- see js/scene3d.js
// -- and its module is not even fetched until it is first picked, because it
// brings three.js with it and nobody planning over imagery needs the megabyte.
const GROUNDS = ['simple', 'imagery', 'survey'];
let groundMode = 'imagery';
let lidar = null;

// Overhead lines, and whether they are being shown.
//
// Not part of the ground picker, deliberately: the ground is a backdrop and you
// pick one, while a wire is a hazard and belongs on the map AND in the survey at
// the same time. It is also the one hazard the LiDAR cannot supply -- see
// tools/wire-spike.mjs for the attempt and why it found nothing -- so it comes
// from the national register instead, and is worth its own switch.
let wiresOn = false;
// Shown by default: the first question anyone asks of a 3D route is which way
// the camera is facing, and answering it unasked is cheaper than a discovery.
let looksOn = true;
let wirePaths = [];

async function lidarView() {
  if (!lidar) {
    const { createScene3D } = await import('./scene3d.js');
    lidar = createScene3D($('lidar'));
    // What the photogrammetric mesh says about the flight. Geometry from the
    // view, judgement here: it reports what is under the flight and what the
    // flight runs into, and the readout decides whether that is too close.
    lidar.onMesh((m) => { state.mesh = m; renderAlert(false); });
    lidar.onLevel(moveLevel);
    lidar.onLevelDone(() => history.commit());
    lidar.setLooks(looksOn);
    // Set here as well as in setView, because this is created lazily and the
    // first tile can load before the view is switched to.
    lidar.setGround(basemaps.groundSpec(true));
    lidar.onStatus((text) => toast(text, { sticky: /minutes|Asking|Downloading/.test(text) }));
  }
  return lidar;
}

async function setGround(name) {
  if (!GROUNDS.includes(name)) return;
  groundMode = name;
  for (const b of document.querySelectorAll('#groundtabs button')) {
    b.classList.toggle('on', b.dataset.ground === name);
  }
  pushGround();
  applyViewCanvases();
  writeUrl();
  if (name !== 'survey') {
    lidar?.close();
    // Tell the flat view what it is standing on and make it draw. Neither
    // happened here: setView set the ground spec and setGround did not, and
    // nothing asked for a frame -- so picking "no ground" or "imagery" showed
    // an empty canvas until some other event happened to trigger a draw, which
    // in practice meant nudging the view.
    view3d.setGround(basemaps.groundSpec(name === 'imagery'));
    view3d.draw();
    return;
  }
  const view = await lidarView();
  view.setMission(state.mission, state.hazard);
  await view.open();
}

// Which of the two canvases is on screen. `hidden` on the wrong one is not
// enough on its own: a hidden canvas has no client size, so the renderer that
// owns it has to be told once it is visible again.
function applyViewCanvases() {
  const show3d = activeView !== 'map';
  const survey = groundMode === 'survey';
  $('scene').hidden = !show3d || survey;
  $('lidar').hidden = !show3d || !survey;
  if (show3d && survey) lidar?.resize();
  // The same for the flat canvas: it had no client size while hidden, so
  // whatever it drew last was drawn at the wrong size or not at all.
  if (show3d && !survey) view3d.draw();
}



function setView(name) {
  activeView = name;
  const showMap = name !== '3d';
  const show3d = name !== 'map';
  for (const b of document.querySelectorAll('#viewtabs button')) b.classList.toggle('on', b.dataset.view === name);
  $('stage').classList.toggle('split', name === 'split');
  $('map').hidden = !showMap;
  $('scene').hidden = !show3d;
  $('lidar').hidden = true;
  $('splitter').hidden = name !== 'split';
  $('basetabs').hidden = !showMap;
  $('findme').hidden = !showMap;
  // Each belongs to the view it acts on: the route toggle hides clutter on the
  // map, the imagery button paints the ground under the 3D.
  $('routeToggle').hidden = !showMap;
  $('groundtabs').hidden = !show3d;
  // Each sync is only offered when the view it READS from is on screen: there
  // is no sense in aiming the 3D at a map you cannot see.
  $('syncTo3d').hidden = !showMap;
  $('syncToMap').hidden = !show3d;
  $('looksBtn').hidden = !show3d;
  $('findplace').hidden = !showMap;
  if (!showMap) openPlace(false);
  showRecentre();
  if (name === 'split') setSplit(splitPct, { store: false });
  if (showMap) map.invalidateSize();
  applyViewCanvases();
  if (show3d && groundMode !== 'survey') view3d.draw();
  writeUrl();
}

// Which axis the divider moves along is the stylesheet's business -- the same
// percentage drives a left/right split on a laptop and a top/bottom one on a
// phone -- so the drag only has to ask which way the panes are stacked.
const SPLIT_KEY = 'dji.split';
const stacked = () => window.matchMedia('(max-width: 720px)').matches;

// Clamped in pixels rather than percent: a pane narrower than its own floating
// controls puts the basemap picker on the zoom buttons, and a pane that thin is
// not showing you anything anyway.
function splitPercent(pct) {
  const r = $('stage').getBoundingClientRect();
  const total = (stacked() ? r.height : r.width) || 1;
  const min = Math.min(stacked() ? 130 : 240, total * 0.25);
  return (Math.max(min, Math.min(total - min, (pct / 100) * total)) / total) * 100;
}

function setSplit(pct, { store = true } = {}) {
  const v = splitPercent(pct);
  $('stage').style.setProperty('--split', `${v.toFixed(2)}%`);
  const mapWidth = ($('stage').getBoundingClientRect().width * v) / 100;
  $('stage').classList.toggle('tight', !stacked() && mapWidth < 240);
  if (store) { try { localStorage.setItem(SPLIT_KEY, String(v)); } catch { /* private window */ } }
  map.invalidateSize();
  view3d.draw();
}

let splitPct = 50;
try { splitPct = +localStorage.getItem(SPLIT_KEY) || 50; } catch { /* private window */ }

$('splitter').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  $('splitter').setPointerCapture(e.pointerId);
  $('splitter').classList.add('dragging');
});
$('splitter').addEventListener('pointermove', (e) => {
  if (!$('splitter').hasPointerCapture(e.pointerId)) return;
  const r = $('stage').getBoundingClientRect();
  splitPct = stacked() ? ((e.clientY - r.top) / r.height) * 100 : ((e.clientX - r.left) / r.width) * 100;
  setSplit(splitPct);
});
const endSplit = () => $('splitter').classList.remove('dragging');
$('splitter').addEventListener('pointerup', endSplit);
$('splitter').addEventListener('pointercancel', endSplit);
// Double-click puts it back to even, which is easier than nudging it there.
$('splitter').addEventListener('dblclick', () => { splitPct = 50; setSplit(50); });
window.addEventListener('resize', () => {
  if (activeView === 'split') setSplit(splitPct, { store: false });
  else if (activeView !== 'map') view3d.draw();
});
for (const btn of document.querySelectorAll('#viewtabs button')) {
  btn.addEventListener('click', () => setView(btn.dataset.view));
}

function pushGround() {
  if (!ready) return;
  view3d.setGround(basemaps.groundSpec(groundMode === 'imagery'));
  // The survey view wants the same imagery, but only where the country has no
  // orthophoto of its own -- so it gets the spec regardless of whether the flat
  // view is painting with it.
  lidar?.setGround(basemaps.groundSpec(true));
}

/* ---------- the address bar is where the view lives ---------- */
function writeUrl() {
  if (urlFrozen) return;
  const q = new URLSearchParams();
  q.set('v', activeView);
  q.set('b', basemaps.name());
  const c = map.getCenter();
  q.set('c', `${c.lat.toFixed(5)},${c.lng.toFixed(5)}`);
  q.set('z', String(map.getZoom()));
  if (groundMode !== 'imagery') q.set('s', groundMode);
  if (wiresOn) q.set('w', '1');
  if (!looksOn) q.set('k', '0');
  for (const k of MOCK_KEYS) if (opened.has(k)) q.set(k, opened.get(k));
  const code = planCode();
  window.history.replaceState(null, '', `?${q}${code ? `#plan=${code}` : ''}`);
}

function readUrl() {
  const q = new URLSearchParams(location.search);
  basemaps.set(q.get('b') ?? basemaps.name());
  if (['map', 'split', '3d'].includes(q.get('v'))) setView(q.get('v'));
  if (GROUNDS.includes(q.get('s'))) setGround(q.get('s'));
  // Fetched, not just switched on. Restoring `w=1` from a link used to set the
  // toggle and draw an empty list, so a shared plan with wires showing arrived
  // with none until you turned them off and on again.
  if (q.get('w') === '1') { wiresOn = true; drawWires(); loadWires().then(drawWires); }
  if (q.get('k') === '0') setLooks(false);
  const [lat, lon] = (q.get('c') ?? '').split(',').map(Number);
  const zoom = Number(q.get('z'));
  if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180
      && Number.isFinite(zoom) && zoom >= 1 && zoom <= 22) {
    // Not animated: opening a link should land where the link says rather than
    // fly there, and Leaflet's animated path waits on a CSS transition that
    // never finishes in a tab the browser is not painting.
    map.setView([lat, lon], zoom, { animate: false });
  }
}
map.on('moveend', () => { writeUrl(); showRecentre(); });

// Pan far enough and the points you are working on are somewhere off the edge,
// with nothing on screen to say which way. One tap puts them back.
//
// It appears only when they are actually lost. A control that offers to take
// you where you already are is clutter, and clutter on a map you are tapping
// costs more than it does anywhere else -- so the test is whether the middle of
// the site is still on screen at all.
function siteBounds() {
  const pts = site.capture();
  if (!pts.length) return null;
  return L.latLngBounds(pts.map((p) => [p.lat, p.lon]));
}

function showRecentre() {
  const b = siteBounds();
  $('recentre').hidden = !b || activeView === '3d' || map.getBounds().contains(b.getCenter());
}

/* ---------- going somewhere ---------- */
// A mission usually starts from an address: you know where the job is before
// you know anything else about it. Two ways in, because both are how people
// actually have a place to hand -- a name, or a pair of numbers off a phone.

// Coordinates first, and offline: "51.1103, 17.0553" is not a question for a
// geocoder, and a pasted pair should not need the network or wait on it.
function asCoords(text) {
  const m = String(text).trim().match(/^(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
}

function openPlace(on) {
  $('placebar').hidden = !on;
  $('findplace').classList.toggle('on', on);
  if (on) $('place').focus();
}
$('findplace').addEventListener('click', () => openPlace($('placebar').hidden));
$('placeClose').addEventListener('click', () => openPlace(false));
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('placebar').hidden) openPlace(false); });

$('placebar').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('place').value.trim();
  if (!q) return;

  const here = asCoords(q);
  if (here) {
    map.setView([here.lat, here.lon], Math.max(map.getZoom(), 19), { animate: false });
    openPlace(false);
    toast(`At ${here.lat.toFixed(5)}, ${here.lon.toFixed(5)}.`);
    return;
  }

  $('placeGo').disabled = true;
  $('placeGo').textContent = '…';
  try {
    const r = await fetch('https://nominatim.openstreetmap.org/search'
      + `?format=json&limit=1&q=${encodeURIComponent(q)}`);
    const [hit] = await r.json();
    if (!hit) { toast(`Nothing found for “${q}”.`); return; }
    // Zoom to the thing rather than to a fixed level: a boundingbox is a
    // street or a city depending on what was asked for, and 19 over a city is
    // a rooftop somewhere near the middle of it.
    const bb = hit.boundingbox?.map(Number);
    if (bb && bb.every(Number.isFinite)) {
      map.fitBounds(L.latLngBounds([bb[0], bb[2]], [bb[1], bb[3]]), { animate: false, maxZoom: 19 });
    } else {
      map.setView([+hit.lat, +hit.lon], 18, { animate: false });
    }
    openPlace(false);
    toast(hit.display_name.split(',').slice(0, 3).join(',').trim());
  } catch {
    toast('Search is unavailable — pan the map, or paste coordinates.');
  } finally {
    $('placeGo').disabled = false;
    $('placeGo').textContent = 'Go';
  }
});

$('recentre').addEventListener('click', () => {
  const b = siteBounds();
  if (!b) return;
  // pad() keeps a single point from zooming to the maximum, and gives a real
  // site a margin to sit in.
  map.fitBounds(b.pad(0.35), { animate: false, maxZoom: 20 });
  showRecentre();
});

/* ---------- controls ---------- */
const controls = {
  altitude: { el: $('altitude'), val: (v) => +v, fmt: (v) => `${v} m` },
  frontOverlap: { el: $('frontOverlap'), val: (v) => v / 100, fmt: (v) => `${v}%` },
  sideOverlap: { el: $('sideOverlap'), val: (v) => v / 100, fmt: (v) => `${v}%` },
  speed: { el: $('speed'), val: (v) => +v, fmt: (v) => `${(+v).toFixed(1)} m/s` },
  orbitPad: { el: $('orbitPad'), val: (v) => +v, fmt: (v) => `${v > 0 ? '+' : ''}${v} m` },
};
const PASS_IDS = ['nadir', 'oblique', 'orbit', 'transect', 'surround', 'establish'];
const PICK_IDS = ['photoMode', 'profile', 'shotsPerStop', 'orbitRings', 'surroundRings', 'shape'];

for (const [name, spec] of Object.entries(SHAPES)) {
  const o = document.createElement('option');
  o.value = name;
  o.textContent = `${spec.label} — ${spec.detail}`;
  $('shape').append(o);
}

// Heights pinned by dragging a level in the 3D view.
//
// Not controls, because there is no slider for "the second orbit ring sits at
// 21 m" -- so they live here and join uiValues on the way out. js/share.js has
// carried them in the plan code all along and js/planner.js has accepted them;
// what was missing was anything setting them, which is why the levels were not
// draggable.
let pinned = { orbitHeights: null, transectHeights: null };

function uiValues() {
  const v = {};
  for (const k of Object.keys(controls)) v[k] = +controls[k].el.value;
  for (const id of PASS_IDS) v[id] = $(id).checked;
  v.photoMode = $('photoMode').value;
  v.profile = $('profile').value;
  v.shape = $('shape').value;
  v.shotsPerStop = +$('shotsPerStop').value;
  v.orbitRings = +$('orbitRings').value;
  v.surroundRings = +$('surroundRings').value;
  if (pinned.orbitHeights) v.orbitHeights = pinned.orbitHeights;
  if (pinned.transectHeights) v.transectHeights = pinned.transectHeights;
  return v;
}

function applyUiValues(v) {
  // Absent means "not pinned", which is a real state and not a missing value:
  // a restored plan whose levels were never dragged must go back to the spread
  // the ring count implies, not to whatever the last plan was dragged to.
  pinned = { orbitHeights: v.orbitHeights ?? null, transectHeights: v.transectHeights ?? null };
  for (const k of Object.keys(controls)) if (v[k] !== undefined) controls[k].el.value = v[k];
  for (const id of PASS_IDS) if (v[id] !== undefined) $(id).checked = v[id];
  for (const id of PICK_IDS) if (v[id] !== undefined) $(id).value = String(v[id]);
  readOuts();
}

// Planner params out of stored control values. Everything that plans -- the
// live controls and a restored code alike -- comes through here, so the two
// cannot drift apart.
function paramsFromUi(v) {
  const p = {};
  for (const [k, c] of Object.entries(controls)) p[k] = c.val(v[k]);
  for (const id of PASS_IDS) p[id] = v[id];
  p.photoMode = v.photoMode;
  p.shotsPerStop = v.shotsPerStop;
  p.orbitRings = v.orbitRings;
  p.surroundRings = v.surroundRings;
  p.orbitHeights = v.orbitHeights ?? null;
  p.transectHeights = v.transectHeights ?? null;
  return p;
}

function readOuts() {
  for (const [k, c] of Object.entries(controls)) $(`${k}Out`).textContent = c.fmt(c.el.value);
  $('clearanceOut').textContent = `${(+$('clearance').value).toFixed(1)} m`;
  $('gsdHint').textContent = `${gsdCm(cam, +$('altitude').value).toFixed(2)} cm/px ground resolution`;
}

const clearance = () => +$('clearance').value;

/* ---------- what is on the ground ---------- */
const site = createSite({
  onChange: ({ replaced = false } = {}) => {
    if (!ready) return;
    renderPoints();
    computePlan();
    renderIdentity();
    showRecentre();
    if (!replaced) history.commit();
  },
});

// The obstacle list is global and synced, so it holds every box you have ever
// drawn -- including ones in another country. Only the ones this flight could
// reach have anything to do with this plan: without the filter a 21 m tree
// beside a church five hundred kilometres away became a subject of a plan in
// Krakow, got a dome of its own, and turned a twelve minute flight into four
// hundred and seventy-eight kilometres.
//
// Generous, because the surround ring stands well outside the footprint and a
// thing just past the edge is still something to fly around; nowhere near
// generous enough to reach the next town.
const NEARBY_M = 400;

// The wires near the site, as the strips the collision check understands.
//
// This is the only thing the flight is checked against now. The obstacles you
// used to draw and import are gone -- the survey is a better answer to "what
// is standing there" and js/scene3d.js shows the flight inside it -- but the
// survey provably cannot see a wire, so the register's wires are still checked
// as well as drawn. Drawing a hazard and not checking it would be the worst of
// the three options.
//
// Strips rather than boxes because a wire is a strip: one convex quad per
// straight run, span wide, at whatever angle the run happens to be. See
// spanQuads in js/lines.js.
function wireHazards() {
  const pts = site.capture();
  if (!pts.length || !wirePaths.length) return [];
  const lat0 = pts.reduce((t, q) => t + q.lat, 0) / pts.length;
  const box = {
    north: Math.max(...pts.map((q) => q.lat)) + NEARBY_M / mPerDegLat(lat0),
    south: Math.min(...pts.map((q) => q.lat)) - NEARBY_M / mPerDegLat(lat0),
    east: Math.max(...pts.map((q) => q.lon)) + NEARBY_M / mPerDegLon(lat0),
    west: Math.min(...pts.map((q) => q.lon)) - NEARBY_M / mPerDegLon(lat0),
  };
  const out = [];
  wirePaths.forEach((w, i) => {
    for (const rect of spanQuads(w.path, LINE_SPAN)) {
      if (!overlaps(rect, box)) continue;
      // Every strip of one run carries the RUN's id, so the check reports two
      // wires rather than twelve pieces of them -- see byObstacle in
      // js/collide.js, which exists for exactly this.
      out.push({ id: `wire${i}`, name: w.label, height: w.height, ...rect });
    }
  });
  return out;
}

// What the planner is given. No obstacles: it orbits the points you tapped and
// avoids nothing, which is where this is meant to be until avoidance comes off
// the survey. The wires are checked afterwards and reported, not flown around.
const siteForPlanner = () => ({
  points: site.capture(),
  shape: $('shape').value,
  obstacles: [],
});

/* ---------- placing and editing points ---------- */
// One kind of point. There were two -- capture and obstacle, in their own tabs
// -- and the split described nothing: both were a place with a height on it,
// and the only difference was what the planner did with them. Obstacles are
// gone (see js/site.js for why the survey replaced them), so this is what a
// tap makes and the only thing a tap makes.
const POINT_COLOUR = '#4da3ff';
const POINT_TIP = 'Tap the map on what you want captured. Tap a point to set how tall it is.';

// One tap, one point. Placing is the whole interaction: there is no
// arm-then-drag, because on a phone in a field the gesture you can rely on is
// a tap.
function placeAt(latlng) {
  if (site.capture().length >= MAX_CAPTURE_POINTS) {
    toast(`That is ${MAX_CAPTURE_POINTS} points — enough to describe anything this app can fly.`);
    return;
  }
  const added = site.addCapture({ lat: latlng.lat, lon: latlng.lng });
  if (added) state.selected = { id: added.id };
  renderPointBar();
}

// A double-click zooms, and Leaflet reports BOTH of its clicks as clicks -- so
// zooming in used to leave two stray points behind, on top of each other,
// exactly where you were trying to look more closely.
//
// So a tap waits to find out what it is. The delay is the price of keeping
// double-click zoom, and it is paid on every tap, which is why it is as short
// as it can be: long enough for the second click of a deliberate double, short
// enough that placing still feels like tapping.
const DOUBLE_CLICK_MS = 250;
let pendingTap = null;

map.on('click', (e) => {
  clearTimeout(pendingTap);
  const { latlng } = e;
  pendingTap = setTimeout(() => { pendingTap = null; placeAt(latlng); }, DOUBLE_CLICK_MS);
});
map.on('dblclick', () => { clearTimeout(pendingTap); pendingTap = null; });

// A point is a dot with the height you gave it written in it, because the
// height is the only thing a point carries and the only thing worth reading off
// the map without touching anything.
// Markers are kept and updated, not thrown away and rebuilt.
//
// Clearing the layer on every render is the simple version and it quietly
// breaks dragging: a render can land between picking a marker up and moving
// it, and the element the browser is tracking the drag against is gone,
// replaced by a fresh one that never heard about the gesture. Anything that
// touches the site re-renders -- placing a point, the score arriving, an
// obstacle syncing in from the phone -- so the window is not narrow.
//
// It also stops the marker under the cursor flickering on every replan.
const pointMarkers = new Map();
let draggingKey = null;


// Overhead lines on the map.
//
// They arrive as obstacle boxes like everything else, because that is what the
// collision check understands, and drawn that way they are twenty identical
// amber dots that look exactly like a row of trees. A wire is a line. Drawing
// it as one is the difference between the data being present and it being
// visible, and the whole reason to have gone and got it was to be able to see
// the thing you would otherwise fly into.
const WIRE_STYLE = {
  WN: { color: '#ff5d5d', weight: 3 },
  SN: { color: '#ff9c3d', weight: 2.5 },
  'n/n': { color: '#ffd85e', weight: 2 },
  LTK: { color: '#6aa9ff', weight: 1.5, dashArray: '4,4' },
};
const WIRES_KEY = 'dji.wires';

// Both views, from one list. The map gets polylines it can label; the survey
// gets the same vertices draped over the real ground at the height the voltage
// implies. Neither is the source of truth -- the register is -- so they are
// drawn from the same array and never from each other.
function drawWires() {
  layers.wires.clearLayers();
  if (wiresOn) {
    for (const w of wirePaths) {
      const style = WIRE_STYLE[w.kind] ?? { color: '#ff9c3d', weight: 2 };
      L.polyline(w.path.map((q) => [q.lat, q.lon]), {
        ...style, opacity: 0.95, interactive: true,
      }).bindTooltip(`${w.label} — assumed ${w.height} m`, { sticky: true })
        .addTo(layers.wires);
    }
  }
  lidar?.setWires(wiresOn ? wirePaths : []);
  $('wiresBtn').classList.toggle('on', wiresOn);
}

function rememberWires() {
  try {
    const keep = wirePaths.map((w) => ({ kind: w.kind, label: w.label, height: w.height,
      path: w.path.map((q) => [+q.lat.toFixed(6), +q.lon.toFixed(6)]) }));
    localStorage.setItem(WIRES_KEY, JSON.stringify(keep));
  } catch { /* a full or blocked store is not worth failing a fetch over */ }
}

// Kept between sessions, because a wire does not move and asking the register
// again for the same field is a round trip nobody needs.
function restoreWires() {
  try {
    const raw = JSON.parse(localStorage.getItem(WIRES_KEY) ?? '[]');
    if (!Array.isArray(raw)) return;
    wirePaths = raw.map((w) => ({ ...w, path: w.path.map(([lat, lon]) => ({ lat, lon })) }));
  } catch { /* nothing drawn is the right failure */ }
}

// Asking the register about what is on screen. Additive: pan somewhere new,
// press it again, and the field you were just looking at keeps its wires.
async function loadWires() {
  const btn = $('wiresBtn');
  btn.disabled = true;
  try {
    const { fetchLines } = await import('./lines.js');
    const b = map.getBounds();
    const got = await fetchLines({
      north: b.getNorth(), south: b.getSouth(), east: b.getEast(), west: b.getWest(),
    });
    if (got.reason && !got.paths.length) { toast(`No overhead lines — ${got.reason}.`); return; }
    // One entry per run of wire, and the same run asked for twice is the same
    // run: keyed on where it goes, since the register has no id for it.
    const seen = new Set(wirePaths.map((w) => JSON.stringify(w.path)));
    const fresh = got.paths.filter((w) => !seen.has(JSON.stringify(w.path)));
    wirePaths = [...wirePaths, ...fresh];
    rememberWires();
    drawWires();
    toast(fresh.length
      ? `${fresh.length} overhead line${fresh.length === 1 ? '' : 's'} here.`
      : 'No overhead lines mapped in this view.');
  } catch (e) {
    toast(`Overhead lines failed — ${e.message}`);
  } finally {
    btn.disabled = false;
  }
}

function renderPoints() {
  const wanted = new Set();
  for (const p of site.capture()) wanted.add(syncPoint('capture', p.id, p, p.height, false));

  for (const [key, m] of pointMarkers) {
    if (wanted.has(key)) continue;
    layers.points.removeLayer(m);
    pointMarkers.delete(key);
  }

  // The outline that would be flown, so "these ten taps" and "this shape" are
  // visibly the same thing. Drawn from the plan when there is one and from the
  // taps when there is not -- it is the cheap half, and it is the half you are
  // actually looking at while you place points.
  const shown = state.mission ?? measure();
  if (shown && shown.hull.length >= 3) {
    layers.footprint.setLatLngs(shown.hull.map((q) => {
      const ll = shown.frame.toLatLon(q.x, q.y);
      return [ll.lat, ll.lon];
    }));
    layers.footprint.addTo(map);
  } else {
    layers.footprint.remove();
  }
}

function syncPoint(kind, id, at, height, bad) {
  const key = `${kind}:${id}`;
  const on = state.selected?.kind === kind && state.selected?.id === id;
  const size = kind === 'capture' ? 24 : 22;
  const html = `<div class="pt ${kind}${on ? ' on' : ''}${bad ? ' strike' : ''}" `
    + `style="width:${size}px;height:${size}px">${Math.round(height)}</div>`;

  const existing = pointMarkers.get(key);
  if (existing) {
    // Never touch the one in hand: replacing its icon mid-gesture is exactly
    // what breaks the drag.
    if (draggingKey !== key) {
      const ll = existing.getLatLng();
      if (Math.abs(ll.lat - at.lat) > 1e-9 || Math.abs(ll.lng - at.lon) > 1e-9) {
        existing.setLatLng([at.lat, at.lon]);
      }
      if (existing._ptHtml !== html) {
        existing._ptHtml = html;
        existing.setIcon(L.divIcon({ className: '', html, iconSize: [size, size], iconAnchor: [size / 2, size / 2] }));
      }
    }
    return key;
  }

  const m = L.marker([at.lat, at.lon], {
    icon: L.divIcon({
      className: '',
      html,
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
    }),
    // They drag. You place them by eye against a photograph, and being able to
    // nudge one is the difference between a tap being a commitment and a tap
    // being a first guess.
    draggable: true,
  });
  m.on('click', (e) => {
    L.DomEvent.stopPropagation(e);
    state.selected = { id };
    renderPoints();
    renderPointBar();
  });
  m.addTo(layers.points);
  m._ptHtml = html;
  m.on('dragstart', () => {
    draggingKey = key;
    state.selected = { id };
    renderPointBar();
  });
  m.on('dragend', () => {
    draggingKey = null;
    const ll = m.getLatLng();
    site.moveCapture(id, ll.lat, ll.lng);
  });
  pointMarkers.set(key, m);
  return key;
}

function selectedPoint() {
  if (!state.selected) return null;
  const { id } = state.selected;
  const found = site.capture().find((x) => x.id === id);
  return found ? { id, item: found } : null;
}

function renderPointBar() {
  const sel = selectedPoint();
  $('pointbar').hidden = !sel;
  // Here and the bar both live at the bottom of the map; the stylesheet moves
  // Here up out of the way rather than letting them stack.
  $('stage').classList.toggle('editing', Boolean(sel));
  if (!sel) return;
  const list = site.capture();
  $('pointDot').className = 'pdot capture';
  $('pointName').textContent = `Point ${list.findIndex((x) => x.id === sel.id) + 1} of ${list.length}`;
  if (document.activeElement !== $('pHeight')) $('pHeight').value = String(sel.item.height);
}

function nudgeHeight(by) {
  const sel = selectedPoint();
  if (!sel) return;
  site.setCaptureHeight(sel.id, Math.max(0, Math.round((sel.item.height + by) * 10) / 10));
  renderPointBar();
}
$('pUp').addEventListener('click', () => nudgeHeight(1));
$('pDown').addEventListener('click', () => nudgeHeight(-1));
$('pHeight').addEventListener('change', () => {
  const sel = selectedPoint();
  const h = parseHeight($('pHeight').value);
  if (!sel) return;
  if (h === null) { $('pHeight').value = String(sel.item.height); return; }
  site.setCaptureHeight(sel.id, h);
});
$('pDelete').addEventListener('click', () => {
  const sel = selectedPoint();
  if (!sel) return;
  site.removeCapture(sel.id);
  state.selected = null;
  renderPointBar();
});
$('clearMode').addEventListener('click', () => {
  if (!site.capture().length) { toast('No points to clear.'); return; }
  site.clearCapture();
  state.selected = null;
  renderPointBar();
});

/* ---------- planning ---------- */
// Two very different costs hide behind "replan". Building the flight and
// measuring it against the obstacles is under a millisecond on a site of a few
// hundred waypoints; scoring the coverage is seventy, which is the difference
// between a tap that lands instantly and one that stutters. So the flight is
// rebuilt on every change and the score catches up a moment after you stop.
// Auto-fit searches altitudes and ring counts by planning dozens of trial
// missions -- a third of a second, which is fine once you stop tapping and
// unbearable per tap. It rides the same debounce as the score, and it stops the
// moment you touch a control: from then on the numbers are yours.
let tuned = false;
let settleTimer = null;
function settleSoon() {
  clearTimeout(settleTimer);
  settleTimer = setTimeout(() => {
    if (!state.mission) return;
    if (!tuned) autoFit();
    if (!state.mission) return;
    readTerrain();
    // Convex pieces, not whole solids: what blocks a camera is worked out by
    // clipping a ray against a convex thing, and an L is not one.
    const boxes = wireHazards().flatMap((o) => localPrisms(o, state.mission.frame));
    state.coverage = scoreCoverage(state.mission, { maxCameras: 220, boxes });
    // Tagged so a later replan can tell whether this score is still about the
    // flight on screen, rather than leaving yesterday's number sitting there.
    state.coverage.forWaypoints = state.mission.stats.waypoints;
    renderReadout();
    view3d.setMission(state.mission, state.coverage);
  }, 260);
}

// What the ground itself does under the site.
//
// A DJI mission holds one height above the point it took off from -- it knows
// nothing about the hill it is crossing. Flat ground makes that the same as
// height above the ground, and a slope makes it a lie: take off at the bottom
// of a Zakopane hillside, fly at "40 m", and you are ninety metres below the
// top of your own site.
//
// Sampled only when the site actually moves, because the answer is about the
// ground and the ground does not care that you changed the overlap.
let terrainKey = null;
async function readTerrain() {
  const pts = site.capture();
  if (!pts.length) { state.terrain = null; return; }
  const b = {
    north: Math.max(...pts.map((q) => q.lat)), south: Math.min(...pts.map((q) => q.lat)),
    east: Math.max(...pts.map((q) => q.lon)), west: Math.min(...pts.map((q) => q.lon)),
  };
  const key = [b.north, b.south, b.east, b.west].map((n) => n.toFixed(4)).join();
  if (key === terrainKey) return;
  terrainKey = key;
  try {
    state.terrain = await sampleTerrain(b);
  } catch {
    state.terrain = null;
  }
  renderReadout();
}

// The lowest altitude that fits a battery and DJI Fly's 200 waypoints, with the
// ring count the site's own height argues for. Without it the plan is whatever
// the raw defaults happen to be -- 40 m over a house is not a decision anyone
// made.
function autoFit() {
  let picked;
  try {
    picked = proposePlan(siteForPlanner(), paramsFromUi(uiValues()), cam);
  } catch {
    return;
  }
  const m = picked?.mission;
  if (!m) return;
  $('altitude').value = m.params.altitude;
  $('orbitRings').value = String(m.params.orbitRings);
  $('surround').checked = m.params.surround;
  $('photoMode').value = m.params.photoMode;
  state.fitNote = picked.note ?? null;
  computePlan();
}
$('refit').addEventListener('click', () => { tuned = false; autoFit(); toast('Re-fitted to the site.'); });

// The footprint, without planning anything. This is what the map draws while
// you tap, and what the readout can say for free.
function measure() {
  const points = site.capture();
  if (points.length < 3) return null;
  try {
    const f = frame(points.reduce((t, q) => t + q.lat, 0) / points.length,
                    points.reduce((t, q) => t + q.lon, 0) / points.length);
    const hull = footprintOf(points.map((q) => f.toLocal(q.lat, q.lon)), $('shape').value);
    return { frame: f, hull, areaHa: polygonArea(hull) / 10000 };
  } catch {
    return null;
  }
}

function computePlan() {
  readOuts();
  clearTimeout(settleTimer);
  const points = site.capture();
  if (!points.length) {
    state.mission = null;
    state.hazard = null;
  state.mesh = null;
    state.clearAlt = null;
    state.coverage = null;
    for (const g of [layers.path, layers.dots, layers.poses, layers.conflicts]) g.clearLayers();
    view3d.setMission(null);
    view3d.setObstacles([], []);
    renderPoints();
    renderReadout();
    writeUrl();
    return;
  }

  const p = paramsFromUi(uiValues());
  p.subjectClearance = clearance();
  const hazards = wireHazards();

  try {
    state.mission = planMission(siteForPlanner(), p, cam);
  } catch {
    state.mission = null;
    renderReadout();
    return;
  }

  // Two shapes of the same obstacles, for two jobs. The maths wants convex
  // pieces, because that is what makes the distance search exact; the eye wants
  // one solid per thing, because that is what a building is. See js/prism.js.
  const prisms = hazards.flatMap((o) => localPrisms(o, state.mission.frame));

  // Last score stays on screen only if it belongs to this many waypoints;
  // otherwise the tile says so until the new one lands.
  if (state.coverage?.forWaypoints !== state.mission.stats.waypoints) state.coverage = null;
  // No distances: nothing on screen says "clear by 18 m", and finding that out
  // for every obstacle that came nowhere near costs an exact measurement each
  // -- 600 ms of a replan with a city block imported. Grades, counts and
  // flagged legs all come from obstacles the flight did come near, which are
  // measured regardless. Turn it back on the day the readout wants the number.
  state.hazard = checkObstacles(state.mission, prisms,
    { clearance: clearance(), distances: false });
  state.clearAlt = (state.hazard.strikes || state.hazard.near)
    ? clearingAltitude(state.mission, prisms, { clearance: clearance() })
    : null;

  drawRoute();
  renderPoints();
  renderReadout();
  renderIdentity();
  if (state.onDevice) showDeviceRoute(null);
  view3d.setMission(state.mission, state.coverage);
  // Nothing solid to draw here any more, but the legs the check flagged are
  // still worth seeing over the flight.
  view3d.setObstacles([], state.hazard.legs);
  // Whichever surface is up gets the same flight. The survey view rebuilds the
  // path on every replan and the ground only when the frame moves.
  lidar?.setMission(state.mission, state.hazard);
  writeUrl();
  settleSoon();
}

// The route on the map, or not. The 3D view always gets it -- looking at the
// flight is the whole of that view's job -- so this is only about the map,
// where the flight sits on top of the thing you are tapping.
//
// The flagged legs go with it. They are drawn thicker than the route because
// they are the part of it you must not miss, which means that left behind on
// their own they read as the main feature rather than as a warning about a
// flight that is no longer on screen. The band still says how many there are
// and still offers the altitude that clears them, so nothing is hidden by
// hiding them -- only located.
function drawRoute() {
  if (showRoute && state.mission) {
    renderPath(state.mission);
    renderConflicts();
    return;
  }
  for (const g of [layers.path, layers.dots, layers.poses, layers.conflicts]) g.clearLayers();
}

function setShowRoute(on) {
  showRoute = on;
  try { localStorage.setItem(ROUTE_KEY, on ? '1' : '0'); } catch { /* private window */ }
  $('routeToggle').classList.toggle('on', on);
  $('routeToggle').title = on ? 'Hide the flight on the map' : 'Show the flight on the map';
  drawRoute();
}
$('routeToggle').addEventListener('click', () => setShowRoute(!showRoute));

function renderConflicts() {
  layers.conflicts.clearLayers();
  for (const leg of state.hazard?.legs ?? []) {
    L.polyline([[leg.a.lat, leg.a.lon], [leg.b.lat, leg.b.lon]], {
      color: LEG_COLOR[leg.grade], weight: 4, opacity: 0.9, interactive: false,
    }).addTo(layers.conflicts);
  }
}

const mmss = (s) => {
  const t = Math.round(s);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};

// Four numbers, because a plan is four questions: is it worth flying, will it
// fit a battery, how sharp is it, and does it see everything.
function renderReadout() {
  const box = $('readout');
  const m = state.mission;
  if (!m) {
    box.className = 'readout empty';
    box.innerHTML = '';
    box.textContent = site.capture().length
      ? 'Enable at least one pass in Advanced.'
      : 'Tap the map on what you want captured.';
    $('alert').hidden = true;
    renderPasses();
    return;
  }
  const s = m.stats;
  const over = s.waypoints > DJI_FLY_MAX_WAYPOINTS;
  // The scorer grades every surface and reports each grade as a percentage
  // already, so these are added, not scaled: what is left after the unseen and
  // the thinly-seen have been taken off.
  const sum = state.coverage?.summary;
  const cov = sum ? Math.round(sum.good + sum.flat) : null;
  const covText = cov === null ? '…' : `${cov}%`;
  box.className = 'readout';
  box.innerHTML = `
    <div><b>${s.photos}</b><span>photos</span></div>
    <div><b class="${over ? 'bad' : ''}">${s.waypoints}</b><span>waypoints</span></div>
    <div><b>${mmss(s.seconds)}</b><span>${s.batteries > 1 ? `${s.batteries} batteries` : 'flight'}</span></div>
    <div><b class="${cov === null ? 'dim' : cov < 90 ? 'bad' : 'ok'}">${covText}</b><span>coverage</span></div>`;
  renderPasses();
  renderAlert(over);
}

// What is wrong with this plan, worst first, and the one thing to do about it.
//
// This was seven producers appending fragments into one <div>: no separators,
// so a button ran into the next sentence; no order, so "the flight hits 2
// obstacles" could sit below a note about waypoint counts; and up to THREE
// buttons all saying "Raise to N m" with different Ns. What it printed for a
// low flight over flat ground was
//
//   ...less than your 16 m clearance. Raise to 16 mAuto-fitted: 5 m, 3 rings
//
// which is two answers of ours contradicting each other with no space between
// them. So: findings are collected with a rank, sorted, and given a line each;
// every "raise to" is collected too and becomes ONE button at the highest of
// them, because clearing the tallest requirement clears the rest.
const RANK = {
  strike: 0,        // it hits something
  ground: 1,        // it is under the hill it crosses
  unseen: 2,        // the survey sees something above it, mapped or not
  clearance: 3,     // above things, closer than you asked
  near: 4,
  assumed: 5,       // it is measured against guesses
  incomplete: 6,    // we do not know yet
  export: 7,        // it will not fit DJI Fly in one piece
  fit: 8,           // what auto-fit chose, which is not a problem
};

function renderAlert(over) {
  const el = $('alert');
  const found = [];
  const raises = [];
  const say = (rank, text) => found.push({ rank: RANK[rank], rank_: rank, text });
  const raiseTo = (m) => { if (Number.isFinite(m) && m > +$('altitude').value) raises.push(Math.ceil(m)); };

  const h = state.hazard;
  if (h?.strikes) {
    say('strike', h.strikes === 1 ? 'The flight goes through an overhead line.'
      : `The flight goes through ${h.strikes} overhead lines.`);
  }
  else if (h?.near) {
    say('near', h.near === 1 ? 'One leg passes closer than your clearance.'
      : `${h.near} legs pass closer than your clearance.`);
  }
  if (state.clearAlt) raiseTo(state.clearAlt);

  // The ground first among the real hazards, because it is the one that puts
  // the aircraft into a hill rather than into something standing on it.
  const t = state.terrain && state.mission
    ? terrainVerdict(state.terrain, {
      takeoffAt: state.terrain.samples[0]?.h,
      altitude: state.mission.params.altitude,
      clearance: clearance(),
    })
    : null;
  const alt = state.mission?.params.altitude;

  // The mesh, when there is one: real geometry, so a leg that flies INTO a
  // building is a fact rather than an inference. Ranked above everything except
  // an overhead line, because a facade is not a guess.
  const mesh = state.mesh;
  if (mesh?.hits) {
    // Raising the altitude does NOT clear these, and saying otherwise would be
    // the worst kind of wrong. Measured over Cybulskiego: 27 m and 40 m both
    // leave 25 legs through buildings, because ring heights are FRACTIONS of
    // the altitude -- the lowest orbit ring sits near a quarter of it -- so
    // clearing 24 m of building that way needs about 165 m, past the 120 m the
    // readout will ever offer. The lever is the ring height, not the altitude.
    say('strike', `${mesh.hits === 1 ? 'One leg flies' : `${mesh.hits} legs fly`} into `
      + 'buildings the mesh has measured. Raising the altitude will not clear it — the low '
      + 'rings scale with it, so lift the rings themselves.');
  }
  if (mesh?.tallest !== null && mesh?.tallest !== undefined) {
    const need = mesh.tallest + clearance();
    // Two different sentences, because "24 m tall, 13 m above your altitude"
    // was neither: 13 was how far short of the CLEARANCE the flight was, and
    // attaching it to the thing said it stood 13 m over an aircraft it was
    // actually 3 m under. Say the gap, and say what it is short of.
    const spare = alt - mesh.tallest;
    if (spare < 0) {
      say('ground', `At ${alt} m the flight is ${(-spare).toFixed(0)} m BELOW something the `
        + `mesh measures at ${mesh.tallest.toFixed(0)} m.`);
    } else if (need > alt) {
      say('clearance', `The tallest thing the mesh measured under this flight is `
        + `${mesh.tallest.toFixed(0)} m. At ${alt} m you pass ${spare.toFixed(0)} m over it, `
        + `which is less than your ${clearance()} m clearance.`);
    }
    raiseTo(need);
  }
  // Only part of the flight is over ground that has been fetched, and the rest
  // is unchecked -- which is not the same as clear.
  if (mesh && mesh.over < mesh.of) {
    say('incomplete', `The mesh covers ${mesh.over} of ${mesh.of} waypoints; `
      + 'click the blue squares in the 3D view to check the rest.');
  }

  if (t && t.shortfall > 0) {
    const above = t.aboveHighestGround;
    const relief = t.relief >= 1 ? `The ground rises ${t.relief.toFixed(0)} m across this site, and ` : '';
    // Two different problems produce a shortfall and telling someone the wrong
    // one is worse than saying nothing. Below the highest ground means flying
    // into a hill; above it but inside the clearance means passing closer than
    // you asked to.
    if (above < 0) {
      say('ground', `${relief}at ${alt} m the flight is ${(-above).toFixed(0)} m BELOW the highest ground.`);
    } else {
      say('clearance', `${relief}at ${alt} m the flight clears the highest ground by `
        + `${above.toFixed(0)} m — less than the ${clearance()} m you asked for.`);
    }
    raiseTo(t.needed);
  } else if (t && t.relief > 5) {
    say('incomplete', `The ground rises ${t.relief.toFixed(0)} m across the site; `
      + `${t.aboveHighestGround.toFixed(0)} m clear of the highest of it.`);
  }

  // What the survey saw, which is everything standing and not only what was
  // mapped. Never lowers an altitude and never claims completeness: an unbuilt
  // tile and a cell the laser missed are both unknowns, and an unknown ceiling
  // is not a zero one.
  const sv = state.survey;
  if (sv && sv.height !== null) {
    const need = sv.height + clearance();
    const caveat = sv.missing
      ? ` ${sv.missing} of ${sv.tiles} tiles are not built, so this is not the whole picture.`
      : '';
    if (need > alt) {
      // Same correction as the mesh finding above: the number was the shortfall
      // against the clearance, and the sentence claimed it was the height of
      // the thing over the aircraft.
      const spare = alt - sv.height;
      if (spare < 0) {
        say('ground', `At ${alt} m the flight is ${(-spare).toFixed(0)} m BELOW something the `
          + `survey sees at ${sv.height} m, mapped or not.${caveat}`);
      } else {
        say('unseen', `The survey sees something ${sv.height} m tall under this flight, mapped `
          + `or not. At ${alt} m you pass ${spare.toFixed(0)} m over it, which is less than `
          + `your ${clearance()} m clearance.${caveat}`);
      }
      raiseTo(need);
    } else {
      say('incomplete', `The survey's tallest thing under this flight is ${sv.height} m; `
        + `you clear it by ${(alt - sv.height).toFixed(0)} m.${caveat}`);
    }
  } else if (sv && sv.missing) {
    say('incomplete', `The survey has not answered for ${sv.missing} of ${sv.tiles} tiles under `
      + 'this flight, so nothing here is measured yet.');
  }

  if (wiresOn && wirePaths.length) {
    say('assumed', 'Wire heights are the ones their voltage implies, never measured — '
      + 'check anything the flight passes close to.');
  }

  if (over) {
    say('export', `${state.mission.stats.waypoints} waypoints exports as `
      + `${Math.ceil(state.mission.stats.waypoints / DJI_FLY_MAX_WAYPOINTS)} parts.`);
  }

  if (!tuned && state.mission) {
    say('fit', `Auto-fitted: ${alt} m, ${state.mission.params.orbitRings} `
      + `ring${state.mission.params.orbitRings === 1 ? '' : 's'} per thing.`);
  }

  el.hidden = !found.length;
  el.textContent = '';
  if (!found.length) return;

  found.sort((a, b) => a.rank - b.rank);
  // The worst finding sets the colour of the box: a strike is not a warning and
  // a note about what auto-fit chose is not either.
  const worst = found[0].rank_;
  el.className = `alert ${worst === 'strike' || worst === 'ground' ? ''
    : worst === 'fit' || worst === 'incomplete' || worst === 'export' ? 'note' : 'warn'}`;

  for (const f of found) {
    const line = document.createElement('div');
    line.className = f.rank_ === 'fit' ? 'fitnote' : '';
    line.textContent = f.text;
    el.append(line);
  }

  // One action, and when the mesh has found a facade it is THIS one rather than
  // a raise -- because raising cannot clear a facade and lifting the rings can.
  // Offered ahead of the raise for the same reason the finding is ranked above
  // it: it is the fix that works.
  const fit = mesh?.hits ? lidar?.fitRings(clearance()) : null;
  if (fit?.changed) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = 'Lift the rings clear of the mesh';
    b.addEventListener('click', () => {
      tuned = true;
      pinned.orbitHeights = fit.to;
      computePlan();
      history.commit();
    });
    el.append(b);
    const note = document.createElement('div');
    note.className = 'fitnote';
    // What it will do, before it does it -- and what it costs. Rings that all
    // circle the same courtyard all have to clear the same roofline, so they
    // land within a metre of each other and the vertical parallax that three
    // rings exist for is gone. That is the clearance talking, not the fitter:
    // at 15 m nothing can be tight beside a 24 m building.
    const spread = Math.max(...fit.to) - Math.min(...fit.to);
    note.textContent = `${fit.rings.map((h, i) => (fit.to[i] > h + 0.05
      ? `${h.toFixed(0)}→${fit.to[i].toFixed(0)} m`
      : `${h.toFixed(0)} m stays`)).join(', ')}`
      + (fit.to.length > 1 && spread < 3
        ? ` · they end up within ${spread.toFixed(1)} m of each other, so the rings stop `
          + `buying different viewpoints — lower the ${clearance()} m clearance to stay tighter`
        : '')
      + (fit.skipped ? ` · ${fit.skipped} waypoints over ground not fetched, so not judged` : '');
    el.append(note);
    return;
  }

  // One action. Raising to the tallest requirement satisfies the shorter ones,
  // and three buttons with three numbers is a puzzle rather than a fix.
  if (raises.length) {
    const to = Math.min(120, Math.max(...raises));
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = `Raise to ${to} m`;
    b.addEventListener('click', () => {
      tuned = true;
      $('altitude').value = to;
      computePlan();
      history.commit();
    });
    el.append(b);
  }
}

function renderPasses() {
  const box = $('passList');
  box.innerHTML = '';
  for (const p of state.mission?.passes ?? []) {
    const colour = passColour(p.name);
    const row = document.createElement('div');
    row.className = 'passrow';
    row.innerHTML = `<span class="sw" style="background:${colour}"></span><b></b><em></em><span class="cnt"></span>`;
    row.querySelector('b').textContent = p.name;
    row.querySelector('em').textContent = p.detail;
    row.querySelector('.cnt').textContent = p.count;
    box.append(row);
  }
  $('sizeHint').textContent = state.mission
    ? `${state.mission.sizeX.toFixed(0)} × ${state.mission.sizeY.toFixed(0)} m bounding box · `
      + `${state.mission.stats.areaHa.toFixed(2)} ha footprint · ${state.mission.stats.distanceM.toFixed(0)} m of flying`
    : '';
  const rep = $('obsReport');
  rep.hidden = !state.hazard?.obstacles?.some((o) => o.grade !== 'clear');
  if (!rep.hidden) {
    rep.textContent = state.hazard.obstacles.filter((o) => o.grade !== 'clear')
      .map((o) => `${o.grade === 'strike' ? 'Hits' : 'Passes close to'} a ${o.height} m obstacle.`).join(' ');
  }
}

/* ---------- drawing a route ---------- */
const PLAN_GROUPS = () => ({ path: layers.path, dots: layers.dots, poses: layers.poses });
const DEVICE_GROUPS = () => ({ path: layers.devicePath, dots: layers.deviceDots, poses: layers.devicePoses });

function renderPath(m, { groups = PLAN_GROUPS(), dashed = false } = {}) {
  groups.path.clearLayers();
  groups.dots.clearLayers();
  let run = [];
  let runPass = null;
  const flush = () => {
    if (run.length > 1) {
      if (dashed) {
        L.polyline(run, { color: '#12181f', weight: 4.5, opacity: 0.5, interactive: false }).addTo(groups.path);
      }
      L.polyline(run, {
        color: PASS_COLOR[runPass], weight: 2, opacity: dashed ? 1 : 0.85,
        dashArray: dashed ? '5,4' : null, interactive: false,
      }).addTo(groups.path);
    }
  };
  for (const w of m.waypoints) {
    if (w.pass !== runPass) { flush(); run = run.length ? [run[run.length - 1]] : []; runPass = w.pass; }
    run.push([w.lat, w.lon]);
  }
  flush();

  // Which way each camera looks. Length encodes tilt: a nadir shot is a stub,
  // a horizontal shot is a full tick.
  groups.poses.clearLayers();
  const poseStep = Math.max(1, Math.ceil(m.waypoints.length / 120));
  m.waypoints.forEach((w, i) => {
    if (i % poseStep) return;
    const lead = 6 + 16 * Math.cos((w.pitch * Math.PI) / 180);
    const yaw = ((w.yaw ?? 0) * Math.PI) / 180;
    const p0 = map.latLngToLayerPoint([w.lat, w.lon]);
    const end = map.layerPointToLatLng(L.point(p0.x + Math.sin(yaw) * lead, p0.y - Math.cos(yaw) * lead));
    L.polyline([[w.lat, w.lon], end], {
      color: PASS_COLOR[w.pass], weight: 1.2, opacity: 0.75, interactive: false,
    }).addTo(groups.poses);
  });

  const step = Math.max(1, Math.ceil(m.waypoints.length / 400));   // keep the map responsive
  m.waypoints.forEach((w, i) => {
    if (i % step) return;
    L.marker([w.lat, w.lon], {
      icon: L.divIcon({ className: 'wpdot', iconSize: [5, 5] }), interactive: false,
    }).addTo(groups.dots)._icon.style.background = PASS_COLOR[w.pass];
  });

  L.circleMarker([m.waypoints[0].lat, m.waypoints[0].lon],
    { radius: 6, color: dashed ? '#12181f' : '#fff', weight: 2,
      fillColor: PASS_COLOR[m.waypoints[0].pass], fillOpacity: 1 })
    .addTo(groups.path).bindTooltip(dashed ? 'On the controller' : 'Start');
}

// The one "other route" channel: a mission read off the controller, or a saved
// plan being looked at before it is installed. Dashed, next to yours, one at a
// time, and any replan takes it back down.
function showDeviceRoute(src) {
  for (const g of Object.values(DEVICE_GROUPS())) g.clearLayers();
  state.onDevice = !src ? null : src.kind === 'device' ? routeFromRead(src.read, cam) : src.mission;
  if (!state.onDevice) {
    view3d.setMission(state.mission, state.coverage);
    view3d.setObstacles([], state.hazard?.legs ?? []);
    return;
  }
  renderPath(state.onDevice, { groups: DEVICE_GROUPS(), dashed: true });
  view3d.setMission(state.onDevice, null);
  // Ungraded: every grade on screen belongs to the plan, and colouring someone
  // else's route with the plan's verdict would be a lie in the most expensive
  // possible place.
  view3d.setObstacles([], []);
  map.fitBounds(L.latLngBounds(state.onDevice.waypoints.map((w) => [w.lat, w.lon])),
    { padding: [40, 40], maxZoom: 21 });
}

/* ---------- export ---------- */
function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID().toUpperCase();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  }).toUpperCase();
}

// The file name is a UUID because that is what DJI Fly wants it renamed to
// anyway -- one less thing to get wrong at the controller.
function downloadKmz(mission, profile) {
  const parts = splitMission(mission);
  parts.forEach((part, i) => {
    const bytes = buildKmz(part, profile);
    const name = parts.length > 1 ? `${uuid()}_part${i + 1}of${parts.length}.kmz` : `${uuid()}.kmz`;
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.google-earth.kmz' }));
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  });
  return parts.length;
}

function partsFromMission(mission, profile, label) {
  const all = splitMission(mission);
  return all.map((part, i) => ({
    name: all.length > 1 ? `${label} — part ${i + 1} of ${all.length}` : label,
    waypoints: part.exported.length,
    detail: `${part.params.altitude} m · ${part.passes.length} passes`,
    bytes: buildKmz(part, profile),
  }));
}

function missionFromCode(code) {
  const plan = decodePlan(code);
  if (!plan) return null;
  try {
    return { plan, mission: planMission({ points: plan.points, shape: plan.shape }, paramsFromUi(plan.ui), cam) };
  } catch {
    return null;
  }
}

$('exportKmz').addEventListener('click', () => {
  if (!state.mission) computePlan();
  if (!state.mission) { toast('Tap some capture points first.'); return; }
  const n = downloadKmz(state.mission, $('profile').value);
  toast(`Exported ${n} file${n === 1 ? '' : 's'}.`);
});

/* ---------- the sheet ---------- */
const SHEETS = {
  adv: 'Advanced',
  saved: 'Plans',
  device: 'Fly it',
};
let openSheet = null;

function showSheet(name) {
  openSheet = name;
  $('sheetTitle').textContent = SHEETS[name] ?? '';
  for (const k of Object.keys(SHEETS)) $(`pane-${k}`).hidden = k !== name;
  $('sheet').hidden = false;
  $('scrim').hidden = false;
  if (name === 'device') bridge.refresh();
}
function closeSheet() {
  openSheet = null;
  $('sheet').hidden = true;
  $('scrim').hidden = true;
}
$('openAdv').addEventListener('click', () => showSheet('adv'));
$('openSaved').addEventListener('click', () => showSheet('saved'));
$('openDevice').addEventListener('click', () => showSheet('device'));
$('sheetClose').addEventListener('click', closeSheet);
$('scrim').addEventListener('click', closeSheet);
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && openSheet) closeSheet(); });

/* ---------- toast ---------- */
let toastTimer = null;
function toast(text, { sticky = false } = {}) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  if (!sticky) toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

/* ---------- where you are ---------- */
function showFix({ lat, lon, accuracy, age }) {
  layers.gps.clearLayers();
  L.circle([lat, lon], {
    radius: Math.max(accuracy, 1), color: '#4da3ff', weight: 1, fillOpacity: 0.08, interactive: false,
  }).addTo(layers.gps);
  L.marker([lat, lon], {
    icon: L.divIcon({ className: 'gpsdot', iconSize: [12, 12] }), interactive: false,
  }).addTo(layers.gps)
    .bindTooltip(`±${accuracy.toFixed(0)} m · ${age < 1000 ? 'live' : `${(age / 1000).toFixed(0)} s old`}`);
}

// Keep however far in you are already looking, unless that is further out than
// a person is worth drawing at. Never animated -- see readUrl.
const goToFix = ({ lat, lon }) => map.setView([lat, lon], Math.max(map.getZoom(), 20), { animate: false });

let finding = false;
async function findMe({ quiet = false } = {}) {
  // Locating takes a moment and a second press cannot make it faster, so say
  // that rather than swallowing the tap and looking broken.
  if (finding) { toast('Still looking for a position…'); return null; }
  finding = true;
  $('findme').classList.add('busy');
  try {
    if (!quiet) toast('Asking your device where you are…', { sticky: true });
    const fix = await bestFix({
      onProgress: (f) => { if (!quiet) toast(`±${f.accuracy.toFixed(0)} m so far…`, { sticky: true }); },
    });
    showFix(fix);
    goToFix(fix);
    if (quiet) toast(`Map centred where you are (±${fix.accuracy.toFixed(0)} m).`);
    else toast(`You are here — ±${fix.accuracy.toFixed(0)} m`
      + `${fix.age > STALE_MS ? `, from a fix ${Math.round(fix.age / 60000)} min old` : ''}.`);
    return fix;
  } catch (err) {
    if (!quiet) toast(GPS_ERRORS[err.code] ?? `Could not locate you: ${err.message}`);
    return null;
  } finally {
    finding = false;
    $('findme').classList.remove('busy');
  }
}
$('findme').addEventListener('click', () => findMe());

// Drag a level in the 3D view to move that ring up or down.
//
// This is the answer to "how do I stop the flight going through that building",
// and altitude is not: ring heights are FRACTIONS of the altitude, so raising
// it lifts the low rings proportionally and they never overtake a roof.
// Measured over Cybulskiego, 27 m and 40 m both leave 25 legs through
// buildings. The height of one ring is the lever, and this is the handle on it.
//
// Every part of this existed and none of it was connected: js/view3d.js draws
// the grips and reports the drag, js/share.js carries the result in the plan
// code, js/planner.js accepts pinned heights and reports the ones it used.
// `onLevelChange` was simply never called, so the grips were never drawn.
//
// A drag fires this continuously, and each call replans -- which is what every
// slider here already does on every tick, and what makes the flight follow your
// finger. The undo entry is committed at the end of the gesture, not during it,
// or one drag would leave forty steps to undo.
function moveLevel(handles, z) {
  for (const h of handles) {
    // The altitude level is the altitude knob, not a pinned list. Dragging the
    // grid height IS dragging the altitude slider, and it has to move with it
    // or the two would disagree about the same number.
    if (h.kind === 'altitude') {
      tuned = true;
      $('altitude').value = String(Math.round(Math.max(2, Math.min(120, z))));
      readOuts();
      continue;
    }
    const key = h.kind === 'orbit' ? 'orbitHeights' : 'transectHeights';
    // What the plan actually flew is the base to edit: the spread comes from
    // the ring count until somebody pins one, and after that the pinned list
    // is the truth.
    const base = pinned[key] ?? state.mission?.heights?.[h.kind];
    if (!base?.length || h.index >= base.length) continue;
    const list = [...base];
    list[h.index] = z;
    pinned[key] = list;
  }
  computePlan();
}

// One behaviour, both views. The flat view drags a level on its own canvas and
// the survey view drags a chip over the mesh; they hand back the same handles,
// so there is one place that decides what a dragged height means.
view3d.onLevelChange(moveLevel);
view3d.onLevelDone(() => history.commit());

// Nothing, a photograph, or the survey. Same kind of choice as the basemap
// picker it sits under, so it is the same kind of control.
for (const b of document.querySelectorAll('#groundtabs button')) {
  b.addEventListener('click', () => setGround(b.dataset.ground));
}

// The two views are not tied together, on purpose: you pan the map to find the
// next thing while the 3D stays on what you are working on. These are how you
// tie them when you want to, one button per direction.
//
// They meet in the middle rather than sharing a camera. The map speaks lat/lon
// and a zoom; a 3D view speaks local metres and a camera distance. Neither
// converts to the other, so both answer "where are you looking, and how much of
// the ground is in shot" -- a centre and a span -- and that is the whole of it.
const active3d = () => (groundMode === 'survey' ? lidar : view3d);

// How wide the map is showing, in metres of ground across the pane.
function mapSpanM() {
  const b = map.getBounds();
  const mid = (b.getNorth() + b.getSouth()) / 2;
  return Math.max(20, (b.getEast() - b.getWest()) * mPerDegLon(mid));
}

$('syncTo3d').addEventListener('click', () => {
  const v = active3d();
  if (!v?.lookAt) { toast('Nothing in the 3D view to point yet.'); return; }
  const c = map.getCenter();
  v.lookAt({ lat: c.lat, lon: c.lng, spanM: mapSpanM() });
  toast('The 3D view is looking where the map is.');
});

$('syncToMap').addEventListener('click', () => {
  const at = active3d()?.where?.();
  if (!at) { toast('Tap out a site first — there is nothing to line up on.'); return; }
  // A span back to a zoom: the level whose ground-per-pixel fills the pane
  // with that much ground. Never past 21, which is as far as the imagery goes.
  const px = Math.max(200, $('map').clientWidth || 800);
  let z = 21;
  while (z > 3 && mPerPx(at.lat, z) * px < at.spanM) z -= 1;
  map.setView([at.lat, at.lon], z, { animate: false });
  toast('The map is looking where the 3D view is.');
});

// Overhead lines: on, and fetch any this view has not asked about yet. The
// register is the only source for them, so the switch does the asking too --
// there is nothing else to turn on.
// The three buttons in Advanced. Their handlers were deleted as collateral in
// daa56de, which took out the service chooser and took these with it -- and
// left the buttons in index.html, so all three sat there looking live and did
// nothing. #surveyFit was the worse one: renderAlert still reads state.survey,
// so the survey ceiling could never appear in the readout either, and a
// clearance the app was able to measure silently stopped being measured.

// Is the service answering. Its two failure modes look identical from here --
// nothing running, and a tunnel that is down -- and one round trip to
// /v1/health tells them apart. The only request in the app nobody has to make.
{
  const say = (text) => { $('serviceHint').textContent = text; };
  say(`Talking to ${serviceUrl()}. Heights, overhead lines, the 3D model and`
    + ' syncing your plans all go there.');

  $('servicePing').addEventListener('click', async () => {
    const url = serviceUrl();
    $('servicePing').disabled = true;
    say(`Asking ${url}…`);
    try {
      const res = await fetch(`${url}/v1/health`, { headers: serviceHeaders() });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { say(`${url} answered ${res.status}.`); return; }
      const busy = (body.building ?? 0) + (body.queued ?? 0);
      say(`${url} is answering${busy ? `, building ${busy} tile${busy === 1 ? '' : 's'}` : ''}.`
        + ` Survey grid ${body.tileMetres ?? '?'} m.`);
    } catch (e) {
      // The address is in the message because that is the half you cannot see.
      say(`${url} did not answer — ${e.message}.`);
    } finally {
      $('servicePing').disabled = false;
    }
  });
}

// What the survey sees, which is everything standing and not only what was
// mapped. `measure` corrects the height of something OpenStreetMap already
// knew about; it can say nothing at all about a line of poplars, a pole or a
// crane. The raster saw all of it, so the honest ceiling for a flight is the
// tallest measured cell anywhere under it -- the number that decides whether
// one barometric altitude is safe.
//
// On demand rather than on every replan: the first tile under a new site is a
// couple of minutes and hundreds of megabytes, and spending that because
// somebody nudged a slider would be rude to a public agency and to the user.
{
  const btn = $('surveyFit');
  btn.addEventListener('click', async () => {
    if (!state.mission) { toast('Tap out a site to fly first.'); return; }
    const path = state.mission.exported ?? state.mission.waypoints ?? [];
    if (!path.length) { toast('Nothing planned yet.'); return; }
    // The area the aircraft actually crosses, which is what its altitude has
    // to clear -- not the points you tapped.
    const bounds = {
      north: Math.max(...path.map((w) => w.lat)), south: Math.min(...path.map((w) => w.lat)),
      east: Math.max(...path.map((w) => w.lon)), west: Math.min(...path.map((w) => w.lon)),
    };
    btn.disabled = true;
    const was = btn.textContent;
    try {
      const { surveyCeiling } = await import('./heights.js');
      state.survey = await surveyCeiling(bounds, {
        onWait: () => toast('First look at this ground — downloading the survey. A few minutes.'),
        onProgress: (d, n) => { btn.textContent = `Reading the survey… ${d}/${n}`; },
      });
      renderAlert(false);
      const c = state.survey;
      if (c.height === null) toast(c.reason ? `No survey here: ${c.reason}.` : 'The survey has not answered yet.');
      else toast(`Tallest thing under this flight: ${c.height} m.`);
    } finally {
      btn.disabled = false;
      btn.textContent = was;
    }
  });
}

// The service's own viewer, for looking at rather than planning with. It builds
// the model from the same survey the heights come from and serves the page
// itself, so this is a link and nothing more -- no state, no effect on the
// plan. Worth keeping now that the survey view draws the same ground with the
// flight in it: this is the one picture with nothing of ours in front of it, so
// it is what you compare against when the survey view looks wrong.
{
  $('scene3d').addEventListener('click', () => {
    const c = map.getCenter();
    // The centre of the map, not the site: the model is a 500 m square of
    // ground and you aim it by looking at where you are aiming.
    window.open(`${serviceUrl()}/scene?lat=${c.lat.toFixed(6)}&lon=${c.lng.toFixed(6)}`,
      '_blank', 'noopener');
  });
}

// Which way every lens is facing, drawn in the space it faces into. One line
// of state, because the picture is built from the plan the view already has --
// yaw and pitch are resolved by the planner for every heading mode, so there is
// nothing to fetch and nothing to keep in step.
function setLooks(on) {
  looksOn = on;
  lidar?.setLooks(looksOn);
  $('looksBtn').classList.toggle('on', looksOn);
}
$('looksBtn').addEventListener('click', () => { setLooks(!looksOn); writeUrl(); });

$('wiresBtn').addEventListener('click', async () => {
  wiresOn = !wiresOn;
  drawWires();
  writeUrl();
  if (wiresOn) await loadWires();
});

// The button over the map is obstacle mode's, and it asks OpenStreetMap about
// the view rather than the receiver. Capture mode had one beside it that placed
// a point where the phone said you were standing; it is gone, and with it the
// live accuracy readout, whose whole job was telling you whether that button
// was about to refuse your fix.

/* ---------- the controller ---------- */
const bridge = initInstall({
  badge: (text, kind) => { $('deviceTag').textContent = text; $('deviceTag').className = `tag ${kind}`; },
  showRoute: showDeviceRoute,
  planRoute: (saved) => missionFromCode(saved.code)?.mission ?? null,
  savedPlans: () => plans.list(),
  partsForPlan: (saved) => {
    const built = missionFromCode(saved.code);
    if (!built) return null;
    return partsFromMission(built.mission, built.plan.ui.profile ?? $('profile').value, saved.name);
  },
});

/* ---------- the library ---------- */
let session = { id: null, name: null, code: null };

const planCode = () => (site.capture().length ? encodePlan(siteForPlanner(), uiValues()) : null);
const dirty = () => Boolean(planCode()) && planCode() !== session.code;

// The tip teaches the one gesture there is, and stops once you have used it:
// the band is a third of a phone screen, and a sentence you have already read
// is the first thing that should give its rows back to the map.
function showTip() {
  $('tip').hidden = site.capture().length > 0;
}

function renderIdentity() {
  showTip();
  $('planTitle').textContent = session.name ?? 'New plan';
  $('planTitle').classList.toggle('dirty', dirty());
}

function applyPlan(plan) {
  applyUiValues(plan.ui);
  if (plan.shape) $('shape').value = plan.shape;
  site.setCapture(plan.points);
  renderPoints();
  computePlan();
  if (state.mission) {
    map.fitBounds(L.latLngBounds(plan.points.map((p) => [p.lat, p.lon])).pad(0.6),
      { animate: false, maxZoom: 21 });
  }
  history.commit();
}

const plans = initPlans({
  onChange: () => { bridge.plansChanged(); renderIdentity(); },
  setCount: (n) => { $('savedTag').textContent = n || ''; },
  onLoaded: (p) => {
    session = { id: p.id, name: p.name, code: planCode() };
    $('planName').value = p.name;
    renderIdentity();
    closeSheet();
  },
  onDeleted: (id) => { if (session.id === id) session = { ...session, id: null }; renderIdentity(); },
  applyCode: (code) => {
    const plan = decodePlan(code);
    if (plan) applyPlan(plan);
    return Boolean(plan);
  },
  exportPlan: (code) => {
    const built = missionFromCode(code);
    if (!built) return 0;
    return downloadKmz(built.mission, built.plan.ui.profile ?? $('profile').value);
  },
});

function savePlan() {
  const code = planCode();
  if (!code) { toast('Tap some capture points first — there is no plan to save.'); return; }
  const name = $('planName').value.trim() || session.name || describeSite() || 'Untitled plan';
  const saved = plans.save({ id: session.id, name, code });
  session = { id: saved.id, name: saved.name, code };
  plans.select(saved.id);
  $('planName').value = saved.name;
  renderIdentity();
  toast(`Saved “${saved.name}”.`);
}
$('savePlan').addEventListener('click', () => { savePlan(); });
$('planSave').addEventListener('click', () => { savePlan(); closeSheet(); });
$('planTitle').addEventListener('click', () => showSheet('saved'));

// A plan nobody named is still worth finding again: say where and how big.
function describeSite() {
  const size = measure();
  const first = site.capture()[0];
  if (!first) return null;
  return `${size ? `${size.areaHa.toFixed(2)} ha` : `${site.capture().length} points`}`
    + ` at ${first.lat.toFixed(4)}, ${first.lon.toFixed(4)}`;
}

/* ---------- undo ---------- */
// The taps, the obstacles and the control values. Everything else -- the
// waypoints, the coverage, the verdict -- is derived from those, so a snapshot
// of the three is a snapshot of the app.
const history = createHistory({
  snapshot: () => ({
    capture: site.capture().map((p) => ({ ...p })),
    ui: uiValues(),
  }),
  restore: (snap) => {
    applyUiValues(snap.ui);
    site.setCapture(snap.capture);
    state.selected = null;
    renderPoints();
    renderPointBar();
    computePlan();
    renderIdentity();
  },
  // Nothing arrives from anywhere else any more -- the obstacle list was the
  // only synced thing -- so a snapshot is only ever what this device did, and
  // there is nothing to rebase it against.
});

function stepHistory(back) {
  const moved = back ? history.undo() : history.redo();
  if (!moved) { toast(back ? 'Nothing left to undo.' : 'Nothing to redo.'); return; }
  const d = history.depth();
  toast(back
    ? `Undone.${d.past ? ` ${d.past} more back.` : ' Back to the start.'}`
    : `Redone.${d.future ? ` ${d.future} more forward.` : ''}`);
}
$('undo').addEventListener('click', () => stepHistory(true));
window.addEventListener('keydown', (e) => {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k !== 'z' && k !== 'y') return;
  const el = document.activeElement;
  if (el && (el.isContentEditable || (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)
             && !['range', 'checkbox', 'radio'].includes(el.type)))) return;
  e.preventDefault();
  stepHistory(k === 'z' && !e.shiftKey);
});

/* ---------- control wiring ---------- */
// A slider being dragged is one action, not forty: `input` replans, `change`
// -- the release -- is what earns an undo step.
// Everything here replans. It costs well under a millisecond, and the numbers
// on screen must never belong to a plan that is no longer the one these
// settings describe.
const TUNABLE = new Set(['altitude', 'orbitRings', 'surroundRings', 'photoMode', ...PASS_IDS]);
for (const [name, c] of Object.entries(controls)) {
  c.el.addEventListener('input', () => {
    if (TUNABLE.has(name)) tuned = true;
    computePlan();
    renderIdentity();
  });
  c.el.addEventListener('change', () => history.commit());
}
for (const id of [...PASS_IDS, ...PICK_IDS]) {
  $(id).addEventListener('change', () => {
    if (TUNABLE.has(id)) tuned = true;
    computePlan();
    renderIdentity();
    history.commit();
  });
}
$('clearance').addEventListener('input', () => { computePlan(); });
$('clearance').addEventListener('change', () => {
  try { localStorage.setItem(CLEARANCE_KEY, $('clearance').value); } catch { /* private window */ }
});
// A button, not a checkbox: it belongs over the 3D view it paints, not in a
// sheet you have to go and open.


/* ---------- startup ---------- */
applyUiValues({
  altitude: DEFAULTS.altitude,
  frontOverlap: DEFAULTS.frontOverlap * 100,
  sideOverlap: DEFAULTS.sideOverlap * 100,
  speed: DEFAULTS.speed,
  orbitPad: DEFAULTS.orbitPad,
  photoMode: DEFAULTS.photoMode,
  profile: 'fly',
  shape: DEFAULT_SHAPE,
  shotsPerStop: DEFAULTS.shotsPerStop,
  orbitRings: DEFAULTS.orbitRings,
  surroundRings: DEFAULTS.surroundRings,
  nadir: true, oblique: true, orbit: true, surround: true, transect: false, establish: true,
});
try {
  const c = localStorage.getItem(CLEARANCE_KEY);
  if (c !== null) $('clearance').value = c;
} catch { /* private window */ }
readOuts();

const fromHash = decodePlan(location.hash);
const urlNamedAPlace = opened.has('c');

ready = true;
readUrl();
setShowRoute(showRoute);
setView(activeView);   // put the map's own controls where this view wants them
if (fromHash) applyPlan(fromHash);
restoreWires();
drawWires();
renderPoints();
renderReadout();
renderIdentity();
history.refresh();
pushGround();
urlFrozen = false;
writeUrl();

// A phone is carried to the site, so the useful place to start is where you are
// standing rather than a hardcoded city centre -- but only when the address bar
// has not already named somewhere more specific.
const onPhone = window.matchMedia('(max-width: 720px)').matches;
if (onPhone && !fromHash && !urlNamedAPlace) findMe({ quiet: true });

// Not part of the app: a pretend receiver, so finding yourself can be worked on
// indoors. Nothing fetches this file unless the address bar asks for it.
if (opened.has('mockgps')) {
  import('./gpsmock.js').then((m) => m.installMock(map, opened)).catch((e) => console.error(e));
}

window.__state = state;
window.__site = site;
window.__map = map;
window.__view3d = view3d;
