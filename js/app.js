import { CAMERAS, gsdCm } from './camera.js';
import { frame, mPerDegLat, mPerDegLon } from './geo.js';
import { planMission, proposePlan, splitMission, DEFAULTS, DJI_FLY_MAX_WAYPOINTS } from './planner.js';
import { buildKmz } from './wpml.js';
import { createView3D } from './view3d.js';
import { scoreCoverage } from './coverage.js';
import { initInstall } from './install.js';
import { encodePlan, decodePlan } from './share.js';
import { initPlans } from './plansui.js';
import { routeFromRead } from './route.js';
import { createMenu } from './menu.js';
import { initWorld } from './worldui.js';
import { localBox, overlaps, describe } from './obstacles.js';
import { checkObstacles, clearingAltitude } from './collide.js';
import { createHistory } from './history.js';

const cam = CAMERAS.mini5pro;
const $ = (id) => document.getElementById(id);

const PASS_COLOR = { nadir: '#4da3ff', oblique: '#ffb84d', orbit: '#5ad19a', transect: '#c98bff' };

// What an obstacle looks like once the flight has been measured against it.
// Slate is "the plan stays clear of this"; the other two are the two kinds of
// bad news, and they are the same two colours everywhere they appear.
const OBSTACLE_COLOR = { clear: '#9aa7b4', near: '#ffb84d', strike: '#ff5d5d' };

const state = {
  rect: null, mission: null, draw: null, onDevice: null,
  // The latest collision check, and the lowest altitude that would clear
  // everything the flight passes over. Both are null until there is a plan.
  hazard: null, clearAlt: null,
  // Heights pinned by dragging a level in the 3D view. Null means "whatever
  // the planner derives from the altitude", which is where every plan starts.
  orbitHeights: null, transectHeights: null,
};

/* ---------- the three views ---------- */
// Planning, the plans you keep, and the controller are separate jobs on the
// same map. The menu owns which one is on screen; each view owns its own pane
// and talks to the others only through the callbacks wired up further down.
// Two startup latches, and they live up here for the same reason: module setup
// calls into code that is written for a running app -- createMenu shows a view
// while it is still being constructed, setBasemap runs before the map has been
// pointed anywhere. A `let` declared further down is not merely undefined at
// that point, it throws, which takes the whole module with it.
//
// `ready`: the panes, layers and views exist, so a change can redraw them.
// `urlFrozen`: startup is still deciding what the view is, so nothing should be
// writing that decision back to the address bar yet.
//
// The rule, because this has bitten four times: anything setup calls -- and
// setBasemap and createMenu both run before most of this file exists -- must
// either use only what is declared above it, or bail on `ready`. Reaching
// forward for a `const` further down does not read as undefined, it throws, and
// it takes the whole module with it.
let ready = false;
let urlFrozen = true;
// Leaving a view cancels any half-armed rubber band: it is as clear a "no" as
// pressing Cancel.
function paneChanged() {
  if (!ready) return;
  setDrawing(null);   // which redraws the obstacles
}

const menu = createMenu([
  { id: 'plan', label: 'Plan', onShow: () => paneChanged() },
  { id: 'saved', label: 'Saved', onShow: () => paneChanged() },
  { id: 'world', label: 'Obstacles', onShow: () => paneChanged() },
  { id: 'device', label: 'Controller', onShow: () => { paneChanged(); bridge.refresh(); } },
]);

/* ---------- map ---------- */
const map = L.map('map', { zoomControl: true, attributionControl: true }).setView([50.0614, 19.9366], 16);

// Imagery is what you plan against -- you are looking for the actual roof, tree
// or slab. Streets are for finding the place at all, and topo for knowing
// whether the ground under a 40 m flight is flat. All three come from the same
// provider, so no extra attribution and no API key.
//
// `maxNative` is the deepest zoom the service actually holds imagery for. Ask
// past it and Esri answers 200 with a grey "Map data not yet available" tile --
// a real image, so nothing errors and nothing looks broken until you see it
// painted across the ground. Coverage varies by place (city centres go deeper
// than a riverbank), so this is the conservative floor rather than the best
// case, and it is ONE number: the map layer and the 3D ground both read it, or
// they disagree and only one of them shows the grey.
const BASEMAPS = {
  satellite: { label: 'Satellite', url: 'World_Imagery', maxNative: 19, attribution: 'Imagery &copy; Esri' },
  streets: { label: 'Streets', url: 'World_Street_Map', maxNative: 19, attribution: 'Map &copy; Esri' },
  topo: { label: 'Topo', url: 'World_Topo_Map', maxNative: 19, attribution: 'Topo &copy; Esri' },
};
const BASEMAP_KEY = 'dji.basemap';
const tiles = {};
let baseLayer = null;
let activeBase = 'satellite';

// The one place the tile service's URL shape is written down, so the map layer
// and the 3D ground cannot end up pointed at different things. Note /{z}/{y}/{x}
// -- Esri puts the row before the column, which is not the usual order.
const tileUrl = (service) => (z, x, y) =>
  `https://server.arcgisonline.com/ArcGIS/rest/services/${service}/MapServer/tile/${z}/${y}/${x}`;

function setBasemap(name) {
  const spec = BASEMAPS[name] ?? BASEMAPS.satellite;
  activeBase = BASEMAPS[name] ? name : 'satellite';
  tiles[name] ??= L.tileLayer(
    `https://server.arcgisonline.com/ArcGIS/rest/services/${spec.url}/MapServer/tile/{z}/{y}/{x}`,
    { maxZoom: 21, maxNativeZoom: spec.maxNative, attribution: spec.attribution },
  );
  if (baseLayer === tiles[name]) return;
  if (baseLayer) map.removeLayer(baseLayer);
  baseLayer = tiles[name];
  // Underneath the box, the path and the handles, all of which are already on
  // the map by the time you switch.
  baseLayer.addTo(map).bringToBack();
  for (const b of document.querySelectorAll('#basetabs button')) b.classList.toggle('on', b.dataset.base === name);
  // localStorage is the fallback for a bare visit; the URL is what wins when it
  // has something to say. Keeping both means opening someone's link does not
  // permanently retune your own default.
  try { localStorage.setItem(BASEMAP_KEY, name); } catch { /* private window */ }
  pushGround();
  writeUrl();
}

for (const [name, spec] of Object.entries(BASEMAPS)) {
  const b = document.createElement('button');
  b.type = 'button';
  b.dataset.base = name;
  b.textContent = spec.label;
  b.addEventListener('click', () => setBasemap(name));
  $('basetabs').append(b);
}
let savedBase = null;
try { savedBase = localStorage.getItem(BASEMAP_KEY); } catch { /* private window */ }
setBasemap(savedBase ?? 'satellite');

const layers = {
  rect: L.rectangle([[0, 0], [0, 0]], {
    color: '#4da3ff', weight: 2, fill: true, fillOpacity: 0.06,
    dashArray: '5,4', className: 'rectbox',
  }),
  // Under the flight path: what is already there is the background you are
  // planning against, not the thing you are reading.
  obstacles: L.layerGroup().addTo(map),
  path: L.layerGroup().addTo(map),
  dots: L.layerGroup().addTo(map),
  devicePath: L.layerGroup().addTo(map),
  deviceDots: L.layerGroup().addTo(map),
  devicePoses: L.layerGroup().addTo(map),
  // Over it: the legs that come too close are the one thing on this map you
  // must not miss.
  conflicts: L.layerGroup().addTo(map),
  obsHandles: L.layerGroup().addTo(map),
  handles: L.layerGroup().addTo(map),
  dims: L.layerGroup().addTo(map),
  gps: L.layerGroup().addTo(map),
  poses: L.layerGroup().addTo(map),
};

/* ---------- 3D view ---------- */
const view3d = createView3D($('scene'));
let activeView = 'map';

// Split shows both at once: the map answers "where", the 3D answers "at what
// height", and the two questions come up together often enough that switching
// tabs between them is the annoying part.
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
  // Only means anything where there is a 3D view to paint. With no basemap
  // picker above it, it takes that slot rather than leaving a gap.
  $('ground').hidden = !show3d;
  $('ground').classList.toggle('solo', !showMap);
  if (showMap) map.invalidateSize();
  if (show3d) view3d.draw();
  writeUrl();
}
for (const btn of document.querySelectorAll('#viewtabs button')) {
  btn.addEventListener('click', () => setView(btn.dataset.view));
}

/* ---------- imagery on the ground of the 3D view ---------- */
// Off unless asked for. Satellite imagery is a photograph: anything with height
// leans away from nadir, so a roof lands metres from the walls under it. That is
// fine for knowing where you are and misleading for judging clearance, which is
// the question the 3D view exists to answer -- so the boxes stay the truth and
// this stays a thing you switch on.
let groundOn = false;

