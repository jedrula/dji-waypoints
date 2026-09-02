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
import { frame } from './geo.js';
import { buildKmz } from './wpml.js';
import { createView3D } from './view3d.js';
import { scoreCoverage } from './coverage.js';
import { initInstall } from './install.js';
import { encodePlan, decodePlan } from './share.js';
import { initPlans } from './plansui.js';
import { routeFromRead } from './route.js';
import { createBasemaps } from './basemap.js';
import { createSite, pointOf, DEFAULT_POINT_HEIGHT, MAX_CAPTURE_POINTS } from './site.js';
import { localBox } from './obstacles.js';
import { checkObstacles, clearingAltitude, ringFloor } from './collide.js';
import { createHistory } from './history.js';
import { judgeFix, parseHeight } from './walk.js';
import { bestFix, GPS_ERRORS, STALE_MS } from './gps.js';

const cam = CAMERAS.mini5pro;
const $ = (id) => document.getElementById(id);

const PASS_COLOR = { nadir: '#4da3ff', oblique: '#ffb84d', orbit: '#5ad19a', transect: '#c98bff', surround: '#ff6fb5' };
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
let groundOn = false;

function setView(name) {
  activeView = name;
  const showMap = name !== '3d';
  const show3d = name !== 'map';
  for (const b of document.querySelectorAll('#viewtabs button')) b.classList.toggle('on', b.dataset.view === name);
  $('stage').classList.toggle('split', name === 'split');
  $('map').hidden = !showMap;
  $('scene').hidden = !show3d;
  $('splitter').hidden = name !== 'split';
  $('basetabs').hidden = !showMap;
  $('findme').hidden = !showMap;
  if (name === 'split') setSplit(splitPct, { store: false });
  if (showMap) map.invalidateSize();
  if (show3d) view3d.draw();
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
  view3d.setGround(basemaps.groundSpec(groundOn));
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
  if (groundOn) q.set('g', '1');
  for (const k of MOCK_KEYS) if (opened.has(k)) q.set(k, opened.get(k));
  const code = planCode();
  window.history.replaceState(null, '', `?${q}${code ? `#plan=${code}` : ''}`);
}

function readUrl() {
  const q = new URLSearchParams(location.search);
  basemaps.set(q.get('b') ?? basemaps.name());
  if (['map', 'split', '3d'].includes(q.get('v'))) setView(q.get('v'));
  if (q.get('g') === '1') { groundOn = true; pushGround(); }
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
map.on('moveend', writeUrl);

/* ---------- controls ---------- */
const controls = {
  altitude: { el: $('altitude'), val: (v) => +v, fmt: (v) => `${v} m` },
  frontOverlap: { el: $('frontOverlap'), val: (v) => v / 100, fmt: (v) => `${v}%` },
  sideOverlap: { el: $('sideOverlap'), val: (v) => v / 100, fmt: (v) => `${v}%` },
  speed: { el: $('speed'), val: (v) => +v, fmt: (v) => `${(+v).toFixed(1)} m/s` },
  orbitPad: { el: $('orbitPad'), val: (v) => +v, fmt: (v) => `${v > 0 ? '+' : ''}${v} m` },
};
const PASS_IDS = ['nadir', 'oblique', 'orbit', 'transect', 'surround'];
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
    if (pulled) {
      toast(`${pulled} obstacle${pulled === 1 ? '' : 's'} arrived from your other device.`);
      renderIdentity();
    }
  },
  onChange: ({ replaced = false } = {}) => {
    if (!ready) return;
    renderPoints();
    computePlan();
    renderIdentity();
    if (!replaced) history.commit();
  },
});

const siteForPlanner = () => ({ points: site.capture(), shape: $('shape').value });

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
  $('hereBtn').classList.toggle('obstacle', mode === 'obstacle');
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
map.on('click', (e) => {
  if (state.mode === 'capture' && site.capture().length >= MAX_CAPTURE_POINTS) {
    toast(`That is ${MAX_CAPTURE_POINTS} capture points — enough to describe anything this app can fly.`);
    return;
  }
  const added = MODES[state.mode].add({ lat: e.latlng.lat, lon: e.latlng.lng });
  if (added) state.selected = { kind: state.mode, id: added.id };
  renderPointBar();
});

