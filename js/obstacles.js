// The things already standing in the field. A plan is geometry in the air; an
// obstacle is geometry on the ground, and the only question worth asking of the
// two together is whether they touch.
//
// An obstacle is a rectangle plus a height -- a cube, deliberately. A tree is
// not a cube and a gable roof is not a cube, but the number you need out of
// this is "how close does the flight get", and a box that encloses the real
// thing answers that on the safe side. Anything more faithful would be a
// modelling job, and you would still fly to the box.
//
// They belong to the world, not to a plan: obstacles are stored globally with
// their own GPS coordinates and every plan sees all of them. Nothing here ever
// reaches the aircraft -- the KMZ is untouched. This is for you, at the desk,
// before you fly.

import { createSyncedStore } from './synced.js';

// Every obstacle is the same thing: a box with a height. There is no taxonomy.
// "Building" versus "tree" would change nothing -- both are measured the same
// way, and what the thing actually is, is already obvious from the imagery
// underneath it.
//
// Ten metres is about three storeys, which is a better first guess than zero.
// It is a guess, though, and the whole point of the height field is that you
// correct it -- by typing it, or by dragging the top of the box in the 3D view.
export const DEFAULT_HEIGHT = 10;

export const DEFAULT_CLEARANCE = 5;

export function createObstacleStore({ storage, fetchImpl, endpoint } = {}) {
  const base = createSyncedStore({
    collection: 'obstacles',
    path: '/obstacles',
    storageKey: 'dji.obstacles',
    // Six decimals is about 10 cm, which is finer than you can draw and finer
    // than the imagery you draw on. Rounding keeps the stored list small enough
    // to send whole on every sync.
    shape: ({ name, north, south, east, west, height }) => ({
      name: String(name ?? '').slice(0, 80),
      north: +(+north).toFixed(6),
      south: +(+south).toFixed(6),
      east: +(+east).toFixed(6),
      west: +(+west).toFixed(6),
      height: Math.round(Math.max(0, Math.min(1000, +height)) * 10) / 10,
    }),
    storage, fetchImpl, endpoint,
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