function pushGround() {
  if (!ready) return;   // setBasemap runs before the 3D view exists
  const spec = BASEMAPS[activeBase] ?? BASEMAPS.satellite;
  // The attribution strings are written for Leaflet's control, which renders
  // HTML. A canvas draws text, so the entity has to become the character.
  view3d.setGround({
    on: groundOn,
    url: tileUrl(spec.url),
    maxZoom: spec.maxNative,
    attribution: spec.attribution.replace(/&copy;/g, '\u00a9'),
  });
  $('ground').classList.toggle('on', groundOn);
}

function setGroundImagery(on) {
  if (groundOn === on) return;
  groundOn = on;
  pushGround();
  writeUrl();
}
$('ground').addEventListener('click', () => setGroundImagery(!groundOn));

/* ---------- the URL is where the view lives ---------- */
// One reader at startup, one writer, and nothing in between keeping a private
// copy: where you are looking is in the address bar, so a reload lands where you
// left off and a link lands someone else there too.
//
// Deliberately only the VIEW -- which basemap, which pane, where the map is
// pointed. The plan itself already lives in the hash, and the two are different
// kinds of thing: the hash is the content, the query is the camera on it. What
// stays in localStorage is what is nobody else's business and would be rude to
// force on them through a link: the split-divider position, and your default
// basemap for a visit that names none.
//
function writeUrl() {
  if (urlFrozen) return;
  const c = map.getCenter();
  const q = new URLSearchParams({
    v: activeView,
    b: activeBase,
    c: `${c.lat.toFixed(5)},${c.lng.toFixed(5)}`,
    z: String(map.getZoom()),
  });
  // Only when on, so a bare link stays short and the default stays visible in
  // its absence. Being in the URL is also what makes it survive a reload
  // without needing a preference of its own.
  if (groundOn) q.set('g', '1');
  const code = state.rect ? encodePlan(state.rect, uiValues()) : null;
  window.history.replaceState(null, '', `?${q}${code ? `#plan=${code}` : ''}`);
}

function readUrl() {
  const q = new URLSearchParams(location.search);
  if (BASEMAPS[q.get('b')]) setBasemap(q.get('b'));
  if (['map', 'split', '3d'].includes(q.get('v'))) setView(q.get('v'));
  if (q.get('g') === '1') setGroundImagery(true);
  const [lat, lon] = (q.get('c') ?? '').split(',').map(Number);
  const zoom = Number(q.get('z'));
  // A centre without a zoom, or either of them nonsense, leaves the map where
  // whatever else ran put it -- an auto-fit to the plan, or the default.
  if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180
      && Number.isFinite(zoom) && zoom >= 1 && zoom <= 22) {
    // Not animated, for two reasons. Opening a link should land where the link
    // says, not fly there from a default somewhere else. And Leaflet's animated
    // path waits on a CSS transition to finish -- which never happens in a tab
    // the browser is not painting, leaving the map showing one zoom while
    // believing it is at another.
    map.setView([lat, lon], zoom, { animate: false });
  }
}

// Panning is a view change like any other. `moveend` fires once per gesture,
// so this is one write per drag rather than one per frame.
map.on('moveend', writeUrl);
window.addEventListener('resize', () => {
  if (activeView === 'split') setSplit(splitPct, { store: false });
  else if (activeView !== 'map') view3d.draw();
});

// Where the divider sits. Which axis it moves along is the stylesheet's
// business -- the same percentage drives a left/right split on a desktop and a
// top/bottom one on a phone -- so the drag just asks which way the panes are
// stacked and measures accordingly.
const SPLIT_KEY = 'dji.split';
const stacked = () => window.matchMedia('(max-width: 780px)').matches;

// Clamped in pixels rather than percent: a pane narrower than its own floating
// controls puts the basemap picker on top of the zoom buttons, and a pane that
// thin is not showing you anything anyway.
function splitPercent(pct) {
  const r = $('stage').getBoundingClientRect();
  const total = (stacked() ? r.height : r.width) || 1;
  const min = Math.min(stacked() ? 140 : 260, total * 0.25);
  return (Math.max(min, Math.min(total - min, (pct / 100) * total)) / total) * 100;
}

function setSplit(pct, { store = true } = {}) {
  const v = splitPercent(pct);
  $('stage').style.setProperty('--split', `${v.toFixed(2)}%`);
  const mapWidth = ($('stage').getBoundingClientRect().width * v) / 100;
  $('stage').classList.toggle('tight', !stacked() && mapWidth < 250);
  if (store) { try { localStorage.setItem(SPLIT_KEY, String(v)); } catch { /* private window */ } }
  map.invalidateSize();
  view3d.draw();
}

let splitPct = 50;
try { splitPct = +localStorage.getItem(SPLIT_KEY) || 50; } catch { /* private window */ }
setSplit(splitPct, { store: false });

$('splitter').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  $('splitter').setPointerCapture(e.pointerId);
  $('splitter').classList.add('dragging');
});
$('splitter').addEventListener('pointermove', (e) => {
  if (!$('splitter').hasPointerCapture(e.pointerId)) return;
  const r = $('stage').getBoundingClientRect();
  splitPct = stacked()
    ? ((e.clientY - r.top) / r.height) * 100
    : ((e.clientX - r.left) / r.width) * 100;
  setSplit(splitPct);
});
const endSplit = () => $('splitter').classList.remove('dragging');
$('splitter').addEventListener('pointerup', endSplit);
$('splitter').addEventListener('pointercancel', endSplit);
// Double-click puts it back to even, which is easier than nudging it there.
$('splitter').addEventListener('dblclick', () => { splitPct = 50; setSplit(50); });

/* ---------- draw a rectangle by dragging ---------- */
// One rubber band, two jobs: the capture area, and a box standing in the field.
// The gesture is identical and so is the too-small guard, so the mode is a
// single value rather than two draw systems that each have to know the other
// exists.
let dragStart = null;

// The area has `layers.rect` to grow into. An obstacle has nothing until it is
// finished, so it borrows this.
const band = L.rectangle([[0, 0], [0, 0]], {
  color: OBSTACLE_COLOR.clear, weight: 2, dashArray: '5,4',
  fill: true, fillOpacity: 0.15, interactive: false,
});

$('draw').addEventListener('click', () => setDrawing(state.draw === 'area' ? null : 'area'));

const bandRect = (b) => ({ north: b.getNorth(), south: b.getSouth(), east: b.getEast(), west: b.getWest() });

function setDrawing(mode) {
  state.draw = mode;
  const area = mode === 'area';
  $('draw').classList.toggle('armed', area);
  $('draw').textContent = area ? 'Cancel — drag on the map' : (state.rect ? 'Redraw rectangle' : 'Draw rectangle');
  $('obsDraw').classList.toggle('armed', mode === 'obstacle');
  $('obsDraw').textContent = mode === 'obstacle' ? 'Cancel — drag on the map' : 'Draw obstacle';
  $('map').classList.toggle('drawing', Boolean(mode));
  if (mode) { map.dragging.disable(); map.doubleClickZoom.disable(); }
  else { map.dragging.enable(); map.doubleClickZoom.enable(); band.remove(); }
  if (ready) renderObstacles();   // they stop being clickable while drawing
}

map.on('mousedown', (e) => {
  if (!state.draw) return;
  dragStart = e.latlng;
  const b = L.latLngBounds(dragStart, dragStart);
  if (state.draw === 'area') layers.rect.setBounds(b).addTo(map);
  else band.setBounds(b).addTo(map);
});
map.on('mousemove', (e) => {
  if (!state.draw || !dragStart) return;
  const live = L.latLngBounds(dragStart, e.latlng);
  if (state.draw === 'area') { layers.rect.setBounds(live); showDims(live); }
  else { band.setBounds(live); showDims(live); }
});
map.on('mouseup', (e) => {
  if (!state.draw || !dragStart) return;
  const b = L.latLngBounds(dragStart, e.latlng);
  const mode = state.draw;
  dragStart = null;
  layers.dims.clearLayers();
  // A click with no drag is not a box. Stay armed rather than silently
  // dropping out of draw mode and leaving the user wondering what happened.
  const px = map.latLngToContainerPoint.bind(map);
  const a = px(b.getNorthWest());
  const c = px(b.getSouthEast());
  if (Math.abs(c.x - a.x) < 8 || Math.abs(c.y - a.y) < 8) {
    if (mode === 'obstacle') {
      band.remove();
      $('obsStatus').textContent = 'Too small — press and drag to size the box.';
      return;
    }
    if (!state.rect) layers.rect.remove();
    else layers.rect.setBounds([[state.rect.south, state.rect.west], [state.rect.north, state.rect.east]]);
    $('areaHint').textContent = 'Too small — press and drag to size the box.';
    return;
  }
  setDrawing(null);
  if (mode === 'area') setRect(b);
  else world.add(bandRect(b));
});