// A point is a dot with the height you gave it written in it, because the
// height is the only thing a point carries and the only thing worth reading off
// the map without touching anything.
function renderPoints() {
  layers.points.clearLayers();
  layers.obsBoxes.clearLayers();

  const struck = new Set((state.hazard?.obstacles ?? [])
    .filter((o) => o.grade !== 'clear').map((o) => o.id));

  for (const o of site.obstacles()) {
    const grade = struck.has(o.id)
      ? (state.hazard.obstacles.find((x) => x.id === o.id)?.grade ?? 'clear') : 'clear';
    L.rectangle([[o.south, o.west], [o.north, o.east]], {
      color: OBSTACLE_COLOR[grade], weight: 1, fillOpacity: 0.12, interactive: false,
    }).addTo(layers.obsBoxes);
    addPoint('obstacle', o.id, pointOf(o), o.height, grade !== 'clear');
  }
  for (const p of site.capture()) addPoint('capture', p.id, p, p.height, false);

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

function addPoint(kind, id, at, height, bad) {
  const on = state.selected?.kind === kind && state.selected?.id === id;
  const size = kind === 'capture' ? 24 : 22;
  const m = L.marker([at.lat, at.lon], {
    icon: L.divIcon({
      className: '',
      html: `<div class="pt ${kind}${on ? ' on' : ''}${bad ? ' strike' : ''}" `
          + `style="width:${size}px;height:${size}px">${Math.round(height)}</div>`,
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
    }),
    draggable: kind === 'capture',
  }).addTo(layers.points);
  m.on('click', (e) => {
    L.DomEvent.stopPropagation(e);
    if (state.mode !== kind) setMode(kind);
    state.selected = { kind, id };
    renderPoints();
    renderPointBar();
  });
  if (kind === 'capture') {
    m.on('dragend', () => {
      const ll = m.getLatLng();
      site.moveCapture(id, ll.lat, ll.lng);
    });
  }
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
let scoreTimer = null;
function scoreSoon() {
  clearTimeout(scoreTimer);
  scoreTimer = setTimeout(() => {
    if (!state.mission) return;
    const boxes = site.obstacles().map((o) => localBox(o, state.mission.frame));
    state.coverage = scoreCoverage(state.mission, { maxCameras: 220, boxes });
    // Tagged so a later replan can tell whether this score is still about the
    // flight on screen, rather than leaving yesterday's number sitting there.
    state.coverage.forWaypoints = state.mission.stats.waypoints;
    renderReadout();
    view3d.setMission(state.mission, state.coverage);
  }, 250);
}

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
  clearTimeout(scoreTimer);
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
  const boxes0 = site.obstacles();
  p.orbitFloor = ringFloor(boxes0.map((o) => o.height), clearance());

  try {
    state.mission = planMission(siteForPlanner(), p, cam);
  } catch {
    state.mission = null;
    renderReadout();
    return;
  }

  const boxes = boxes0.map((o) => localBox(o, state.mission.frame));
  // Last score stays on screen only if it belongs to this many waypoints;
  // otherwise the tile says so until the new one lands.
  if (state.coverage?.forWaypoints !== state.mission.stats.waypoints) state.coverage = null;
  state.hazard = checkObstacles(state.mission, boxes, { clearance: clearance() });
  state.clearAlt = (state.hazard.strikes || state.hazard.near)
    ? clearingAltitude(state.mission, boxes, { clearance: clearance() })
    : null;

  drawRoute();
  renderPoints();
  renderConflicts();
  renderReadout();
  renderIdentity();
  if (state.onDevice) showDeviceRoute(null);
  view3d.setMission(state.mission, state.coverage);
  view3d.setObstacles(graded(boxes), state.hazard.legs);
  writeUrl();
  scoreSoon();
}

// The route on the map, or not. The 3D view always gets it -- looking at the
// flight is the whole of that view's job -- so this is only about the map,
// where the flight sits on top of the thing you are tapping.
function drawRoute() {
  if (showRoute && state.mission) { renderPath(state.mission); return; }
  for (const g of [layers.path, layers.dots, layers.poses]) g.clearLayers();
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

function renderAlert(over) {
  const el = $('alert');
  const h = state.hazard;
  const bits = [];
  let kind = 'warn';
  if (h?.strikes) { bits.push(`The flight hits ${h.strikes} obstacle${h.strikes === 1 ? '' : 's'}.`); kind = ''; }
  else if (h?.near) bits.push(`${h.near} leg${h.near === 1 ? '' : 's'} pass closer than the clearance.`);
  if (over) bits.push(`${state.mission.stats.waypoints} waypoints exports as ${Math.ceil(state.mission.stats.waypoints / DJI_FLY_MAX_WAYPOINTS)} parts.`);
  el.hidden = !bits.length;
  el.className = `alert ${kind}`;
  el.textContent = bits.join(' ');
  if (state.clearAlt && state.clearAlt > +$('altitude').value) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = `Raise to ${state.clearAlt.toFixed(0)} m`;
    b.addEventListener('click', () => {
      $('altitude').value = state.clearAlt;
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
      state.mission ? graded(site.obstacles().map((o) => localBox(o, state.mission.frame))) : [],
      state.hazard?.legs ?? [],
    );
    return;
  }
  renderPath(state.onDevice, { groups: DEVICE_GROUPS(), dashed: true });
  view3d.setMission(state.onDevice, null);
  // Ungraded: every grade on screen belongs to the plan, and colouring someone
  // else's route with the plan's verdict would be a lie in the most expensive
  // possible place.
  view3d.setObstacles(site.obstacles().map((o) => localBox(o, state.onDevice.frame)), []);
  map.fitBounds(L.latLngBounds(state.onDevice.waypoints.map((w) => [w.lat, w.lon])),
    { padding: [40, 40], maxZoom: 19 });
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
const goToFix = ({ lat, lon }) => map.setView([lat, lon], Math.max(map.getZoom(), 19), { animate: false });

let finding = false;
async function findMe({ quiet = false, then = null } = {}) {
  // Locating takes a moment and a second press cannot make it faster, so say
  // that rather than swallowing the tap and looking broken.
  if (finding) { toast('Still looking for a position…'); return null; }
  finding = true;
  $('findme').classList.add('busy');
  $('hereBtn').disabled = true;
  try {
    if (!quiet) toast('Asking your device where you are…', { sticky: true });
    const fix = await bestFix({
      onProgress: (f) => { if (!quiet) toast(`±${f.accuracy.toFixed(0)} m so far…`, { sticky: true }); },
    });
    showFix(fix);
    if (!then) goToFix(fix);
    if (quiet) toast(`Map centred where you are (±${fix.accuracy.toFixed(0)} m).`);
    else if (!then) toast(`You are here — ±${fix.accuracy.toFixed(0)} m`
      + `${fix.age > STALE_MS ? `, from a fix ${Math.round(fix.age / 60000)} min old` : ''}.`);
    then?.(fix);
    return fix;
  } catch (err) {
    if (!quiet) toast(GPS_ERRORS[err.code] ?? `Could not locate you: ${err.message}`);
    return null;
  } finally {
    finding = false;
    $('findme').classList.remove('busy');
    $('hereBtn').disabled = false;
  }
}
$('findme').addEventListener('click', () => findMe());

// Standing next to the thing rather than looking at it on a map. Same two kinds
// of point, placed where the phone says you are and grown by how unsure it is.
$('hereBtn').addEventListener('click', () => findMe({
  then: (fix) => {
    const verdict = judgeFix(fix);
    if (!verdict.ok) { toast(verdict.why); return; }
    const added = MODES[state.mode].add({ lat: fix.lat, lon: fix.lon, accuracy: fix.accuracy });
    if (added) state.selected = { kind: state.mode, id: added.id };
    goToFix(fix);
    renderPointBar();
    toast(`${MODES[state.mode].label} placed where you are (±${fix.accuracy.toFixed(0)} m)`
      + `${fix.age > STALE_MS ? ' — from a stale fix, check it' : ''}.`);
  },
}));

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
      { animate: false, maxZoom: 19 });
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
for (const c of Object.values(controls)) {
  c.el.addEventListener('input', () => { computePlan(); renderIdentity(); });
  c.el.addEventListener('change', () => history.commit());
}
for (const id of [...PASS_IDS, ...PICK_IDS]) {
  $(id).addEventListener('change', () => { computePlan(); renderIdentity(); history.commit(); });
}
$('clearance').addEventListener('input', () => { computePlan(); });
$('clearance').addEventListener('change', () => {
  try { localStorage.setItem(CLEARANCE_KEY, $('clearance').value); } catch { /* private window */ }
});
$('ground').addEventListener('change', () => { groundOn = $('ground').checked; pushGround(); writeUrl(); });
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
  nadir: true, oblique: true, orbit: true, surround: true, transect: false,
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
if (fromHash) applyPlan(fromHash);
renderPoints();
renderReadout();
renderIdentity();
site.start();        // what the other device drew is part of this plan's world
pushGround();
urlFrozen = false;
writeUrl();

// A phone is carried to the site, so the useful place to start is where you are
// standing rather than a hardcoded city centre -- but only when the address bar
// has not already named somewhere more specific.
const onPhone = window.matchMedia('(max-width: 720px)').matches;
if (onPhone && !fromHash && !urlNamedAPlace) findMe({ quiet: true });

// Not part of the app: a pretend receiver so the walk can be worked on indoors.
// Nothing fetches this file unless the address bar asks for it.
if (opened.has('mockgps')) {
  import('./gpsmock.js').then((m) => m.installMock(map, opened)).catch((e) => console.error(e));
}
$('hereBtn').hidden = !navigator.geolocation;

window.__state = state;
window.__site = site;
window.__map = map;
window.__view3d = view3d;
