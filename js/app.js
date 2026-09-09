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
import { buildKmz } from './wpml.js';
import { createView3D } from './view3d.js';
import { scoreCoverage } from './coverage.js';
import { initInstall } from './install.js';
import { encodePlan, decodePlan } from './share.js';
import { initPlans } from './plansui.js';
import { routeFromRead } from './route.js';
import { createBasemaps } from './basemap.js';
import { createSite, parseHeight, pointOf, spanMOf, spansOf, isEstimated, isImported, labelOf,
  DEFAULT_POINT_HEIGHT, MAX_CAPTURE_POINTS } from './site.js';
import { overlaps } from './obstacles.js';
import { localPrisms, localSolid, ringLatLon } from './prism.js';
import { checkObstacles, clearingAltitude } from './collide.js';
import { createHistory } from './history.js';

import { bestFix, GPS_ERRORS, STALE_MS } from './gps.js';
import { sampleTerrain, verdict as terrainVerdict } from './terrain.js';
import { serviceUrl, serviceHeaders } from './service.js';

const cam = CAMERAS.mini5pro;
const $ = (id) => document.getElementById(id);

const PASS_COLOR = { nadir: '#4da3ff', oblique: '#ffb84d', orbit: '#5ad19a', transect: '#c98bff', surround: '#ff6fb5', establish: '#7ee0a0' };
const OBSTACLE_COLOR = { clear: '#ffb84d', near: '#ff9f4d', strike: '#ff5d5d' };
const CLEARANCE_KEY = 'dji.clearance';

let ready = false;
let urlFrozen = true;

// The address bar as it was when the page opened. writeUrl() rewrites it to
// just the view, so anything that arrived as a parameter has to be read before
// that happens -- and the pretend receiver has to be carried back through, or
// the first pan of the map would switch it off.
const opened = new URLSearchParams(location.search);
const MOCK_KEYS = ['mockgps', 'acc', 'age'];