// Metre dimensions on the box edges, live while dragging. Uses the same
// ellipsoidal scaling as the planner so the labels cannot disagree with the plan.
function showDims(b) {
  layers.dims.clearLayers();
  const midLat = (b.getNorth() + b.getSouth()) / 2;
  const midLon = (b.getEast() + b.getWest()) / 2;
  // Same frame the planner uses, so the label can never disagree with the plan.
  const fr = frame(midLat, midLon);
  const c1 = fr.toLocal(b.getSouth(), b.getWest());
  const c2 = fr.toLocal(b.getNorth(), b.getEast());
  const wM = Math.abs(c2.x - c1.x);
  const hM = Math.abs(c2.y - c1.y);
  const label = (lat, lon, text) => L.marker([lat, lon], {
    interactive: false,
    icon: L.divIcon({ className: 'dimlabel', html: text, iconSize: null }),
  }).addTo(layers.dims);
  const fmt = (m) => (m < 1000 ? `${m.toFixed(0)} m` : `${(m / 1000).toFixed(2)} km`);
  label(b.getNorth(), midLon, fmt(wM));
  label(midLat, b.getEast(), fmt(hM));
  const ha = (wM * hM) / 10000;
  label(b.getSouth(), midLon, ha < 1 ? `${(wM * hM).toFixed(0)} m²` : `${ha.toFixed(2)} ha`);
}

function setRect(b) {
  applyRect(b);
  drawHandles();
  $('areaHint').textContent = 'Drag the box to move it, corners to resize.';
  autofit();
  history.commit();
}

// Geometry only -- no handles, no re-proposal. Cheap enough to run per frame
// while the box is being dragged.
function applyRect(b) {
  state.rect = { north: b.getNorth(), south: b.getSouth(), east: b.getEast(), west: b.getWest() };
  layers.rect.setBounds(b).addTo(map);
  // Adding a layer puts it on top of its pane, which would leave the capture
  // area covering every obstacle inside it -- and an obstacle you cannot click
  // is one you cannot select. The area is the backdrop you place things on, so
  // it belongs at the bottom.
  layers.rect.bringToBack();
  showDims(b);
}

/* ---------- drag the whole box ---------- */
let boxDrag = null;
let dragFrame = null;

layers.rect.on('mousedown', (e) => {
  if (state.draw || !state.rect) return;
  boxDrag = { start: e.latlng, bounds: layers.rect.getBounds() };
  map.dragging.disable();
  layers.handles.clearLayers();
  L.DomEvent.stopPropagation(e);
});

map.on('mousemove', (e) => {
  if (!boxDrag) return;
  const dLat = e.latlng.lat - boxDrag.start.lat;
  const dLon = e.latlng.lng - boxDrag.start.lng;
  const b = boxDrag.bounds;
  const moved = L.latLngBounds(
    [b.getSouth() + dLat, b.getWest() + dLon],
    [b.getNorth() + dLat, b.getEast() + dLon]
  );
  applyRect(moved);
  // Coalesce replans to one per frame; a 600-waypoint plan is cheap to compute
  // but not cheap to re-render on every mousemove.
  if (dragFrame) cancelAnimationFrame(dragFrame);
  dragFrame = requestAnimationFrame(() => { dragFrame = null; replan(); });
});

map.on('mouseup', () => {
  if (!boxDrag) return;
  boxDrag = null;
  map.dragging.enable();
  if (dragFrame) { cancelAnimationFrame(dragFrame); dragFrame = null; }
  drawHandles();
  replan();
  // One entry for the whole drag, not one per frame of it.
  history.commit();
});

function drawHandles() {
  layers.handles.clearLayers();
  const r = state.rect;
  const corners = [
    ['ns', 'we', r.north, r.west], ['ns', 'we', r.north, r.east],
    ['ns', 'we', r.south, r.west], ['ns', 'we', r.south, r.east],
  ];
  for (const [, , lat, lon] of corners) {
    const m = L.marker([lat, lon], {
      draggable: true,
      icon: L.divIcon({ className: 'handle', iconSize: [12, 12] }),
    }).addTo(layers.handles);
    m.on('drag', (e) => {
      const p = e.target.getLatLng();
      // the opposite corner stays put
      const oppLat = Math.abs(lat - state.rect.north) < 1e-9 ? state.rect.south : state.rect.north;
      const oppLon = Math.abs(lon - state.rect.west) < 1e-9 ? state.rect.east : state.rect.west;
      const live = L.latLngBounds([p.lat, p.lng], [oppLat, oppLon]);
      layers.rect.setBounds(live);
      showDims(live);
    });
    m.on('dragend', () => { setRect(layers.rect.getBounds()); });
  }
}

/* ---------- saying what just happened ---------- */
// Undo and auto-adjust both change the plan on the map rather than anything in
// the panel, and a change you did not see is indistinguishable from one that
// did not happen. This is the only place either of them speaks.
let toastTimer = null;

function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  el.classList.remove('fading');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.add('fading');
    toastTimer = setTimeout(() => { el.hidden = true; }, 260);
  }, 2600);
}

/* ---------- obstacles on the map ---------- */
// Every obstacle is drawn on every view, because "what is already there" is
// context for planning, not a mode you switch into. Only the obstacles view
// makes them touchable: a box you can grab is a box you can move by accident
// while dragging the capture area over it.

// Far enough that no leg of a Mini-class mission reaches out of it, near enough
// that the global list never turns into a per-frame cost. Obstacles beyond this
// cannot affect a plan, so they are never converted or measured.
const NEARBY_DEG = 0.01;   // about 1.1 km

function nearbyObstacles(rect) {
  if (!rect) return [];
  const pad = {
    north: rect.north + NEARBY_DEG, south: rect.south - NEARBY_DEG,
    east: rect.east + NEARBY_DEG, west: rect.west - NEARBY_DEG,
  };
  return world.list().filter((o) => overlaps(o, pad));
}

const gradeOf = (id) => state.hazard?.obstacles.find((o) => o.id === id)?.grade ?? 'clear';

let obsDrag = null;

function renderObstacles() {
  layers.obstacles.clearLayers();
  layers.obsHandles.clearLayers();
  // Clickable from every view, not just the obstacles one. What is standing
  // there is context you read while planning, and having to change panes before
  // you can point at a building is a rule about this app rather than about the
  // site. Drawing is the one exception: while a rubber band is armed, a press
  // on the map means the band and nothing else.
  const live = !state.draw;
  for (const o of world.list()) {
    const grade = gradeOf(o.id);
    const on = world.selected() === o.id;
    const box = L.rectangle([[o.south, o.west], [o.north, o.east]], {
      color: OBSTACLE_COLOR[grade],
      weight: on ? 2.5 : 1.5,
      fill: true,
      fillOpacity: grade === 'clear' ? 0.12 : 0.24,
      interactive: live,
      className: 'obsbox',
    }).addTo(layers.obstacles);
    if (!live) continue;
    box.bindTooltip(`${describe(o)} · ${o.height} m`, { direction: 'top', sticky: true });
    // Selecting and moving are the same gesture: press, and either let go
    // (select) or drag (move). Re-rendering on the press would destroy the
    // layer the drag is holding, so nothing is redrawn until the mouse is up.
    box.on('mousedown', (e) => {
      obsDrag = { id: o.id, start: e.latlng, bounds: box.getBounds(), box, moved: false };
      map.dragging.disable();
      layers.obsHandles.clearLayers();
      L.DomEvent.stopPropagation(e);
    });
    if (on) obstacleHandles(o, box);
  }
}

map.on('mousemove', (e) => {
  if (!obsDrag) return;
  const dLat = e.latlng.lat - obsDrag.start.lat;
  const dLon = e.latlng.lng - obsDrag.start.lng;
  if (Math.abs(dLat) > 1e-7 || Math.abs(dLon) > 1e-7) obsDrag.moved = true;
  const b = obsDrag.bounds;
  obsDrag.box.setBounds(L.latLngBounds(
    [b.getSouth() + dLat, b.getWest() + dLon],
    [b.getNorth() + dLat, b.getEast() + dLon],
  ));
});

map.on('mouseup', () => {
  if (!obsDrag) return;
  const { id, box, moved } = obsDrag;
  obsDrag = null;
  map.dragging.enable();
  if (moved) { world.reshape(id, bandRect(box.getBounds())); return; }
  // Same as clicking one in the 3D view: selecting a box is asking to work on
  // it, so the pane holding its name, its height and its delete comes with it.
  const next = world.selected() === id ? null : id;
  if (next) menu.show('world');
  world.select(next);
});

