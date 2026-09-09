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

import { mPerDegLat, mPerDegLon } from './geo.js';

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