const state = {
  mode: 'capture',            // what a tap on the map means
  selected: null,             // { kind, id } -- the point the bar is editing
  mission: null,
  coverage: null,
  hazard: null,
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
  obsBoxes: L.layerGroup().addTo(map),
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
let wirePaths = [];

async function lidarView() {
  if (!lidar) {
    const { createScene3D } = await import('./scene3d.js');
    lidar = createScene3D($('lidar'));
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
  if (name !== 'survey') { lidar?.close(); return; }
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
  for (const k of MOCK_KEYS) if (opened.has(k)) q.set(k, opened.get(k));
  const code = planCode();
  window.history.replaceState(null, '', `?${q}${code ? `#plan=${code}` : ''}`);
}

function readUrl() {
  const q = new URLSearchParams(location.search);
  basemaps.set(q.get('b') ?? basemaps.name());
  if (['map', 'split', '3d'].includes(q.get('v'))) setView(q.get('v'));
  if (GROUNDS.includes(q.get('s'))) setGround(q.get('s'));
  if (q.get('w') === '1') { wiresOn = true; drawWires(); }
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
  return v;
}

function applyUiValues(v) {
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
  onSync: ({ pulled, error, quiet }) => {
    if (error) { if (!quiet) toast(`Obstacles not synced — ${error}`); return; }
    if (!pulled) return;
    // A box that arrived from the other device is not an action taken here, so
    // it is not one to undo -- but the stack HAS to be told, or the next undo
    // reverts it by accident. Worse than by accident: restoring a snapshot
    // deletes every obstacle the snapshot does not contain, and the first
    // snapshot is taken at startup BEFORE the sync has pulled anything down.
    // One undo then wipes the synced list and the delete travels to every
    // device. `rebase` in createHistory exists for exactly this and was not
    // being called; refresh is what calls it.
    if (ready) history.refresh();
    toast(`${pulled} obstacle${pulled === 1 ? '' : 's'} arrived from your other device.`);
    renderIdentity();
  },
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

function nearbyObstacles() {
  const pts = site.capture();
  if (!pts.length) return [];
  const lat0 = pts.reduce((t, q) => t + q.lat, 0) / pts.length;
  const box = {
    north: Math.max(...pts.map((q) => q.lat)) + NEARBY_M / mPerDegLat(lat0),
    south: Math.min(...pts.map((q) => q.lat)) - NEARBY_M / mPerDegLat(lat0),
    east: Math.max(...pts.map((q) => q.lon)) + NEARBY_M / mPerDegLon(lat0),
    west: Math.min(...pts.map((q) => q.lon)) - NEARBY_M / mPerDegLon(lat0),
  };
  return site.obstacles().filter((o) => overlaps(o, box));
}

// Obstacles go to the planner too, not just to the collision check: they are
// tall things, and the flight that goes round a tall thing is the flight that
// photographs it.
const siteForPlanner = () => ({
  points: site.capture(),
  shape: $('shape').value,
  obstacles: nearbyObstacles().map((o) => {
    const sp = spansOf(o);
    return {
      ...pointOf(o), height: o.height,
      span: Math.max(sp.x, sp.y), spanX: sp.x, spanY: sp.y,
      // The outline as well as the box. The altitude search measures against
      // the same geometry the collision check does, and the spans are still
      // what decides how far out a ring has to stand.
      poly: o.poly, north: o.north, south: o.south, east: o.east, west: o.west,
      capture: !isImported(o),
    };
  }),
});

/* ---------- placing and editing points ---------- */
const MODES = {
  capture: {
    label: 'capture point',
    colour: '#4da3ff',
    tip: 'Tap the map on what you want captured. Tap a point to set how tall it is.',
    list: () => site.capture(),
    at: (p) => ({ lat: p.lat, lon: p.lon }),
    add: (at) => site.addCapture(at),
    setHeight: (id, h) => site.setCaptureHeight(id, h),
    remove: (id) => site.removeCapture(id),
    clear: () => site.clearCapture(),
  },
  obstacle: {
    label: 'obstacle',
    // Obstacles are not walked to. A pylon is a thing you keep well away from,
    // and the ones that matter most are wires you cannot stand under and read
    // off a phone. So in this mode the button asks the map rather than the
    // receiver: pan to the site and the tall things arrive. That is also what
    // makes a mission plannable at a desk, with no fix at all.
    here: 'Obstacles here',
    colour: '#ffb84d',
    tip: 'Tap the map where something stands. Tap a point to set how tall it is.',
    list: () => site.obstacles(),
    at: (o) => pointOf(o),
    add: (at) => site.addObstacle(at),
    setHeight: (id, h) => site.setObstacleHeight(id, h),
    remove: (id) => site.removeObstacle(id),
    clear: () => { for (const o of site.obstacles()) site.removeObstacle(o.id); },
  },
};

function setMode(mode) {
  if (!MODES[mode]) return;
  state.mode = mode;
  state.selected = null;
  for (const b of document.querySelectorAll('#modes button')) b.classList.toggle('on', b.dataset.mode === mode);
  $('tip').textContent = MODES[mode].tip;
  showTip();
  // The button over the map belongs to obstacle mode: it asks OpenStreetMap
  // about the view. Capture mode had one too -- a point placed where the phone
  // said you were standing -- and it is gone, so a capture point is a tap and
  // only a tap.
  $('hereBtn').classList.add('obstacle');
  $('hereBtn').hidden = mode !== 'obstacle';
  if (!importing) $('hereBtn').textContent = MODES.obstacle.here;
  $('hereBtn').title =
    'Buildings, trees and overhead lines from OpenStreetMap, for whatever is on screen';
  $('clearMode').textContent = mode === 'capture' ? 'Clear points' : 'Clear obstacles';
  renderPoints();
  renderPointBar();
}
for (const b of document.querySelectorAll('#modes button')) {
  b.addEventListener('click', () => setMode(b.dataset.mode));
}

// One tap, one point, whichever mode you are in. Placing is the whole
// interaction: there is no arm-then-drag, because on a phone in a field the
// gesture you can rely on is a tap.
function placeAt(latlng) {
  if (state.mode === 'capture' && site.capture().length >= MAX_CAPTURE_POINTS) {
    toast(`That is ${MAX_CAPTURE_POINTS} capture points — enough to describe anything this app can fly.`);
    return;
  }
  const added = MODES[state.mode].add({ lat: latlng.lat, lon: latlng.lng });
  if (added) state.selected = { kind: state.mode, id: added.id };
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

// Outlines are kept and restyled, never rebuilt -- the same rule as the markers
// below, learned the same way. Clearing the layer and drawing every outline
// again is the simple version, and with a city block imported it is a hundred
// and fifty polygons of thirty points each thrown away and remade on every
// slider tick, which is most of what a replan costs. A record is replaced
// wholesale whenever it changes, so its own identity says when the shape has to
// be redrawn and when only the colour has moved.
const obsShapes = new Map();   // obstacle id -> { shape, from, style }

function renderPoints() {
  const struck = new Set((state.hazard?.obstacles ?? [])
    .filter((o) => o.grade !== 'clear').map((o) => o.id));

  const wanted = new Set();
  const drawn = new Set();
  for (const o of site.obstacles()) {
    const grade = struck.has(o.id)
      ? (state.hazard.obstacles.find((x) => x.id === o.id)?.grade ?? 'clear') : 'clear';
    // A span is drawn as the line it is. Its boxes are still the geometry the
    // collision check uses, but giving each one a draggable numbered dot buries
    // the line under its own footprint and invites you to nudge a piece of a
    // power cable, which is not a thing you can do.
    const isWire = labelOf(o).endsWith(' (bdot)');
    const style = {
      color: OBSTACLE_COLOR[grade], weight: 1,
      fillOpacity: isWire && grade === 'clear' ? 0 : 0.12,
      opacity: isWire && grade === 'clear' ? 0 : 1,
    };
    // The outline the thing actually has, when the source knew it. A tapped
    // obstacle's outline IS its rectangle, so this is one call for both.
    drawn.add(o.id);
    let kept = obsShapes.get(o.id);
    if (!kept) {
      const shape = L.polygon(ringLatLon(o).map((v) => [v.lat, v.lon]),
        { ...style, interactive: false }).addTo(layers.obsBoxes);
      obsShapes.set(o.id, { shape, from: o, style });
    } else {
      if (kept.from !== o) {
        kept.shape.setLatLngs(ringLatLon(o).map((v) => [v.lat, v.lon]));
        kept.from = o;
      }
      if (kept.style.color !== style.color || kept.style.opacity !== style.opacity
          || kept.style.fillOpacity !== style.fillOpacity) {
        kept.shape.setStyle(style);
        kept.style = style;
      }
    }
    if (isWire && grade === 'clear') continue;
    wanted.add(syncPoint('obstacle', o.id, pointOf(o), o.height, grade !== 'clear'));
  }
  for (const p of site.capture()) wanted.add(syncPoint('capture', p.id, p, p.height, false));

  for (const [id, kept] of obsShapes) {
    if (drawn.has(id)) continue;
    layers.obsBoxes.removeLayer(kept.shape);
    obsShapes.delete(id);
  }

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
    // Both kinds drag. You place them by eye against a photograph, and being
    // able to nudge one is the difference between a tap being a commitment and
    // a tap being a first guess. There was no reason for an obstacle to be the
    // exception beyond nobody having written the move.
    draggable: true,
  });
  m.on('click', (e) => {
    L.DomEvent.stopPropagation(e);
    if (state.mode !== kind) setMode(kind);
    state.selected = { kind, id };
    renderPoints();
    renderPointBar();
  });
  m.addTo(layers.points);
  m._ptHtml = html;
  m.on('dragstart', () => {
    draggingKey = key;
    state.selected = { kind, id };
    renderPointBar();
  });
  m.on('dragend', () => {
    draggingKey = null;
    const ll = m.getLatLng();
    if (kind === 'capture') site.moveCapture(id, ll.lat, ll.lng);
    else site.moveObstacle(id, ll.lat, ll.lng);
  });
  pointMarkers.set(key, m);
  return key;
}

function selectedPoint() {
  if (!state.selected) return null;
  const { kind, id } = state.selected;
  const found = MODES[kind].list().find((x) => x.id === id);
  return found ? { kind, id, item: found } : null;
}

function renderPointBar() {
  const sel = selectedPoint();
  $('pointbar').hidden = !sel;
  // Here and the bar both live at the bottom of the map; the stylesheet moves
  // Here up out of the way rather than letting them stack.
  $('stage').classList.toggle('editing', Boolean(sel));
  if (!sel) return;
  const list = MODES[sel.kind].list();
  $('pointDot').className = `pdot ${sel.kind}`;
  $('pointName').textContent = `${sel.kind === 'capture' ? 'Capture' : 'Obstacle'} `
    + `${list.findIndex((x) => x.id === sel.id) + 1} of ${list.length}`;
  if (document.activeElement !== $('pHeight')) $('pHeight').value = String(sel.item.height);
}

function nudgeHeight(by) {
  const sel = selectedPoint();
  if (!sel) return;
  MODES[sel.kind].setHeight(sel.id, Math.max(0, Math.round((sel.item.height + by) * 10) / 10));
  renderPointBar();
}
$('pUp').addEventListener('click', () => nudgeHeight(1));
$('pDown').addEventListener('click', () => nudgeHeight(-1));
$('pHeight').addEventListener('change', () => {
  const sel = selectedPoint();
  const h = parseHeight($('pHeight').value);
  if (!sel) return;
  if (h === null) { $('pHeight').value = String(sel.item.height); return; }
  MODES[sel.kind].setHeight(sel.id, h);
});
$('pDelete').addEventListener('click', () => {
  const sel = selectedPoint();
  if (!sel) return;
  MODES[sel.kind].remove(sel.id);
  state.selected = null;
  renderPointBar();
});
$('clearMode').addEventListener('click', () => {
  const m = MODES[state.mode];
  if (!m.list().length) { toast(`No ${m.label}s to clear.`); return; }
  m.clear();
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
    const boxes = nearbyObstacles().flatMap((o) => localPrisms(o, state.mission.frame));
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

// What is already standing here, from OpenStreetMap: buildings, trees and --
// the ones you cannot see from above and that actually bring an aircraft down
// -- power lines. See js/osm.js for what it knows and what it is guessing.
//
// This is obstacle mode's button over the map, and it asks about the view. It
// used to be a line in Advanced, next to a button that placed one obstacle at
// the phone's position: the wrong two shapes round the wrong way, because the
// gesture that fills a site in with what is standing on it is the one that
// needs no receiver, and it belongs where the map is.
let importing = false;
async function importHere() {
  const btn = $('hereBtn');
  if (importing) return;
  importing = true;
  btn.disabled = true;
  btn.textContent = 'Asking OpenStreetMap…';
  try {
    const { fetchAround } = await import('./osm.js');
    const b = map.getBounds();
    const raw = await fetchAround({
      north: b.getNorth(), south: b.getSouth(), east: b.getEast(), west: b.getWest(),
    });
    if (!raw.length) { toast('Nothing mapped in this view.'); return; }

    // OpenStreetMap says where things are; it very often does not say how tall.
    // If the heights service is reachable it says how tall, from the national
    // LiDAR. If it is not, or has no survey here, the estimates stand and the
    // import behaves exactly as it did before this existed.
    const { measure } = await import('./heights.js');
    btn.textContent = 'Measuring heights…';
    const { obstacles: found, measured, blanked } = await measure(raw, {
      // Measured 152 s for one cold tile (Krakow, 2026-09-09). "About a minute"
      // was wrong by two and a half times, and the wait is per tile.
      onWait: () => toast('First visit here — downloading the survey. A few minutes; the estimates stand until it lands.'),
      onProgress: (done, total) => { btn.textContent = `Measuring heights… ${done}/${total}`; },
    });

    // And the wires. OpenStreetMap has the pylons and hardly any of the
    // distribution; BDOT10k has the lot, nationally, which is the difference
    // between knowing about the 400 V run across a field and not.
    const { fetchLines } = await import('./lines.js');
    btn.textContent = 'Looking for overhead lines…';
    const wires = await fetchLines(
      { north: b.getNorth(), south: b.getSouth(), east: b.getEast(), west: b.getWest() },
      { onProgress: (d, t) => { btn.textContent = `Overhead lines… ${d}/${t}`; } },
    );

    // The wires are their own layer with their own switch now, so an import
    // that happens to fetch them hands them over rather than drawing them.
    const seen = new Set(wirePaths.map((w) => JSON.stringify(w.path)));
    wirePaths = [...wirePaths, ...wires.paths.filter((w) => !seen.has(JSON.stringify(w.path)))];
    rememberWires();
    drawWires();
    const all = [...found, ...wires.obstacles];
    const guessed = found.filter((f) => f.assumed).length;
    site.addImported(all);
    history.commit();
    const parts = [`${all.length} added`];
    if (measured) parts.push(`${measured} measured`);
    if (wires.lines) parts.push(`${wires.lines} overhead line${wires.lines === 1 ? '' : 's'}`);
    if (guessed) parts.push(`${guessed} still assumed`);
    if (blanked) parts.push(`${blanked} over water or unsurveyed`);
    toast(`${parts.join(' — ')}.`);
  } catch (e) {
    toast(`Import failed — ${e.message}`);
  } finally {
    importing = false;
    btn.disabled = false;
    // Whichever mode is in front now: a long import outlives a mode switch.
    btn.textContent = MODES[state.mode].here;
  }
}

// Planning around the ground rather than around a list.
//
// The obstacle list only ever contains what somebody mapped. The survey raster
// contains what is actually standing -- the line of poplars along the field
// edge, the pole, the crane -- at one measured byte per square metre. So this
// asks it what the tallest thing under the whole flight is, which is the only
// number that decides whether one barometric altitude is safe.
//
// On demand rather than on every replan: the first tile under a new site is a
// couple of minutes and hundreds of megabytes, and spending that because
// somebody nudged a slider would be rude to a public agency and to the user.
{
  const btn = $('surveyFit');
  btn.addEventListener('click', async () => {
    if (!state.mission) { toast('Draw something to fly first.'); return; }
    const path = state.mission.exported ?? state.mission.waypoints ?? [];
    if (!path.length) { toast('Nothing planned yet.'); return; }
    // The area the aircraft actually crosses, which is what its altitude has
    // to clear -- not the box you tapped.
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

// Which service, and is it answering.
//
// There are two and they are named in js/service.js, so this offers the names
// rather than an address to type: `auto` -- a page from this machine talks to a
// service on this machine -- or either one on purpose. It was a URL you set in
// localStorage from the console, which is a way to know where you are pointed
// and not a way to point.
//
// The Check button exists because the two failure modes look identical from
// here: nothing running on this laptop, and a tunnel that is down. One round
// trip to /v1/health tells them apart, and it is the only request in the app
// nobody has to make.
{
  const say = (text) => { $('serviceHint').textContent = text; };
  const describe = () => {
    say(`Talking to ${serviceUrl()}. Heights, overhead lines, the 3D model and`
      + ' syncing your plans all go there.');
  };
  describe();

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
      // A local service that is not running and a tunnel that is down both
      // land here, which is why the address is in the message.
      say(`${url} did not answer — ${e.message}.`);
    } finally {
      $('servicePing').disabled = false;
    }
  });
}

// The rough model, for looking at rather than planning with. The service
// builds it from the same survey the heights come from and serves the viewer
// itself, so this is a link and nothing more -- no state, no effect on the
// plan. There is always a service now, so there is nothing to hide it behind.
{
  $('scene3d').addEventListener('click', () => {
    const c = map.getCenter();
    // The centre of the map, not the site: the model is a 500 m square of
    // ground and you aim it by looking at where you are aiming.
    window.open(`${serviceUrl()}/scene?lat=${c.lat.toFixed(6)}&lon=${c.lng.toFixed(6)}`,
      '_blank', 'noopener');
  });
}

$('clearOsm').addEventListener('click', () => {
  wirePaths = [];
  rememberWires();
  drawWires();
  const gone = site.clearImported();
  history.commit();
  toast(gone ? `Removed ${gone} imported obstacle${gone === 1 ? '' : 's'}.` : 'Nothing imported to remove.');
});

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
  const boxes0 = nearbyObstacles();

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
  const prisms = boxes0.flatMap((o) => localPrisms(o, state.mission.frame));
  const solids = boxes0.map((o) => localSolid(o, state.mission.frame));
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
  view3d.setObstacles(graded(solids), state.hazard.legs);
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

const graded = (boxes) => boxes.map((b) => ({
  ...b,
  grade: state.hazard?.obstacles.find((o) => o.id === b.id)?.grade ?? 'clear',
  selected: state.selected?.kind === 'obstacle' && state.selected.id === b.id,
}));

function renderConflicts() {
  layers.conflicts.clearLayers();
  for (const leg of state.hazard?.legs ?? []) {
    L.polyline([[leg.a.lat, leg.a.lon], [leg.b.lat, leg.b.lon]], {
      color: OBSTACLE_COLOR[leg.grade], weight: 4, opacity: 0.9, interactive: false,
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
  if (h?.strikes) say('strike', `The flight hits ${h.strikes} obstacle${h.strikes === 1 ? '' : 's'}.`);
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
      say('unseen', `The survey sees something ${sv.height} m tall under this flight — `
        + `${(need - alt).toFixed(0)} m above your altitude, mapped or not.${caveat}`);
      raiseTo(need);
    } else {
      say('incomplete', `The survey's tallest thing under this flight is ${sv.height} m; `
        + `you clear it by ${(alt - sv.height).toFixed(0)} m.${caveat}`);
    }
  } else if (sv && sv.missing) {
    say('incomplete', `The survey has not answered for ${sv.missing} of ${sv.tiles} tiles under `
      + 'this flight, so nothing here is measured yet.');
  }

  const guessed = nearbyObstacles().filter(isEstimated).length;
  if (guessed) {
    say('assumed', `${guessed} obstacle${guessed === 1 ? ' has an' : 's have'} assumed `
      + `height${guessed === 1 ? '' : 's'} — check anything the flight passes close to.`);
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
    const key = p.name.toLowerCase().split(/[\s-]/)[0];
    const colour = PASS_COLOR[key] ?? PASS_COLOR[Object.keys(PASS_COLOR).find((k) => p.name.toLowerCase().startsWith(k))] ?? '#8b98a5';
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
    view3d.setObstacles(
      state.mission ? graded(nearbyObstacles().map((o) => localSolid(o, state.mission.frame))) : [],
      state.hazard?.legs ?? [],
    );
    return;
  }
  renderPath(state.onDevice, { groups: DEVICE_GROUPS(), dashed: true });
  view3d.setMission(state.onDevice, null);
  // Ungraded: every grade on screen belongs to the plan, and colouring someone
  // else's route with the plan's verdict would be a lie in the most expensive
  // possible place.
  view3d.setObstacles(nearbyObstacles().map((o) => localSolid(o, state.onDevice.frame)), []);
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
$('hereBtn').addEventListener('click', () => importHere());

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
  $('tip').hidden = MODES[state.mode].list().length > 0;
}

function renderIdentity() {
  showTip();
  $('planTitle').textContent = session.name ?? 'New plan';
  $('planTitle').classList.toggle('dirty', dirty());
  $('nCapture').textContent = String(site.capture().length);
  $('nObstacle').textContent = String(site.obstacles().length);
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
    obstacles: site.obstacles().map((o) => ({ ...o })),
    ui: uiValues(),
  }),
  restore: (snap) => {
    applyUiValues(snap.ui);
    site.setCapture(snap.capture);
    site.restoreObstacles(snap.obstacles);
    state.selected = null;
    renderPoints();
    renderPointBar();
    computePlan();
    renderIdentity();
  },
  // A box that arrived from the other device belongs in every snapshot on the
  // stack, or undoing past its arrival would delete it.
  rebase: (snap, before, after) => {
    const had = new Set(before.obstacles.map((o) => o.id));
    const arrived = after.obstacles.filter((o) => !had.has(o.id));
    if (!arrived.length) return snap;
    const ids = new Set(snap.obstacles.map((o) => o.id));
    return { ...snap, obstacles: [...snap.obstacles, ...arrived.filter((o) => !ids.has(o.id))] };
  },
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

$('syncNow').addEventListener('click', () => site.sync().then(renderIdentity));

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
setMode('capture');
setShowRoute(showRoute);
setView(activeView);   // put the map's own controls where this view wants them
if (fromHash) applyPlan(fromHash);
restoreWires();
drawWires();
renderPoints();
renderReadout();
renderIdentity();
site.start();        // what the other device drew is part of this plan's world
history.refresh();   // and it must be in the stack's idea of now before any undo
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