function obstacleHandles(o, box) {
  for (const [lat, lon] of [[o.north, o.west], [o.north, o.east], [o.south, o.west], [o.south, o.east]]) {
    const mk = L.marker([lat, lon], {
      draggable: true,
      icon: L.divIcon({ className: 'handle obs', iconSize: [12, 12] }),
    }).addTo(layers.obsHandles);
    mk.on('drag', (e) => {
      const p = e.target.getLatLng();
      // the opposite corner stays put
      const oppLat = Math.abs(lat - o.north) < 1e-9 ? o.south : o.north;
      const oppLon = Math.abs(lon - o.west) < 1e-9 ? o.east : o.west;
      const live = L.latLngBounds([p.lat, p.lng], [oppLat, oppLon]);
      box.setBounds(live);
      showDims(live);
    });
    mk.on('dragend', () => {
      layers.dims.clearLayers();
      world.reshape(o.id, bandRect(box.getBounds()));
    });
  }
}

// The flagged legs, laid over the path in the colour of the news. Drawn from
// the collision result rather than re-derived, so what you see red is exactly
// what the panel counted.
function renderConflicts() {
  layers.conflicts.clearLayers();
  for (const leg of state.hazard?.legs ?? []) {
    L.polyline([[leg.a.lat, leg.a.lon], [leg.b.lat, leg.b.lon]], {
      color: OBSTACLE_COLOR[leg.grade],
      weight: leg.grade === 'strike' ? 4 : 3,
      opacity: 0.95,
      interactive: false,
    }).addTo(layers.conflicts);
  }
}

/* ---------- where I am ---------- */
// A box of `side` metres centred on a lat/lon, built with the same ellipsoidal
// scaling the planner uses so the drawn size matches the plan.
function boxAround(lat, lon, sideX, sideY) {
  const dLat = sideY / 2 / mPerDegLat(lat);
  const dLon = sideX / 2 / mPerDegLon(lat);
  return L.latLngBounds([lat - dLat, lon - dLon], [lat + dLat, lon + dLon]);
}

// A box that already exists keeps its size and just moves -- resizing is a
// separate decision from placing, and having to redo it every time you move
// somewhere is the annoying part.
function dropBoxAt(lat, lon) {
  const sideX = state.rect ? state.mission?.sizeX ?? 30 : 30;
  const sideY = state.rect ? state.mission?.sizeY ?? 30 : 30;
  setRect(boxAround(lat, lon, sideX, sideY));
}

const GPS_ERRORS = {
  1: 'Location permission was denied. Allow it in the address bar, or pan the map instead.',
  2: 'Your device could not get a position. On a laptop that usually means Wi-Fi positioning is unavailable.',
  3: 'Locating timed out. Try again, or pan the map instead.',
};

const FRESH_ENOUGH_MS = 15000;  // stop early once a fix is this new
const STALE_MS = 120000;        // past this, say so rather than pretend
const WATCH_MS = 9000;          // how long to keep asking for a better fix

// getCurrentPosition on a laptop hands back whatever macOS or Windows last
// worked out from visible Wi-Fi -- observed 32 minutes stale even with
// maximumAge: 0, which the platform is free to ignore. watchPosition keeps the
// provider producing fixes, so we take the best one that arrives in a few
// seconds and report its age instead of trusting it blindly.
function bestFix({ onProgress } = {}) {
  return new Promise((resolve, reject) => {
    let best = null;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      navigator.geolocation.clearWatch(id);
      clearTimeout(timer);
      best ? resolve(best) : reject({ code: 3, message: 'no fix' });
    };
    const better = (a, b) => {
      if (!b) return true;
      const aFresh = a.age < FRESH_ENOUGH_MS;
      const bFresh = b.age < FRESH_ENOUGH_MS;
      if (aFresh !== bFresh) return aFresh;        // fresh beats accurate
      return a.accuracy < b.accuracy;
    };
    const id = navigator.geolocation.watchPosition(
      (p) => {
        const fix = {
          lat: p.coords.latitude,
          lon: p.coords.longitude,
          accuracy: p.coords.accuracy,
          age: Date.now() - p.timestamp,
        };
        if (better(fix, best)) best = fix;
        onProgress?.(best);
        if (best.age < FRESH_ENOUGH_MS && best.accuracy <= 30) finish();
      },
      (err) => { if (!best) { done = true; clearTimeout(timer); reject(err); } },
      { enableHighAccuracy: true, timeout: WATCH_MS, maximumAge: 0 },
    );
    const timer = setTimeout(finish, WATCH_MS);
  });
}

$('locate').addEventListener('click', async () => {
  if (!navigator.geolocation) {
    $('areaHint').textContent = 'This browser has no location support — pan the map instead.';
    return;
  }
  const btn = $('locate');
  btn.disabled = true;
  btn.textContent = 'Locating…';
  $('areaHint').textContent = 'Asking your device for a position…';
  $('placeAnyway').hidden = true;

  let fix;
  try {
    fix = await bestFix({
      onProgress: (f) => {
        $('areaHint').textContent = `Fix so far: ±${f.accuracy.toFixed(0)} m, ${(f.age / 1000).toFixed(0)} s old — still trying…`;
      },
    });
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Where I am';
    $('areaHint').textContent = GPS_ERRORS[err.code] ?? `Could not locate you: ${err.message}`;
    return;
  }

  btn.disabled = false;
  btn.textContent = 'Where I am';
  const { lat, lon, accuracy, age } = fix;

  layers.gps.clearLayers();
  L.circle([lat, lon], {
    radius: Math.max(accuracy, 1),
    color: '#4da3ff', weight: 1, fillOpacity: 0.08, interactive: false,
  }).addTo(layers.gps);
  L.marker([lat, lon], {
    icon: L.divIcon({ className: 'gpsdot', iconSize: [12, 12] }),
    interactive: false,
  }).addTo(layers.gps)
    .bindTooltip(`±${accuracy.toFixed(0)} m · ${age < 1000 ? 'live' : `${(age / 1000).toFixed(0)} s old`}`);

  const stale = age > STALE_MS;
  const rough = accuracy > 25;
  const place = () => dropBoxAt(lat, lon);

  map.setView([lat, lon], Math.max(map.getZoom(), 19));

  if (stale) {
    // A laptop with no GPS reuses the last Wi-Fi position, which can be an old
    // one from somewhere else entirely. Centre the map so it can be checked,
    // but do not move the box without being asked.
    $('areaHint').textContent = `That fix is ${Math.round(age / 60000)} min old — your laptop reused a cached Wi-Fi position rather than measuring a new one. Map centred here; check it looks right.`;
    $('placeAnyway').hidden = false;
    $('placeAnyway').onclick = () => {
      place();
      $('placeAnyway').hidden = true;
      $('areaHint').textContent = `Box placed on the ${Math.round(age / 60000)} min old fix (±${accuracy.toFixed(0)} m). Drag it onto the subject.`;
    };
    return;
  }

  $('placeAnyway').hidden = true;
  place();
  $('areaHint').textContent = rough
    ? `Box placed, but the fix is only ±${accuracy.toFixed(0)} m — drag it onto the subject.`
    : `Box placed at your position (±${accuracy.toFixed(0)} m). Drag to adjust.`;
});

