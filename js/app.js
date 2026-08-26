import { CAMERAS, gsdCm } from './camera.js';
import { frame, mPerDegLat, mPerDegLon } from './geo.js';
import { planMission, proposePlan, splitMission, DEFAULTS, DJI_FLY_MAX_WAYPOINTS } from './planner.js';
import { buildKmz } from './wpml.js';
import { createView3D } from './view3d.js';
import { scoreCoverage } from './coverage.js';

const cam = CAMERAS.mini5pro;
const $ = (id) => document.getElementById(id);

const PASS_COLOR = { nadir: '#4da3ff', oblique: '#ffb84d', orbit: '#5ad19a', transect: '#c98bff' };

const state = { rect: null, mission: null, drawing: false };

/* ---------- map ---------- */
const map = L.map('map', { zoomControl: true, attributionControl: true }).setView([50.0614, 19.9366], 16);
L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
  maxZoom: 21, maxNativeZoom: 19,
  attribution: 'Imagery &copy; Esri',
}).addTo(map);

const layers = {
  rect: L.rectangle([[0, 0], [0, 0]], {
    color: '#4da3ff', weight: 2, fill: true, fillOpacity: 0.06,
    dashArray: '5,4', className: 'rectbox',
  }),
  path: L.layerGroup().addTo(map),
  dots: L.layerGroup().addTo(map),
  handles: L.layerGroup().addTo(map),
  dims: L.layerGroup().addTo(map),
  gps: L.layerGroup().addTo(map),
  poses: L.layerGroup().addTo(map),
};

/* ---------- 3D view ---------- */
const view3d = createView3D($('scene'));
let activeView = 'map';
for (const btn of document.querySelectorAll('#viewtabs button')) {
  btn.addEventListener('click', () => {
    activeView = btn.dataset.view;
    for (const b of document.querySelectorAll('#viewtabs button')) b.classList.toggle('on', b === btn);
    $('map').hidden = activeView !== 'map';
    $('scene').hidden = activeView !== '3d';
    if (activeView === 'map') map.invalidateSize();
    else view3d.reset();
  });
}
window.addEventListener('resize', () => { if (activeView === '3d') view3d.draw(); });

/* ---------- draw a rectangle by dragging ---------- */
let dragStart = null;
$('draw').addEventListener('click', () => setDrawing(!state.drawing));

function setDrawing(on) {
  state.drawing = on;
  $('draw').classList.toggle('armed', on);
  $('draw').textContent = on ? 'Cancel — drag on the map' : (state.rect ? 'Redraw rectangle' : 'Draw rectangle');
  $('map').classList.toggle('drawing', on);
  if (on) { map.dragging.disable(); map.doubleClickZoom.disable(); }
  else { map.dragging.enable(); map.doubleClickZoom.enable(); }
}

