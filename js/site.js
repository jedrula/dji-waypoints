// What the mission has to see.
//
// The app used to keep this in three: a rectangle you dragged, an obstacle list
// with its own view, and a walk that made obstacles from where you stood. Then
// in two -- capture points and obstacles, in their own tabs. It is one now.
//
// A point is a tap, and every tap is a capture point: something you want
// photographed, carrying how tall it is. There is no second kind.
//
// The obstacles went because they were a second, worse answer to a question
// the survey already answers better. A hand-drawn box and an imported OSM
// footprint were the app's model of what is standing there; the national LiDAR
// IS what is standing there, at half-metre cells, and the app can now show a
// flight inside it (js/scene3d.js). Avoiding it is the next step. The one
// hazard the survey cannot supply is the overhead wire -- no wire class in any
// tile sampled, and tools/wire-spike.mjs is the negative result -- so wires
// stayed, as a hazard layer with no list and nothing to edit.
//
// Nothing here syncs any more either. The obstacle list was the only thing
// that did; plans still travel by code, and a plan is its taps.

import { mPerDegLat, mPerDegLon, frame } from './geo.js';
import { convexHull, polygonArea } from './shape.js';

// The height a point starts at, before you say otherwise. Three metres is a
// hedge, a van, a garden wall -- the commonest thing you point at, and low
// enough that accepting it by mistake is not dangerous.
export const DEFAULT_HEIGHT = 3;
export const DEFAULT_POINT_HEIGHT = DEFAULT_HEIGHT;

// A plan code has to fit what the sync service will store (2000 characters),
// and a tap costs about thirty. Fifty is far more than a footprint needs and
// still leaves room for every control in the code.
export const MAX_CAPTURE_POINTS = 50;

// A height typed on a phone, which is not the same thing as a number.
//
// `type=number` looked like the right input and is not: on a locale with a
// comma decimal separator -- Polish, where this app is being used -- typing
// "2,5" leaves the field INVALID, and `.value` reads back as the empty string.
// Coerced with `+`, that is 0, so a 2.5 m obstacle silently becomes a 0 m one
// and the ring floor drops with it. A text field parsed here accepts either
// separator and says plainly when it has nothing.
export function parseHeight(text) {
  const t = String(text ?? '').trim().replace(',', '.');
  if (!t) return null;
  const v = Number(t);
  if (!Number.isFinite(v) || v < 0 || v > 120) return null;
  return Math.round(v * 10) / 10;
}

let nextId = 1;
const newId = () => `p${nextId++}${Math.random().toString(36).slice(2, 6)}`;

export function createSite({ onChange = () => {} } = {}) {
  let capture = [];

  const changed = (how = {}) => onChange(how);

  return {
    /* ---------- what to capture ---------- */
    capture: () => capture,

    addCapture({ lat, lon, height = DEFAULT_POINT_HEIGHT }) {
      if (capture.length >= MAX_CAPTURE_POINTS) return null;
      const p = { id: newId(), lat, lon, height };
      capture = [...capture, p];
      changed({ capture: true });
      return p;
    },

    setCaptureHeight(id, height) {
      capture = capture.map((p) => (p.id === id ? { ...p, height: Math.max(0, height) } : p));
      changed({ capture: true });
    },

    moveCapture(id, lat, lon) {
      capture = capture.map((p) => (p.id === id ? { ...p, lat, lon } : p));
      changed({ capture: true });
    },

    removeCapture(id) {
      capture = capture.filter((p) => p.id !== id);
      changed({ capture: true });
    },

    clearCapture() {
      if (!capture.length) return;
      capture = [];
      changed({ capture: true });
    },

    // Loading a plan, or undoing to one. Ids are regenerated: a plan code
    // carries positions, not identities, and nothing outside this module keeps
    // a reference to a capture point across a load.
    setCapture(points) {
      capture = (points ?? []).slice(0, MAX_CAPTURE_POINTS).map((p) => ({
        id: newId(),
        lat: p.lat,
        lon: p.lon,
        height: Math.max(0, p.height ?? 0),
      }));
      changed({ capture: true, replaced: true });
    },

  };
}

// What a painted area becomes: capture points on its outline, every one
// carrying the height of the tallest thing painted.
//
// Painting is a faster way to say what taps say -- where, and how tall -- so it
// produces taps, and the planner, the share code and the undo stack need to
// know nothing new. The outline is the convex hull: the footprint the planner
// builds from taps is a hull anyway (see js/shape.js), so a concave outline
// here would be thrown away one step later.
//
// The height is the painted RELIEF, top minus bottom of where the brush landed,
// and the caller raises it to the survey's own measurement when that is taller.
// Both, because each is blind where the other sees: the survey's grid is height
// above local ground, so a quarry wall -- which is ground -- measures near zero
// there; and relief from brush hits alone sees nothing if every hit landed on a
// canopy top. Taking the larger only ever lifts the rings, which is the safe
// direction for both errors.
//
// `cells` are [{ lat, lon, y }] with y in any one consistent vertical datum.
export const PAINT_HULL_MAX = 24;
export function paintedSite(cells) {
  if (!cells?.length) return null;
  const f = frame(cells[0].lat, cells[0].lon);
  const local = cells.map((c) => ({ ...f.toLocal(c.lat, c.lon), y0: c.y }));
  const corners = convexHull(local.map((p) => ({ x: p.x, y: p.y })));
  if (corners.length < 3) return null;
  // Points at EQUAL spacing round the outline, not the hull's own corners.
  // The planner groups taps into things by the gaps between them (clusterTaps:
  // a link longer than GAP_FACTOR x the median is a gap between two things),
  // and a hull's corners are bunched where it curves and sparse along its
  // straight sides -- so the first painted patch over Kadzielnia came back as
  // five things with a ring each, not one. Even spacing has no gap to find.
  // One every 5 m, at least four, never past the cap.
  const edges = corners.map((a, i) => {
    const b = corners[(i + 1) % corners.length];
    return { a, b, len: Math.hypot(b.x - a.x, b.y - a.y) };
  });
  const perimeter = edges.reduce((t, e) => t + e.len, 0);
  const n = Math.min(PAINT_HULL_MAX, Math.max(4, Math.round(perimeter / 5)));
  const hull = [];
  let edge = 0;
  let walked = 0;
  for (let i = 0; i < n; i++) {
    const at = (i * perimeter) / n;
    while (walked + edges[edge].len < at) { walked += edges[edge].len; edge++; }
    const e = edges[edge];
    const t = e.len ? (at - walked) / e.len : 0;
    hull.push({ x: e.a.x + (e.b.x - e.a.x) * t, y: e.a.y + (e.b.y - e.a.y) * t });
  }
  const ys = cells.map((c) => c.y).filter(Number.isFinite);
  const relief = ys.length ? Math.ceil((Math.max(...ys) - Math.min(...ys)) * 2) / 2 : 0;
  const poly = hull.map((p) => f.toLatLon(p.x, p.y));
  return {
    poly,
    relief,
    areaM2: polygonArea(corners),
    points: poly.map((g) => ({ lat: g.lat, lon: g.lon, height: Math.max(relief, DEFAULT_POINT_HEIGHT) })),
  };
}