/* ---------- place search ---------- */
async function search() {
  const q = $('q').value.trim();
  if (!q) return;
  $('go').textContent = '…';
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`);
    const j = await r.json();
    if (j[0]) {
      map.setView([+j[0].lat, +j[0].lon], 17);
      $('areaHint').textContent = `Found ${j[0].display_name.split(',').slice(0, 2).join(',')}. Drop a box, or draw one.`;
    } else $('areaHint').textContent = 'Nothing found for that search.';
  } catch {
    $('areaHint').textContent = 'Search unavailable — pan the map instead.';
  }
  $('go').textContent = 'Find';
}
$('go').addEventListener('click', search);
$('q').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); search(); } });

// Search moves the map; Drop commits to it. Two steps because a geocoder result
// is a guess -- you want to look at the imagery before a box lands on it.
$('drop').addEventListener('click', () => {
  const c = map.getCenter();
  const had = Boolean(state.rect);
  dropBoxAt(c.lat, c.lng);
  $('placeAnyway').hidden = true;
  $('areaHint').textContent = had
    ? 'Box moved. Drag it, or resize with the corners.'
    : 'Box dropped. Drag it, or resize with the corners.';
});
$('q').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); search(); } });

/* ---------- params ---------- */
const controls = {
  altitude: { el: $('altitude'), fmt: (v) => `${v} m`, val: (v) => +v },
  frontOverlap: { el: $('frontOverlap'), fmt: (v) => `${v}%`, val: (v) => +v / 100 },
  sideOverlap: { el: $('sideOverlap'), fmt: (v) => `${v}%`, val: (v) => +v / 100 },
  speed: { el: $('speed'), fmt: (v) => `${(+v).toFixed(1)} m/s`, val: (v) => +v },
  orbitPad: { el: $('orbitPad'), fmt: (v) => `${v} m`, val: (v) => +v },
  subjectHeight: { el: $('subjectHeight'), fmt: (v) => `${v} m`, val: (v) => +v },
};
controls.altitude.el.value = DEFAULTS.altitude;
controls.frontOverlap.el.value = DEFAULTS.frontOverlap * 100;
controls.sideOverlap.el.value = DEFAULTS.sideOverlap * 100;
controls.speed.el.value = DEFAULTS.speed;
controls.orbitPad.el.value = DEFAULTS.orbitPad;
controls.subjectHeight.el.value = DEFAULTS.subjectHeight;

// The values the controls are actually showing, which is what a plan code
// stores. readParams() derives from these; restoring has to go the other way.
function uiValues() {
  const v = {};
  for (const k of Object.keys(controls)) v[k] = +controls[k].el.value;
  for (const id of ['nadir', 'oblique', 'orbit', 'transect']) v[id] = $(id).checked;
  v.photoMode = $('photoMode').value;
  v.profile = $('profile').value;
  v.shotsPerStop = +$('shotsPerStop').value;
  v.orbitRings = +$('orbitRings').value;
  v.orbitHeights = state.orbitHeights;
  v.transectHeights = state.transectHeights;
  return v;
}

function applyUiValues(v) {
  state.orbitHeights = v.orbitHeights ?? null;
  state.transectHeights = v.transectHeights ?? null;
  for (const k of Object.keys(controls)) if (v[k] !== undefined) controls[k].el.value = v[k];
  for (const id of ['nadir', 'oblique', 'orbit', 'transect']) if (v[id] !== undefined) $(id).checked = v[id];
  for (const id of ['photoMode', 'profile', 'shotsPerStop', 'orbitRings'])
    if (v[id] !== undefined) $(id).value = String(v[id]);
}

// Planner params out of stored UI values. Everything that plans -- the live
// controls and a saved code alike -- comes through here, so the two can never
// drift apart.
function paramsFromUi(v) {
  const p = {};
  for (const [k, c] of Object.entries(controls)) p[k] = c.val(v[k]);
  for (const id of ['nadir', 'oblique', 'orbit', 'transect']) p[id] = v[id];
  p.photoMode = v.photoMode;
  p.shotsPerStop = v.shotsPerStop;
  p.orbitRings = v.orbitRings;
  p.orbitHeights = v.orbitHeights ?? null;
  p.transectHeights = v.transectHeights ?? null;
  return p;
}

function readParams() {
  for (const [k, c] of Object.entries(controls)) $(k + 'Out').textContent = c.fmt(c.el.value);
  return paramsFromUi(uiValues());
}

const override = () => {
  state.autofitNote = null;
  state.autofitAlt = null;
  // Heights dragged in the 3D view are relative to nothing once a slider
  // moves, so touching a control is also how you get the derived spread back.
  state.orbitHeights = null;
  state.transectHeights = null;
  replan();
};
for (const c of Object.values(controls)) c.el.addEventListener('input', override);
for (const id of ['nadir', 'oblique', 'orbit', 'transect', 'photoMode', 'profile', 'shotsPerStop', 'orbitRings'])
  $(id).addEventListener('change', override);

/* ---------- plan + render ---------- */
// Redrawing the box re-proposes from scratch; touching a slider afterwards is
// treated as an override and only replans.
function autofit() {
  if (!state.rect) return;
  const base = readParams();
  const { mission, fits, note, alternative } = proposePlan(state.rect, base, cam);
  if (!mission) return;
  controls.altitude.el.value = mission.params.altitude;
  $('photoMode').value = mission.params.photoMode;
  $('shotsPerStop').value = String(mission.stats.shotsPerStop);
  $('orbitRings').value = String(mission.params.orbitRings ?? 1);
  state.autofitNote = fits ? note : note;
  state.autofitAlt = alternative;
  // An auto-fit re-derives the whole plan, including how many rings there are,
  // so heights pinned against the old one no longer refer to anything.
  state.orbitHeights = null;
  state.transectHeights = null;
  replan();
}
$('autofit').addEventListener('click', () => { autofit(); history.commit(); });

// Dragging a level in the 3D view writes back to whatever set that height. The
// level the grids fly at IS the altitude, so dragging it moves the slider and
// everything derived from it; a single orbit ring or cross-pass level instead
// gets pinned, leaving the rest of the spread alone.
view3d.onLevelChange((handles, z) => {
  if (!state.mission) return;
  if (handles.some((hd) => hd.kind === 'altitude')) {
    const el = controls.altitude.el;
    const v = Math.round(Math.max(+el.min || 1, Math.min(+el.max || 200, z)));
    if (+el.value === v) return;
    el.value = v;
    state.autofitNote = null;
    state.autofitAlt = null;
    replan();
    return;
  }
  const ceiling = +controls.altitude.el.value;
  const pinned = Math.round(Math.max(1, Math.min(ceiling, z)) * 10) / 10;
  const used = state.mission.heights;
  let changed = false;
  for (const hd of handles) {
    const cur = hd.kind === 'orbit' ? state.orbitHeights ?? used.orbit
      : hd.kind === 'transect' ? state.transectHeights ?? used.transect : null;
    if (!cur || cur[hd.index] === undefined || cur[hd.index] === pinned) continue;
    const next = cur.slice();
    next[hd.index] = pinned;
    if (hd.kind === 'orbit') state.orbitHeights = next;
    else state.transectHeights = next;
    changed = true;
  }
  if (changed) replan();
});


// Everything downstream of "which boxes are where", without replanning the
// flight. An obstacle moving or growing changes what the flight is measured
// AGAINST, not the flight itself -- so a drag can track the pointer instead of
// paying for a fresh plan and a fresh coverage score on every frame.
function recheck() {
  if (!state.mission) { renderObstacles(); renderFixBar(); return; }
  const boxes = nearbyObstacles(state.rect).map((o) => localBox(o, state.mission.frame));
  state.hazard = checkObstacles(state.mission, boxes, { clearance: world.clearance() });
  state.clearAlt = null;
  world.setReport(state.hazard);
  renderObstacles();
  renderConflicts();
  renderHazard();
  renderFixBar();
  view3d.setObstacles(graded(boxes), state.hazard.legs);
}

function replan() {
  const p = readParams();
  $('gsdHint').textContent = `${gsdCm(cam, p.altitude).toFixed(2)} cm/px ground resolution`;
  // No area, no flight -- and so nothing true left to say about what it hits.
  // Undo can land here, which is the only way it happens after startup, and a
  // hazard warning about a plan that no longer exists is worse than none.
  if (!state.rect) {
    state.mission = null;
    state.hazard = null;
    state.clearAlt = null;
    world.setReport(null);
    for (const g of [layers.path, layers.dots, layers.poses, layers.conflicts]) g.clearLayers();
    $('stats').className = 'stats empty';
    $('stats').textContent = 'Draw an area to see the proposed flight.';
    $('passList').innerHTML = '';
    $('sizeHint').textContent = '';
    $('warn').hidden = true;
    $('autofit').hidden = true;
    renderHazard();
    renderFixBar();
    renderObstacles();
    view3d.setMission(null);
    view3d.setObstacles([], []);
    writeUrl();   // no plan left to name in the address bar either
    return;
  }
  if (!p.nadir && !p.oblique && !p.orbit && !p.transect) {
    state.mission = null;
    state.hazard = null;
    state.clearAlt = null;
    world.setReport(null);
    layers.path.clearLayers(); layers.dots.clearLayers(); layers.conflicts.clearLayers();
    $('stats').className = 'stats empty';
    $('stats').textContent = 'Enable at least one pass.';
    $('passList').innerHTML = '';
    $('autofit').hidden = true;
    renderHazard();
    renderFixBar();
    return;
  }
  state.mission = planMission(state.rect, p, cam);
  // The obstacles near this plan, in its own local metres. They do two jobs:
  // they are what the flight is measured against, and they block the camera --
  // the coverage score stops counting a surface it can only see through one of
  // them. They are never scored themselves.
  const boxes = nearbyObstacles(state.rect).map((o) => localBox(o, state.mission.frame));
  // Cap the camera count so scoring stays interactive on big plans; the CLI
  // (tools/compare.mjs) scores every frame.
  state.coverage = scoreCoverage(state.mission, { maxCameras: 220, boxes });
  state.hazard = checkObstacles(state.mission, boxes, { clearance: world.clearance() });
  // The fix costs several trial plans, and a drag replans on every frame. It is
  // not news you can act on mid-gesture anyway, so it waits for you to let go.
  state.clearAlt = (state.hazard.strikes || state.hazard.near) && !boxDrag && !obsDrag
    ? clearingFix(p, boxes)
    : null;
  world.setReport(state.hazard);
  renderPath(state.mission);
  renderObstacles();
  renderConflicts();
  if (state.onDevice) showRoute(null);
  renderStats(state.mission);
  view3d.setMission(state.mission, state.coverage);
  view3d.setObstacles(graded(boxes), state.hazard.legs);
}

// The same boxes the check ran on, each carrying its verdict and whether it is
// the one being worked on -- which is all either view needs to draw them.
const graded = (boxes) => boxes.map((b) => ({
  ...b, grade: gradeOf(b.id), selected: world.selected() === b.id,
}));

// Selecting a box changes how it is drawn in both views and nothing else, so it
// needs neither a replan nor a re-measure. Without this the 3D view keeps the
// old selection until something else happens to invalidate it.
function showSelection() {
  renderObstacles();
  if (!state.mission) return;
  const boxes = nearbyObstacles(state.rect).map((o) => localBox(o, state.mission.frame));
  view3d.setObstacles(graded(boxes), state.hazard?.legs ?? []);
}

// An altitude at which this plan genuinely clears everything -- found by
// planning it and measuring it, not by adding the clearance to the tallest box.
//
// Arithmetic gets it wrong in a way that matters. Raising the altitude lifts
// the grids, but the orbit rings spread DOWNWARD from it, so the leg that
// descends to the lowest ring still cuts across the site. Measured on a real
// scene, the arithmetic floor was 31 m and the altitude that actually cleared
// it was 65 -- so a march upward from the floor in fixed steps either stops
// short or costs a dozen trial plans.
//
// Climbing helps monotonically in every case worth planning, so binary search
// finds the lowest clean altitude in about eight trials over the whole slider.
// It is a search, not a proof: what makes the answer safe is that only an
// altitude whose own trial came back clean is ever returned.
//
// The local frame comes from the rectangle alone, so the boxes hold good across
// every trial. Only ever run when there is already bad news to act on.
function lowestClearing(base, boxes, from) {
  const clearance = world.clearance();
  const max = +controls.altitude.el.max;
  if (from > max) return null;

  const clears = (alt) => {
    const trial = planMission(state.rect, { ...base, altitude: alt }, cam);
    const check = checkObstacles(trial, boxes, { clearance });
    return !check.strikes && !check.near;
  };

  // The ceiling is the one altitude worth testing first: if the highest the
  // slider goes does not clear the site, nothing does, and the answer is to
  // move the box rather than to climb. That is one trial, not a whole search.
  if (!clears(max)) return null;
  if (clears(from)) return from;

  let lo = from;   // known not to clear
  let hi = max;    // known to clear
  while (hi - lo > 1) {
    const mid = Math.round((lo + hi) / 2);
    if (clears(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

// The floor below which no altitude can help: you cannot clear a box by flying
// under it. Cheap, and it saves the search several trials.
const clearingFloor = (boxes) =>
  Math.ceil(clearingAltitude(state.mission, boxes, world.clearance()) ?? 0);

// What the panel offers: raise the altitude, and nothing else.
const clearingFix = (base, boxes) =>
  lowestClearing(base, boxes, Math.max(clearingFloor(boxes), +controls.altitude.el.value + 1));

// Everything the planner can change to get out of the way, tried in the order a
// person would try them.
//
// Altitude first, always: it is one number, it is the number the resolution
// hint is about, and it fixes anything the flight passes OVER. When it cannot,
// the reason is almost always a thing standing BESIDE the orbit -- a mast, a
// gable end -- which no amount of climbing clears, because the ring goes round
// it at every height. That one is fixed by pushing the ring outwards, and it
// costs only the orbit pass rather than the resolution of the whole flight.
//
// Both are searched the same way and neither is guessed: an answer is returned
// only if a trial plan built with it came back with nothing hit and nothing
// inside the clearance.
const PAD_STEP = 5;

function autoAdjust() {
  if (!state.mission || !state.rect) return null;
  const base = readParams();
  const boxes = nearbyObstacles(state.rect).map((o) => localBox(o, state.mission.frame));
  if (!boxes.length) return null;

  const alt = clearingFix(base, boxes);
  if (alt !== null) return { altitude: alt };

  // Widening the ring changes the geometry the altitude search is working
  // against, so each pad gets its own search rather than reusing the last
  // answer. The current altitude is allowed here -- a wider orbit may clear the
  // site without climbing at all, which is the better fix when it exists.
  const padEl = controls.orbitPad.el;
  const floor = Math.max(clearingFloor(boxes), +controls.altitude.el.min);
  for (let pad = +padEl.value + PAD_STEP; pad <= +padEl.max; pad += PAD_STEP) {
    const withPad = { ...base, orbitPad: pad };
    const a = lowestClearing(withPad, boxes, Math.max(floor, +controls.altitude.el.value));
    if (a !== null) return { altitude: a, orbitPad: pad };
  }
  return null;
}

const PLAN_GROUPS = () => ({ path: layers.path, dots: layers.dots, poses: layers.poses });
const DEVICE_GROUPS = () => ({ path: layers.devicePath, dots: layers.deviceDots, poses: layers.devicePoses });

// `dashed` is the only difference between a plan and what is on the controller:
// same colours, same pose ticks, same dot thinning, with a dark casing under
// white dashes so a device route stays legible on any basemap and never reads
// as yours.
function renderPath(m, { groups = PLAN_GROUPS(), dashed = false } = {}) {
  groups.path.clearLayers();
  groups.dots.clearLayers();
  let run = [];
  let runPass = null;
  const flush = () => {
    if (run.length > 1) {
      if (dashed) {
        L.polyline(run, { color: '#12181f', weight: 4.5, opacity: 0.5, interactive: false })
          .addTo(groups.path);
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
    const end = map.layerPointToLatLng(
      L.point(p0.x + Math.sin(yaw) * lead, p0.y - Math.cos(yaw) * lead)
    );
    L.polyline([[w.lat, w.lon], end], {
      color: PASS_COLOR[w.pass], weight: 1.2, opacity: 0.75, interactive: false,
    }).addTo(groups.poses);
  });

  const step = Math.max(1, Math.ceil(m.waypoints.length / 400)); // keep the map responsive
  m.waypoints.forEach((w, i) => {
    if (i % step) return;
    L.marker([w.lat, w.lon], {
      icon: L.divIcon({ className: 'wpdot', iconSize: [5, 5] }),
      interactive: false,
    }).addTo(groups.dots)._icon.style.background = PASS_COLOR[w.pass];
  });

  L.circleMarker([m.waypoints[0].lat, m.waypoints[0].lon],
    { radius: 6, color: dashed ? '#12181f' : '#fff', weight: 2,
      fillColor: PASS_COLOR[m.waypoints[0].pass], fillOpacity: 1 })
    .addTo(groups.path).bindTooltip(dashed ? 'On the controller' : 'Start');
}

const fmtM = (v) => `${Number.isInteger(v) ? v : v.toFixed(1)} m`;

// Round to whole seconds first, or 959.7 s renders as "15:60".
const mmss = (s) => {
  const t = Math.round(s);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};

function renderStats(m) {
  const s = m.stats;
  const parts = splitMission(m);
  $('stats').className = 'stats';
  $('stats').innerHTML = [
    ['Photos', s.photos],
    ['Waypoints', `${s.waypoints} / ${DJI_FLY_MAX_WAYPOINTS}`],
    ['Flight time', mmss(s.seconds)],
    ['Batteries', `${s.batteries}×`],
    ['Distance', `${(s.distanceM / 1000).toFixed(2)} km`],
    ['GSD', `${s.gsdCm.toFixed(2)} cm/px`],
    ['Coverage', `${(state.coverage?.summary.good ?? 0).toFixed(0)}%`],
    ['Down-angle', `${(state.coverage?.summary.withDownAngle ?? 0).toFixed(0)}%`],
  ].map(([k, v]) => {
    const cls = k === 'Waypoints' ? (s.waypoints > DJI_FLY_MAX_WAYPOINTS ? ' over' : ' fits') : '';
    return `<div class="stat${cls}"><b>${v}</b><span>${k}</span></div>`;
  }).join('');

  $('passList').innerHTML = m.passes.map((p) => {
    const n = p.name.toLowerCase();
    const key = n.includes('nadir') ? 'nadir'
      : n.includes('oblique') ? 'oblique'
      : n.includes('cross') ? 'transect' : 'orbit';
    return `<div class="passrow"><i style="background:${PASS_COLOR[key]}"></i>
      <b>${p.name}</b> <span>${p.detail}</span><span class="c">${p.count}</span></div>`;
  }).join('');

  const warns = [];
  if (state.autofitNote) warns.push(state.autofitNote);
  if (m.params.photoMode === 'waypoint' && s.waypoints > DJI_FLY_MAX_WAYPOINTS) {
    warns.push(`${s.waypoints} waypoints exceeds DJI Fly's limit of ${DJI_FLY_MAX_WAYPOINTS} — exporting as ${parts.length} parts to fly back to back. Raise the altitude, drop a pass, or switch the shutter to distance interval to fit one mission.`);
  } else if (s.waypoints > DJI_FLY_MAX_WAYPOINTS) {
    warns.push(`${s.waypoints} waypoints exceeds DJI Fly's limit — exporting as ${parts.length} parts.`);
  }
  const cs = state.coverage?.summary;
  if (cs && cs.unseen > 5) {
    warns.push(`${cs.unseen.toFixed(0)}% of modelled surface is never seen. Add cross passes, another ring, or a wider frame fan.`);
  }
  if (cs && cs.withDownAngle < 30 && (m.params.subjectHeight ?? 0) > 0.5) {
    warns.push(`Only ${cs.withDownAngle.toFixed(0)}% of surface is seen from above. Nothing reconstructs a top it never saw — add the nadir grid or a higher ring.`);
  }
  if (m.params.photoMode === 'waypoint') {
    warns.push(`Set the camera to Single shot in DJI Fly before launching. A Timed Interval left set there keeps firing through every hover, and this mission hovers at all ${s.waypoints} waypoints — a flight on 28 Aug 2026 came back 41% duplicates that way (docs/2026-08-28-duplicate-frames.md).`);
  }
  if (m.params.altitude > 120) warns.push('Above 120 m AGL is outside EU/US open-category limits.');
  if (m.params.altitude < 12) warns.push('Below ~12 m the mission depends on GNSS that canopy degrades, and vision sensing misses thin branches. Set obstacle avoidance to Brake and keep line of sight.');
  if (s.batteries > 1) warns.push(`Plan needs about ${s.batteries} batteries at ${m.params.usableFlightMin} min usable each.`);
  $('warn').hidden = warns.length === 0;
  $('warn').innerHTML = warns.map((w) => `<div>${w}</div>`).join('');

  // Nothing to re-propose while the plan already fits a single mission.
  $('autofit').hidden = parts.length < 2;

  $('altnote').hidden = !state.autofitAlt;
  $('altnote').textContent = state.autofitAlt || '';

  renderHazard();
  renderFixBar();

  $('sizeHint').textContent = `${m.sizeX.toFixed(0)} × ${m.sizeY.toFixed(0)} m · ${s.areaHa.toFixed(2)} ha · lines ${s.sideSpacing.toFixed(1)} m apart, shots every ${s.fwdSpacing.toFixed(1)} m`;

  // The plan is half of what the URL says; writeUrl composes it with the other
  // half rather than each of them stamping on the other's part of the address.
  writeUrl();
}