map.on('mousedown', (e) => {
  if (!state.drawing) return;
  dragStart = e.latlng;
  layers.rect.setBounds(L.latLngBounds(dragStart, dragStart)).addTo(map);
});
map.on('mousemove', (e) => {
  if (!state.drawing || !dragStart) return;
  const live = L.latLngBounds(dragStart, e.latlng);
  layers.rect.setBounds(live);
  showDims(live);
});
map.on('mouseup', (e) => {
  if (!state.drawing || !dragStart) return;
  const b = L.latLngBounds(dragStart, e.latlng);
  dragStart = null;
  // A click with no drag is not a box. Stay armed rather than silently
  // dropping out of draw mode and leaving the user wondering what happened.
  const px = map.latLngToContainerPoint.bind(map);
  const a = px(b.getNorthWest());
  const c = px(b.getSouthEast());
  if (Math.abs(c.x - a.x) < 8 || Math.abs(c.y - a.y) < 8) {
    if (!state.rect) layers.rect.remove();
    else layers.rect.setBounds([[state.rect.south, state.rect.west], [state.rect.north, state.rect.east]]);
    $('areaHint').textContent = 'Too small — press and drag to size the box.';
    return;
  }
  setDrawing(false);
  setRect(b);
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
  syncSizeInputs();
  drawHandles();
  $('areaHint').textContent = 'Drag the box to move it, corners to resize.';
  autofit();
}

// Geometry only -- no handles, no re-proposal. Cheap enough to run per frame
// while the box is being dragged.
function applyRect(b) {
  state.rect = { north: b.getNorth(), south: b.getSouth(), east: b.getEast(), west: b.getWest() };
  layers.rect.setBounds(b).addTo(map);
  showDims(b);
}

// Typing a size beats pinch-dragging a box on a phone, and it is exact.
function syncSizeInputs() {
  if (!state.rect) return;
  const fr = frame((state.rect.north + state.rect.south) / 2, (state.rect.east + state.rect.west) / 2);
  const c1 = fr.toLocal(state.rect.south, state.rect.west);
  const c2 = fr.toLocal(state.rect.north, state.rect.east);
  if (document.activeElement !== $('boxW')) $('boxW').value = Math.round(Math.abs(c2.x - c1.x));
  if (document.activeElement !== $('boxD')) $('boxD').value = Math.round(Math.abs(c2.y - c1.y));
}

function resizeFromInputs() {
  if (!state.rect) return;
  const w = Math.max(5, Math.min(1000, +$('boxW').value || 0));
  const d = Math.max(5, Math.min(1000, +$('boxD').value || 0));
  const lat = (state.rect.north + state.rect.south) / 2;
  const lon = (state.rect.east + state.rect.west) / 2;
  setRect(boxAround(lat, lon, w, d));   // grows about the centre
}
for (const id of ['boxW', 'boxD']) {
  $(id).addEventListener('change', resizeFromInputs);
  $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } });
}

/* ---------- drag the whole box ---------- */
let boxDrag = null;
let dragFrame = null;

layers.rect.on('mousedown', (e) => {
  if (state.drawing || !state.rect) return;
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

/* ---------- where I am ---------- */
// A box of `side` metres centred on a lat/lon, built with the same ellipsoidal
// scaling the planner uses so the drawn size matches the plan.
function boxAround(lat, lon, sideX, sideY) {
  const dLat = sideY / 2 / mPerDegLat(lat);
  const dLon = sideX / 2 / mPerDegLon(lat);
  return L.latLngBounds([lat - dLat, lon - dLon], [lat + dLat, lon + dLon]);
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
  const place = () => {
    const sideX = state.rect ? state.mission?.sizeX ?? 30 : 30;
    const sideY = state.rect ? state.mission?.sizeY ?? 30 : 30;
    setRect(boxAround(lat, lon, sideX, sideY));
  };

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
    if (j[0]) map.setView([+j[0].lat, +j[0].lon], 17);
    else $('areaHint').textContent = 'Nothing found for that search.';
  } catch {
    $('areaHint').textContent = 'Search unavailable — pan the map instead.';
  }
  $('go').textContent = 'Find';
}
$('go').addEventListener('click', search);
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

function readParams() {
  const p = {};
  for (const [k, c] of Object.entries(controls)) {
    p[k] = c.val(c.el.value);
    $(k + 'Out').textContent = c.fmt(c.el.value);
  }
  p.nadir = $('nadir').checked;
  p.oblique = $('oblique').checked;
  p.orbit = $('orbit').checked;
  p.transect = $('transect').checked;
  p.photoMode = $('photoMode').value;
  p.shotsPerStop = +$('shotsPerStop').value;
  p.orbitRings = +$('orbitRings').value;
  return p;
}

const override = () => { state.autofitNote = null; state.autofitAlt = null; replan(); };
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
  state.autofitNote = fits ? note : note;
  state.autofitAlt = alternative;
  replan();
}
$('autofit').addEventListener('click', autofit);


