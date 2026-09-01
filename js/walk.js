// Surveying a site on foot, with the phone as the instrument.
//
// The desk workflow is to draw boxes over satellite imagery, which works right
// up until the thing you need is not visible from above: what is under the
// canopy, how tall the climbing frame actually is, the wire nobody can see.
// Walking the site answers all three, and the phone already knows where you are
// standing. So: stop next to a thing, say how tall it is, move on.
//
// One stop is one obstacle. Walking a perimeter would give truer footprints and
// is the wrong trade -- you cannot walk round a hedge, a pond or a fence line,
// and the number the plan needs out of this is the HEIGHT. The footprint only
// has to enclose the thing, which a square centred where you stood does.

import { mPerDegLat, mPerDegLon } from './geo.js';

// How wide the thing is, roughly, in metres. Three choices and no free-text
// field: you are standing outdoors holding a phone, and the difference between
// 7 m and 8 m is far inside the GPS error that is about to be added anyway.
export const SIZES = [
  { id: 'small', label: 'Small', span: 3, hint: 'post, bench, swing frame' },
  { id: 'medium', label: 'Medium', span: 8, hint: 'tree, shed, van' },
  { id: 'large', label: 'Large', span: 20, hint: 'building, tree cluster' },
];

export const DEFAULT_SIZE = 'medium';
export const spanOf = (id) => (SIZES.find((s) => s.id === id) ?? SIZES[1]).span;

// Past this, a fix is not a position, it is a neighbourhood. A 60 m box drawn
// because the phone was unsure is worse than no box: it reads as a real
// obstacle, it will veto altitudes that were fine, and nothing on screen says
// it was a guess. Under canopy -- which is exactly where you are standing when
// this matters -- a phone routinely reports this and worse.
export const MAX_ACCURACY = 25;

// The square a stop leaves behind. Centred where you stood, sized by what you
// said, and then GROWN by the accuracy the phone reported for that fix.
//
// Growing it is the whole trick. You were beside the thing rather than inside
// it, and the fix has its own radius of doubt; inflating by that radius means
// the box encloses the thing wherever inside the circle you actually were. It
// errs outward, which for an obstacle is the safe direction -- the cost of a
// box that is too big is an altitude a few metres higher than it needed to be.
export function sampleRect({ lat, lon, accuracy = 0 }, span) {
  const half = Math.max(0.5, span / 2) + Math.max(0, accuracy || 0);
  return {
    north: lat + half / mPerDegLat(lat),
    south: lat - half / mPerDegLat(lat),
    east: lon + half / mPerDegLon(lat),
    west: lon - half / mPerDegLon(lat),
  };
}

// The area to capture, from the stops themselves: everything you sampled, plus
// a margin. You walked to the things worth capturing, so their extent is the
// site -- there is no second step where you draw a box around what you just
// surveyed. It stays draggable afterwards, because the extent of what you
// walked past is a good first answer and not always the right one.
export const WALK_MARGIN = 5;

export function walkRect(boxes, margin = WALK_MARGIN) {
  if (!boxes?.length) return null;
  const north = Math.max(...boxes.map((b) => b.north));
  const south = Math.min(...boxes.map((b) => b.south));
  const east = Math.max(...boxes.map((b) => b.east));
  const west = Math.min(...boxes.map((b) => b.west));
  const lat0 = (north + south) / 2;
  return {
    north: north + margin / mPerDegLat(lat0),
    south: south - margin / mPerDegLat(lat0),
    east: east + margin / mPerDegLon(lat0),
    west: west - margin / mPerDegLon(lat0),
  };
}

// What a stop is allowed to do with the fix it got. Separated from the UI so
// the rule is one testable thing rather than a branch inside a click handler.
export function judgeFix(fix) {
  if (!fix) return { ok: false, why: 'No position yet — hold still a moment and try again.' };
  if (!(fix.accuracy > 0)) return { ok: true, note: null };
  if (fix.accuracy > MAX_ACCURACY) {
    return {
      ok: false,
      why: `Only ±${fix.accuracy.toFixed(0)} m — too vague to place a box. `
         + 'Step into the open, wait a few seconds, and tap again.',
    };
  }
  return {
    ok: true,
    note: fix.accuracy > 8
      ? `±${fix.accuracy.toFixed(0)} m fix, so the box is grown to match.`
      : null,
  };
}

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