// What the flight hits, said where you are looking at the flight. The obstacles
// view has the full list; this is the part you cannot be allowed to miss while
// reading the stats, so it names the worst few and offers the one fix that is a
// single number away.
function renderHazard() {
  const el = $('hazard');
  const h = state.hazard;
  el.innerHTML = '';
  el.hidden = !h || (!h.strikes && !h.near);
  if (el.hidden) return;

  el.classList.toggle('strike', h.strikes > 0);
  const head = document.createElement('b');
  head.textContent = h.strikes
    ? `The flight passes through ${h.strikes} obstacle${h.strikes === 1 ? '' : 's'}.`
    : `${h.near} obstacle${h.near === 1 ? '' : 's'} within ${fmtM(h.clearance)} of the flight.`;
  el.append(head);

  for (const o of h.obstacles.filter((x) => x.grade).slice(0, 5)) {
    const row = document.createElement('div');
    row.className = `hazrow ${o.grade}`;
    const what = o.name || `${fmtM(o.height)} box`;
    row.textContent = o.grade === 'strike'
      ? `${what} — ${o.legs} leg${o.legs === 1 ? '' : 's'} go through it`
      : `${what} — ${fmtM(o.dist)} at the closest`;
    el.append(row);
  }

  // Offered only when it has been checked. A mast beside the orbit is not
  // solved by climbing, and there is no altitude to suggest for it -- saying
  // nothing is much better than a button that does not do what it says.
  if (state.clearAlt) {
    const fix = document.createElement('button');
    fix.type = 'button';
    fix.className = 'linkish';
    fix.textContent = `Raise the altitude to ${state.clearAlt} m — that clears everything by ${fmtM(h.clearance)}`;
    fix.addEventListener('click', () => { controls.altitude.el.value = state.clearAlt; override(); });
    el.append(fix);
  }
}

