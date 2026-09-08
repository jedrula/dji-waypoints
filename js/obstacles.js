// The things already standing in the field. A plan is geometry in the air; an
// obstacle is geometry on the ground, and the only question worth asking of the
// two together is whether they touch.
//
// An obstacle is a footprint plus a height. For something you tapped, the
// footprint is a small square round the tap, because a tap is all the shape
// there is. For something imported, it is the outline OpenStreetMap or BDOT10k
// actually holds -- and that outline is the whole point: a bounding box round a
// real building is a lie about nearly every building. Measured over three areas
// of Poland, the box comes to a median 1.9-2.1x the true footprint and is more
// than 1.5x too big for 86-93% of them, because farmhouses follow the road and
// terraces follow the street, not the meridian.
//
// Heights are still a single number, so the solid is a prism: the outline
// extruded from the ground. A gable roof is not a prism either, but the number
// you need out of this is "how close does the flight get", and a prism that
// encloses the real thing answers that on the safe side.
//
// They belong to the world, not to a plan: obstacles are stored globally with
// their own GPS coordinates and every plan sees all of them. Nothing here ever
// reaches the aircraft -- the KMZ is untouched. This is for you, at the desk,
// before you fly.

import { createSyncedStore } from './synced.js';

// Every obstacle is the same thing: a footprint with a height. There is no
// taxonomy. "Building" versus "tree" would change nothing -- both are measured
// the same way, and what the thing actually is, is already obvious from the
// imagery underneath it.
//
// Ten metres is about three storeys, which is a better first guess than zero.
// It is a guess, though, and the whole point of the height field is that you
// correct it -- by typing it, or by dragging the top of the box in the 3D view.
export const DEFAULT_HEIGHT = 10;

export const DEFAULT_CLEARANCE = 5;

// A footprint is optional, and it is the one field an old build would not know
// about. That is safe here and nowhere else: imported obstacles are local to
// the device (see `local: isImported` in js/site.js), so a ring is never on the
// wire and the record the sync service validates is unchanged. If that ever
// stops being true, this is the line that has to change first.
//
// Two invariants, both of which make a bad ring fall back to yesterday's
// behaviour rather than to a wrong answer:
//
//   * the stored rectangle always CONTAINS the stored ring, so the rectangle
//     stays a usable broad phase -- nothing can hide outside it;
//   * anything that is not a ring of at least three points inside that
//     rectangle is dropped, and the obstacle is the box it always was.
const MAX_POLY = 200;      // p90 of real footprints is 28 points
const POLY_SLACK = 2e-6;   // about 20 cm, the rounding either side
function cleanPoly(poly, rect) {
  if (!Array.isArray(poly) || poly.length < 3 || poly.length > MAX_POLY) return null;
  const out = [];
  for (const v of poly) {
    const lat = Array.isArray(v) ? +v[0] : +v?.lat;
    const lon = Array.isArray(v) ? +v[1] : +v?.lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    if (lat > rect.north + POLY_SLACK || lat < rect.south - POLY_SLACK) return null;
    if (lon > rect.east + POLY_SLACK || lon < rect.west - POLY_SLACK) return null;
    const p = [+lat.toFixed(6), +lon.toFixed(6)];
    // A ring closed by repeating its first point, and any point repeated by
    // rounding, is one point as far as everything downstream is concerned.
    const last = out[out.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
  }
  while (out.length > 1 && out[0][0] === out[out.length - 1][0] && out[0][1] === out[out.length - 1][1]) {
    out.pop();
  }
  return out.length >= 3 ? out : null;
}

export function createObstacleStore({ storage, fetchImpl, endpoint, local } = {}) {
  const base = createSyncedStore({
    collection: 'obstacles',
    path: '/obstacles',
    storageKey: 'dji.obstacles',
    // Six decimals is about 10 cm, which is finer than you can draw and finer
    // than the imagery you draw on. Rounding keeps the stored list small enough
    // to send whole on every sync.
    shape: ({ name, north, south, east, west, height, poly }) => {
      const rect = {
        name: String(name ?? '').slice(0, 80),
        north: +(+north).toFixed(6),
        south: +(+south).toFixed(6),
        east: +(+east).toFixed(6),
        west: +(+west).toFixed(6),
        height: Math.round(Math.max(0, Math.min(1000, +height)) * 10) / 10,
      };
      const ring = cleanPoly(poly, rect);
      return ring ? { ...rect, poly: ring } : rect;
    },
    storage, fetchImpl, endpoint, local,
  });
  return base;
}

// A box with no area is not a box. Two corner handles can be dragged onto each
// other, and a stored zero-span rectangle is one the Worker refuses and the
// collision check measures as a line. A centimetre of floor costs nothing.
const EPS = 1e-7;   // about a centimetre of latitude
export function normalizeRect(r) {
  return {
    south: r.south,
    west: r.west,
    north: Math.max(r.north, r.south + EPS),
    east: Math.max(r.east, r.west + EPS),
  };
}

// An obstacle is a superset of the rectangle the planner takes, so anything
// wanting bounds -- Leaflet, the planner, this -- can just use it as one.
export const overlaps = (a, b) =>
  a.west < b.east && a.east > b.west && a.south < b.north && a.north > b.south;

// The obstacle as an axis-aligned box in a mission's local ENU metres. The
// frame is ellipsoidal, so a box drawn 200 m from the plan centre is still
// where you drew it.
export function localBox(o, frame) {
  const a = frame.toLocal(o.south, o.west);
  const b = frame.toLocal(o.north, o.east);
  return {
    id: o.id,
    name: o.name,
    min: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), z: 0 },
    max: { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y), z: Math.max(0.1, o.height) },
  };
}

// A name nobody typed. Height is the one thing every box has, so it is what
// stands in for a name -- and it is more use than "Untitled" would be.
export const describe = (o) => o.name || `${o.height} m box`;