function replan() {
  const p = readParams();
  $('gsdHint').textContent = `${gsdCm(cam, p.altitude).toFixed(2)} cm/px ground resolution`;
  if (!state.rect) return;
  if (!p.nadir && !p.oblique && !p.orbit && !p.transect) {
    state.mission = null;
    layers.path.clearLayers(); layers.dots.clearLayers();
    $('stats').className = 'stats empty';
    $('stats').textContent = 'Enable at least one pass.';
    $('passList').innerHTML = '';
    $('export').disabled = true;
    return;
  }
  state.mission = planMission(state.rect, p, cam);
  // Cap the camera count so scoring stays interactive on big plans; the CLI
  // (tools/compare.mjs) scores every frame.
  state.coverage = scoreCoverage(state.mission, { maxCameras: 220 });
  renderPath(state.mission);
  renderStats(state.mission);
  view3d.setMission(state.mission, state.coverage);
}

function renderPath(m) {
  layers.path.clearLayers();
  layers.dots.clearLayers();
  let run = [];
  let runPass = null;
  const flush = () => {
    if (run.length > 1) {
      L.polyline(run, {
        color: PASS_COLOR[runPass], weight: 2, opacity: 0.85, interactive: false,
      }).addTo(layers.path);
    }
  };
  for (const w of m.waypoints) {
    if (w.pass !== runPass) { flush(); run = run.length ? [run[run.length - 1]] : []; runPass = w.pass; }
    run.push([w.lat, w.lon]);
  }
  flush();

  // Which way each camera looks. Length encodes tilt: a nadir shot is a stub,
  // a horizontal shot is a full tick.
  layers.poses.clearLayers();
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
    }).addTo(layers.poses);
  });

  const step = Math.max(1, Math.ceil(m.waypoints.length / 400)); // keep the map responsive
  m.waypoints.forEach((w, i) => {
    if (i % step) return;
    L.marker([w.lat, w.lon], {
      icon: L.divIcon({ className: 'wpdot', iconSize: [5, 5] }),
      interactive: false,
    }).addTo(layers.dots)._icon.style.background = PASS_COLOR[w.pass];
  });

  L.circleMarker([m.waypoints[0].lat, m.waypoints[0].lon],
    { radius: 6, color: '#fff', weight: 2, fillColor: PASS_COLOR[m.waypoints[0].pass], fillOpacity: 1 })
    .addTo(layers.path).bindTooltip('Start');
}

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
  if (m.params.altitude > 120) warns.push('Above 120 m AGL is outside EU/US open-category limits.');
  if (m.params.altitude < 12) warns.push('Below ~12 m the mission depends on GNSS that canopy degrades, and vision sensing misses thin branches. Set obstacle avoidance to Brake and keep line of sight.');
  if (s.batteries > 1) warns.push(`Plan needs about ${s.batteries} batteries at ${m.params.usableFlightMin} min usable each.`);
  $('warn').hidden = warns.length === 0;
  $('warn').innerHTML = warns.map((w) => `<div>${w}</div>`).join('');

  $('altnote').hidden = !state.autofitAlt;
  $('altnote').textContent = state.autofitAlt || '';

  $('export').disabled = false;
  $('export').textContent = parts.length > 1 ? `Accept & export ${parts.length} KMZ parts` : 'Accept & export KMZ';
  $('exportHint').textContent = `${m.sizeX.toFixed(0)} × ${m.sizeY.toFixed(0)} m · ${s.areaHa.toFixed(2)} ha · lines ${s.sideSpacing.toFixed(1)} m apart, shots every ${s.fwdSpacing.toFixed(1)} m`;
}

/* ---------- export ---------- */
function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID().toUpperCase();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  }).toUpperCase();
}

$('export').addEventListener('click', () => {
  if (!state.mission) return;
  const profile = $('profile').value;
  const parts = splitMission(state.mission);
  parts.forEach((part, i) => {
    const bytes = buildKmz(part, profile);
    const name = parts.length > 1 ? `${uuid()}_part${i + 1}of${parts.length}.kmz` : `${uuid()}.kmz`;
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.google-earth.kmz' }));
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  });
  $('exportHint').textContent = `Exported ${parts.length} file${parts.length > 1 ? 's' : ''}. Rename to the UUID of a mission folder in DJI Fly's waypoint directory.`;
});

readParams();
$('gsdHint').textContent = `${gsdCm(cam, DEFAULTS.altitude).toFixed(2)} cm/px ground resolution`;
window.__state = state; // handy when poking at it from the console