// The same news as the panel, on the stage, because the stage is where you are
// looking when it matters. Only ever appears when there is something to act on.
function renderFixBar() {
  const h = state.hazard;
  const bar = $('fixbar');
  const bad = Boolean(h && (h.strikes || h.near));
  bar.hidden = !bad;
  if (!bad) return;
  bar.classList.toggle('near', !h.strikes);
  $('fixnote').textContent = h.strikes
    ? `Flight goes through ${h.strikes} obstacle${h.strikes === 1 ? '' : 's'}`
    : `${h.near} within ${fmtM(h.clearance)} of the flight`;
}

// Search for something the planner can change, apply it, and say what it was.
// The search costs a few dozen trial plans, which is why it happens on a click
// rather than on every replan.
function applyAdjust() {
  const btn = $('fixgo');
  if (btn.disabled) return;
  btn.disabled = true;
  btn.textContent = 'Looking…';
  // A timer, not requestAnimationFrame: rAF does not fire while the tab is
  // hidden, so switching away mid-click left the search unstarted and the
  // button saying "Looking…" for ever. The delay exists only to let that label
  // paint before the search blocks the thread; the try/finally is what
  // guarantees the button comes back either way.
  setTimeout(() => {
    let fix = null;
    try {
      fix = autoAdjust();
    } finally {
      btn.disabled = false;
      btn.textContent = 'Adjust';
    }
    if (!fix) {
      toast('Nothing the altitude or the orbit offset can do clears this. '
            + 'Move the box, or check the obstacle heights.');
      return;
    }
    const said = [`altitude ${fix.altitude} m`];
    if (fix.orbitPad !== undefined) {
      controls.orbitPad.el.value = fix.orbitPad;
      said.push(`orbit offset ${fix.orbitPad} m`);
    }
    controls.altitude.el.value = fix.altitude;
    override();
    history.commit();
    toast(`Adjusted to ${said.join(' and ')} — clears everything by ${fmtM(world.clearance())}.`);
  }, 16);
}
$('fixgo').addEventListener('click', applyAdjust);

/* ---------- export ---------- */
function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID().toUpperCase();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  }).toUpperCase();
}

// KMZ files come out of Saved plans, not out of the plan being drawn: a flight
// worth putting on the aircraft is a flight worth keeping. The file name is a
// UUID because that is what DJI Fly wants it renamed to anyway -- one less
// thing to get wrong at the controller.
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

// A mission read back off the controller, drawn over the plan rather than
// instead of it -- the point is comparing what is there with what you are about
// to replace it with. Dashed and pale so it never looks like your plan.
// A mission read off the controller becomes the same kind of thing the planner
// produces, so it draws through renderPath and flies through the 3D view with
// its frustum wedges -- the whole point of reading it back is looking at it
// properly, not at a bare outline.
// The one "other route" channel: a mission read off the controller, or a saved
// plan being looked at before it is installed. Dashed, next to yours, one at a
// time, and any replan takes it back down.
function showRoute(src) {
  for (const g of Object.values(DEVICE_GROUPS())) g.clearLayers();
  state.onDevice = !src ? null
    : src.kind === 'device' ? routeFromRead(src.read, cam)
    : src.mission;
  if (!state.onDevice) {
    view3d.setMission(state.mission, state.coverage);
    // Back to the plan's own verdict. With no plan there is no frame to put the
    // boxes in, and nothing to draw them against either.
    view3d.setObstacles(
      state.mission ? graded(nearbyObstacles(state.rect).map((o) => localBox(o, state.mission.frame))) : [],
      state.hazard?.legs ?? [],
    );
    return;
  }
  renderPath(state.onDevice, { groups: DEVICE_GROUPS(), dashed: true });
  // 3D shows whichever route you asked to look at; replanning takes it back.
  view3d.setMission(state.onDevice, null);
  // The obstacles stay -- a route you are about to install is exactly the thing
  // to look at against them. Ungraded, though: every grade on screen belongs to
  // the plan, and colouring someone else's route with the plan's verdict would
  // be a lie in the most expensive possible place.
  view3d.setObstacles(
    nearbyObstacles(state.onDevice.rect ?? state.rect).map((o) => localBox(o, state.onDevice.frame)),
    [],
  );
  map.fitBounds(L.latLngBounds(state.onDevice.waypoints.map((w) => [w.lat, w.lon])),
    { padding: [50, 50], maxZoom: 19 });
}

