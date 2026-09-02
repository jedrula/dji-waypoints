// What is on the ground, in one place.
//
// The app used to keep this in three: a rectangle you dragged, an obstacle list
// with its own view, and a walk that made obstacles from where you stood. They
// were three ways of saying the same two things -- what to capture, and what to
// stay away from -- so they are one thing now, and the only difference between
// a tap and a GPS stop is where the coordinates came from.
//
// A point is a tap. Both kinds carry a height, because both questions are about
// height: how tall is the thing I want photographed, and how tall is the thing
// I must not hit.
//
//   capture   what the mission has to see. Their footprint (js/shape.js) is
//             what gets flown, and the tallest of them is the subject height.
//             They live in the plan -- they ARE the plan, and they travel in
//             its share code.
//
//   obstacle  what the flight is checked against. These are global and synced,
//             because a tree is a tree whichever plan you are drawing today,
//             and they are stored as the box records they always were: a tap
//             plus a span is a small square, which is exactly what a walk stop
//             already made. Nothing about the sync format changes.

import { createObstacleStore, normalizeRect, DEFAULT_HEIGHT } from './obstacles.js';
import { sampleRect, SIZES, DEFAULT_SIZE, spanOf } from './walk.js';

export { SIZES, DEFAULT_SIZE, spanOf, DEFAULT_HEIGHT };

// The height a point starts at, before you say otherwise. Three metres is a
// hedge, a van, a garden wall -- the commonest thing you point at, and low
// enough that accepting it by mistake is not dangerous.
export const DEFAULT_POINT_HEIGHT = 3;

// How wide a tapped obstacle is, when you have not said. A tap marks a spot,
// not an outline: a wide thing is several taps, the same way a wide capture is.
export const DEFAULT_OBSTACLE_SPAN = 6;

// A plan code has to fit what the sync service will store (2000 characters),
// and a tap costs about thirty. Fifty is far more than a footprint needs and
// still leaves room for every control in the code.
export const MAX_CAPTURE_POINTS = 50;

let nextId = 1;
const newId = () => `p${nextId++}${Math.random().toString(36).slice(2, 6)}`;

// The centre of an obstacle's box, which is the tap that made it. Obstacles are
// stored as rectangles -- that is the record the sync service validates and the
// collision check consumes -- and this is the one place that reads one back as
// the point it came from.
export function pointOf(o) {
  return { lat: (o.north + o.south) / 2, lon: (o.east + o.west) / 2 };
}

export function spanMOf(o) {
  return Math.round((o.north - o.south) * 111320);
}

export function createSite({ onChange = () => {}, onSync = () => {}, storage, fetchImpl, endpoint } = {}) {
  // Capture points are the plan; obstacles are the world the plan flies through.
  let capture = [];
  const obstacles = createObstacleStore({ storage, fetchImpl, endpoint });

  // One round trip at a time and in order: a save followed by a delete has to
  // reach the service in that order, or the delete is the one that gets lost.
  let queue = Promise.resolve();
  let pending = null;

  function sync({ quiet = false } = {}) {
    queue = queue.then(async () => {
      if (!obstacles.endpoint()) return;
      try {
        const { total, pulled } = await obstacles.sync();
        if (pulled) changed({ obstacles: true, replaced: true });
        onSync({ total, pulled, quiet });
      } catch (e) {
        // The write already landed locally, so this is never lost work -- the
        // next sync sends it. Say so rather than looking like the edit failed.
        onSync({ error: e.message, quiet });
      }
    });
    return queue;
  }

  // Obstacles sync by themselves, because a tree you marked on the phone is
  // only useful on the Mac that has the cable. Coalesced, though: holding the
  // + button on a height is one edit to a person and a dozen writes to the
  // store, and the service does not need to hear about each of them.
  function syncSoon() {
    clearTimeout(pending);
    pending = setTimeout(() => sync({ quiet: true }), 900);
  }

  const changed = (how = {}) => {
    onChange(how);
    if (how.obstacles && !how.replaced) syncSoon();
  };

  return {
    /* ---------- what to capture ---------- */
    capture: () => capture,

    addCapture({ lat, lon, accuracy = 0, height = DEFAULT_POINT_HEIGHT }) {
      if (capture.length >= MAX_CAPTURE_POINTS) return null;
      const p = { id: newId(), lat, lon, height, accuracy };
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

    /* ---------- what to avoid ---------- */
    obstacles: () => obstacles.list(),

    // A tap plus a span is a small square, grown by whatever the fix was unsure
    // about. On the map that is nothing; standing next to the thing it is the
    // phone's accuracy, and erring outward is the safe direction for an obstacle.
    addObstacle({ lat, lon, accuracy = 0, height = DEFAULT_POINT_HEIGHT, span = DEFAULT_OBSTACLE_SPAN }) {
      const rect = sampleRect({ lat, lon, accuracy }, span);
      const o = obstacles.put({ ...normalizeRect(rect), height, name: '' });
      changed({ obstacles: true });
      return o;
    },

    setObstacleHeight(id, height) {
      const o = obstacles.list().find((x) => x.id === id);
      if (!o) return;
      obstacles.put({ ...o, height: Math.max(0, height) });
      changed({ obstacles: true });
    },

    setObstacleSpan(id, span) {
      const o = obstacles.list().find((x) => x.id === id);
      if (!o) return;
      obstacles.put({ ...o, ...normalizeRect(sampleRect(pointOf(o), Math.max(1, span))) });
      changed({ obstacles: true });
    },

    removeObstacle(id) {
      obstacles.remove(id);
      changed({ obstacles: true });
    },

    // The undo stack restores whole worlds, so it needs to put the list back
    // exactly -- including bringing back one that was deleted.
    restoreObstacles(list) {
      const now = obstacles.list();
      const want = new Map(list.map((o) => [o.id, o]));
      for (const o of now) if (!want.has(o.id)) obstacles.remove(o.id);
      for (const o of list) {
        const cur = now.find((x) => x.id === o.id);
        if (!cur || JSON.stringify(cur) !== JSON.stringify(o)) obstacles.put(o);
      }
      changed({ obstacles: true, replaced: true });
    },

    endpoint: obstacles.endpoint,
    sync,
    // Called once at startup: whatever the other device drew is part of the
    // world this plan is checked against, and it has to arrive before the
    // first "does this flight clear everything" is worth anything.
    start: () => sync({ quiet: true }),
  };
}