// Builds the same bytes the export button downloads, so what the install panel
// shows going onto the controller is what the export would have produced.
// One shape for "files this mission becomes", whether they are going to disk or
// to a controller.
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
  return { plan, mission: planMission(plan.rect, paramsFromUi(plan.ui), cam) };
}

const bridge = initInstall({
  badge: (text, kind) => menu.badge('device', text, kind),
  showRoute,
  planRoute: (saved) => missionFromCode(saved.code)?.mission ?? null,
  // The controller installs a saved plan, so the list of them is the choice --
  // `plans` is defined below and only read when the panel renders.
  savedPlans: () => plans.list(),
  partsForPlan: (saved) => {
    const built = missionFromCode(saved.code);
    if (!built) return null;
    return partsFromMission(built.mission, built.plan.ui.profile ?? $('profile').value, saved.name);
  },
});

function applyPlan(plan) {
  applyUiValues(plan.ui);
  const b = L.latLngBounds([plan.rect.south, plan.rect.west], [plan.rect.north, plan.rect.east]);
  applyRect(b);
  drawHandles();
  map.fitBounds(b, { padding: [60, 60], maxZoom: 19 });
  $('areaHint').textContent = 'Plan restored. Drag the box to move it, corners to resize.';
  state.autofitNote = null;
  state.autofitAlt = null;
  replan();
  history.commit();
}

// The world the plan flies through. It owns the obstacle list and the clearance;
// the app owns what a plan makes of them, which is why every change here comes
// back through replan rather than being drawn from inside the view.
const world = initWorld({
  // A live drag only needs re-measuring; letting go is what earns a full replan,
  // because an obstacle also occludes the camera and that does change the score.
  onChange: ({ live = false, remote = false } = {}) => {
    if (live) { recheck(); return; }
    renderObstacles();
    replan();
    // A box that arrived from the phone is not an action taken here, so it is
    // not one to undo -- but the stack still has to know it exists.
    if (remote) history.refresh();
    else history.commit();
  },
  onSelect: () => showSelection(),
  onFocus: (o) => {
    if (menu.current() !== 'world') return;
    const b = L.latLngBounds([o.south, o.west], [o.north, o.east]);
    if (!map.getBounds().contains(b)) map.fitBounds(b, { padding: [80, 80], maxZoom: 20 });
  },
  onDraw: () => {
    setDrawing(state.draw === 'obstacle' ? null : 'obstacle');
    $('obsStatus').textContent = state.draw ? 'Drag a box over it on the map.' : '';
  },
  setCount: (n) => menu.badge('world', n || ''),
});

// Dragging the top of a box in the 3D view is the other way to say how tall it
// is, and the better one: you are looking at the flight while you do it.
view3d.onBoxHeight((id, height, opts) => world.setHeight(id, height, opts));

// Clicking one selects it. Selection is one thing across all three views, so
// the box lights up in 3D, grows handles on the map, and its row -- the only
// place a name or a delete lives -- is put in front of you rather than left a
// pane away.
view3d.onBoxSelect((id) => {
  menu.show('world');
  world.select(id);
});

// Saved plans store the same code the link carries, so a saved plan and a
// pasted link are the same thing arriving by different routes.
const plans = initPlans({
  getCode: () => encodePlan(state.rect, uiValues()),
  // Saving or deleting one changes what the controller can be handed.
  onChange: () => bridge.plansChanged(),
  setCount: (n) => menu.badge('saved', n || ''),
  // You loaded a plan to work on it, so the plan is what you should be looking at.
  onLoaded: () => menu.show('plan'),
  applyCode: (code) => {
    const plan = decodePlan(code);
    if (plan) applyPlan(plan);
    return Boolean(plan);
  },
  // Exporting a saved plan does not disturb the one on screen: it replans from
  // the stored code and hands over the files.
  exportPlan: (code) => {
    const built = missionFromCode(code);
    if (!built) return 0;
    return downloadKmz(built.mission, built.plan.ui.profile ?? $('profile').value);
  },
  // A plan nobody named is still worth finding again: say where and how big.
  describe: () => (state.mission
    ? `${state.mission.sizeX.toFixed(0)}×${state.mission.sizeY.toFixed(0)} m at ${state.rect.north.toFixed(4)}, ${state.rect.west.toFixed(4)}`
    : null),
});

/* ---------- undo ---------- */
// The rectangle, the control values and the obstacle list. Everything else --
// the waypoints, the coverage, the collision verdict -- is derived from those,
// so a snapshot of the three is a snapshot of the app.
const history = createHistory({
  snapshot: () => ({
    rect: state.rect ? { ...state.rect } : null,
    ui: uiValues(),
    obstacles: world.list().map((o) => ({ ...o })),
  }),
  restore: (snap) => {
    applyUiValues(snap.ui);
    world.restore(snap.obstacles);
    if (snap.rect) {
      applyRect(L.latLngBounds([snap.rect.south, snap.rect.west], [snap.rect.north, snap.rect.east]));
      drawHandles();
    } else {
      state.rect = null;
      layers.rect.remove();
      layers.handles.clearLayers();
      layers.dims.clearLayers();
    }
    state.autofitNote = null;
    state.autofitAlt = null;
    replan();
  },
  // A box that arrived from the other device belongs in every snapshot on the
  // stack, or undoing past its arrival would delete it. See js/history.js.
  rebase: (snap, before, after) => {
    const had = new Set(before.obstacles.map((o) => o.id));
    const arrived = after.obstacles.filter((o) => !had.has(o.id));
    if (!arrived.length) return snap;
    const ids = new Set(snap.obstacles.map((o) => o.id));
    return { ...snap, obstacles: [...snap.obstacles, ...arrived.filter((o) => !ids.has(o.id))] };
  },
});

// What a person would call one action. A slider being dragged is one, not
// forty, so sliders commit on `change` -- the release -- while `input` only
// replans. Both events fire for the same drag, which is exactly why the two
// jobs can be split across them.
for (const c of Object.values(controls)) c.el.addEventListener('change', () => history.commit());
for (const id of ['nadir', 'oblique', 'orbit', 'transect', 'photoMode', 'profile', 'shotsPerStop', 'orbitRings'])
  $(id).addEventListener('change', () => history.commit());

function stepHistory(back) {
  const moved = back ? history.undo() : history.redo();
  if (!moved) {
    toast(back ? 'Nothing left to undo.' : 'Nothing to redo.');
    return;
  }
  const d = history.depth();
  toast(back
    ? `Undone.${d.past ? ` ${d.past} more step${d.past === 1 ? '' : 's'} back.` : ' Back to the start.'}`
    : `Redone.${d.future ? ` ${d.future} more forward.` : ''}`);
}

window.addEventListener('keydown', (e) => {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k !== 'z' && k !== 'y') return;
  // A text box has its own undo, and it is the one you meant while the caret is
  // in it. Same for a number field mid-edit.
  const el = document.activeElement;
  if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)
             && !['range', 'checkbox', 'radio'].includes(el.type))) return;
  e.preventDefault();
  stepHistory(k === 'z' && !e.shiftKey);
});

const fromHash = decodePlan(location.hash);
if (fromHash) applyPlan(fromHash);

// After the plan, because a plan auto-fits the map and an explicit centre in
// the link is the more specific instruction -- it was written by someone who
// had already looked at that plan and moved somewhere.
readUrl();

readParams();
$('gsdHint').textContent = `${gsdCm(cam, DEFAULTS.altitude).toFixed(2)} cm/px ground resolution`;
ready = true;
renderObstacles();   // they are context, so they are on the map before any plan is
pushGround();        // hands the 3D view its tile source, on or off
urlFrozen = false;
writeUrl();          // a bare visit still ends up with an address worth copying
// Handy when poking at it from the console, which is most of how the 3D view
// gets debugged -- there is nothing in the DOM to inspect.
window.__state = state;
window.__view3d = view3d;
window.__world = world;
window.__map = map;
