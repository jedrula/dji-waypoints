// A footprint with a height, and the exact distance from a flight to it.
//
// An obstacle is stored as a rectangle plus, when the source knew it, the ring
// inside that rectangle (see js/obstacles.js). This is where the ring stops
// being a record and becomes geometry.
//
// The one idea worth keeping hold of: the rectangle has been demoted. It used
// to BE the obstacle, which made it a lie about nearly every building -- a
// median 1.9-2.1x too big over 755 real footprints. It is now the broad phase,
// which is the job it was always good at: six subtractions that dismiss a leg
// before anything expensive happens, and being generous there costs nothing.
//
// Two shapes come out of here, for two different jobs:
//
//   localSolid   one solid per obstacle, carrying the ring as it is, which may
//                be an L or a courtyard. For drawing, and for anything that
//                wants to talk about "that obstacle" as one thing.
//   localPrisms  the same solid cut into CONVEX pieces. For the maths.
//
// The split is what keeps js/collide.js exact. Its segment-to-box search is a
// ternary search, and the argument that it cannot miss is that point-to-solid
// distance is convex in the point -- true of any convex set, false the moment
// the footprint has a reflex corner. So the cutting happens here, per mission,
// and never reaches the store: piece counts can have an ugly tail (a curved
// terrace ran to 91) without a single extra record or a cap coming near.
//
// Everything degrades to the box. A ring that is not a simple polygon, or that
// defeats the ear clipper, yields the rectangle the app used before any of this
// existed -- conservative, and never a wrong answer.

const EPS = 1e-9;

// The obstacle's outline in lat/lon: the stored ring, or the rectangle's four
// corners anticlockwise from the south-west. Everything downstream can then
// stop caring which kind of obstacle it has.
export function ringLatLon(o) {
  if (Array.isArray(o.poly) && o.poly.length >= 3) {
    return o.poly.map((v) => ({ lat: v[0], lon: v[1] }));
  }
  return [
    { lat: o.south, lon: o.west },
    { lat: o.south, lon: o.east },
    { lat: o.north, lon: o.east },
    { lat: o.north, lon: o.west },
  ];
}

export const signedArea = (ring) => {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
};

// The outline in the mission's local ENU metres, always anticlockwise. OSM
// rings come both ways round and every test below assumes one of them.
export function localRing(o, frame) {
  const ring = ringLatLon(o).map((v) => {
    const l = frame.toLocal(v.lat, v.lon);
    return { x: l.x, y: l.y };
  });
  return signedArea(ring) < 0 ? ring.reverse() : ring;
}

const boundsOf = (ring, height) => ({
  min: { x: Math.min(...ring.map((p) => p.x)), y: Math.min(...ring.map((p) => p.y)), z: 0 },
  max: {
    x: Math.max(...ring.map((p) => p.x)),
    y: Math.max(...ring.map((p) => p.y)),
    z: Math.max(0.1, height),
  },
});

// One solid per obstacle, ring and all. `poly` is absent when the ring is the
// rectangle anyway, so a tapped obstacle costs nothing extra anywhere.
export function localSolid(o, frame) {
  const ring = localRing(o, frame);
  const b = boundsOf(ring, o.height);
  const solid = { id: o.id, name: o.name, ...b };
  if (Array.isArray(o.poly) && o.poly.length >= 3) solid.poly = ring;
  return solid;
}

const cross = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);

// Anticlockwise and with no reflex corner. Collinear runs are allowed: they
// make no corner to be on the wrong side of.
export function isConvex(ring) {
  for (let i = 0; i < ring.length; i++) {
    const a = ring[(i - 1 + ring.length) % ring.length];
    const b = ring[i];
    const c = ring[(i + 1) % ring.length];
    if (cross(a, b, c) < -EPS) return false;
  }
  return true;
}

function inTriangle(p, a, b, c) {
  return cross(a, b, p) > EPS && cross(b, c, p) > EPS && cross(c, a, p) > EPS;
}

// Ear clipping, because every triangle it produces is convex by construction
// and that is the only property the maths needs. O(n^2) on a ring of at most
// 200 points, run once per mission per obstacle that survived the broad phase.
//
// Returns null rather than guessing when the ring is not a simple polygon --
// OSM has self-intersecting buildings, and the honest answer to one is the
// rectangle.
//
// Clipping alone does NOT notice a self-intersection: a bow tie hands over two
// perfectly good triangles that between them cover twice the wrong thing. What
// notices is arithmetic that has to balance -- the pieces must add up to the
// ring's own area. A bow tie encloses zero and its triangles enclose 100, so it
// is caught, and anything else that fails to balance is caught with it.
export function earClip(ring) {
  const idx = ring.map((_, i) => i);
  const tri = [];
  let guard = ring.length * ring.length + 16;
  while (idx.length > 3) {
    if (guard-- <= 0) return null;
    const n = idx.length;
    let cut = -1;
    let degenerate = false;
    for (let i = 0; i < n; i++) {
      const a = ring[idx[(i - 1 + n) % n]];
      const b = ring[idx[i]];
      const c = ring[idx[(i + 1) % n]];
      const turn = cross(a, b, c);
      // A vertex sitting on the line between its neighbours adds nothing to the
      // outline. Dropping it without emitting a triangle is what stops a
      // curved terrace -- which is mostly near-collinear points -- from
      // defeating the clipper and falling back to a box.
      if (Math.abs(turn) <= EPS) { cut = i; degenerate = true; break; }
      if (turn < 0) continue;                        // reflex, not an ear
      let clear = true;
      for (let k = 0; k < n && clear; k++) {
        if (k === i || k === (i - 1 + n) % n || k === (i + 1) % n) continue;
        if (inTriangle(ring[idx[k]], a, b, c)) clear = false;
      }
      if (clear) { cut = i; break; }
    }
    if (cut < 0) return null;
    if (!degenerate) {
      tri.push([ring[idx[(cut - 1 + n) % n]], ring[idx[cut]], ring[idx[(cut + 1) % n]]]);
    }
    idx.splice(cut, 1);
  }
  if (idx.length === 3) {
    const t = idx.map((j) => ring[j]);
    if (Math.abs(cross(t[0], t[1], t[2])) > EPS) tri.push(t);
  }
  if (!tri.length) return null;
  const whole = Math.abs(signedArea(ring));
  const parts = tri.reduce((a, t) => a + Math.abs(cross(t[0], t[1], t[2])) / 2, 0);
  if (Math.abs(parts - whole) > Math.max(0.05, whole * 1e-6)) return null;
  return tri;
}

// The convex pieces of one obstacle, in the mission's local metres. One piece
// for anything already convex -- which is a tapped box, a wire strip, and
// three-quarters of rural footprints -- and a fan of triangles for the rest.
//
// Every piece carries the obstacle's own id, so a result about a piece is a
// result about the obstacle, and js/collide.js can put them back together.
export function localPrisms(o, frame) {
  const solid = localSolid(o, frame);
  if (!solid.poly) return [solid];
  if (isConvex(solid.poly)) return [solid];
  const tri = earClip(solid.poly);
  // Not a simple polygon. The rectangle is what this obstacle was yesterday.
  if (!tri) { const { poly, ...box } = solid; return [box]; }
  return tri.map((t) => ({
    id: o.id, name: o.name, poly: t, ...boundsOf(t, o.height),
  }));
}

// Distance from a point to a segment, in the plane.
function pointSegDist(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 < EPS ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

// Horizontal distance from a point to a ring; zero inside it. This is the
// whole of the new geometry: a convex prism is a convex polygon crossed with a
// height range, so its distance to a point separates into the flat part and the
// vertical part, and the two go together with a hypot exactly as the three
// sides of a box always did.
//
// The inside test is the crossing-number one, so this is right for any simple
// ring and not only a convex one. That does not make it safe to hand a
// non-convex solid to js/collide.js -- what needs convexity there is the
// DISTANCE FUNCTION being convex, not this -- but it means the planner can ask
// the same question of a whole outline without cutting it up first.
export function ringDist(p, ring) {
  let best = Infinity;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    const d = pointSegDist(p, a, b);
    if (d < best) best = d;
    if ((a.y > p.y) !== (b.y > p.y)
        && p.x < a.x + ((p.y - a.y) / (b.y - a.y)) * (b.x - a.x)) inside = !inside;
  }
  return inside ? 0 : best;
}

// Is the point within `limit` of the ring or inside it? The same walk, but it
// stops the moment the answer is yes -- which is what the planner wants of it,
// and what makes asking a hundred-edge outline about every point of every orbit
// affordable. `ringDist` would have to finish the loop to say how far.
export function ringWithin(p, ring, limit) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (pointSegDist(p, a, b) < limit) return true;
    if ((a.y > p.y) !== (b.y > p.y)
        && p.x < a.x + ((p.y - a.y) / (b.y - a.y)) * (b.x - a.x)) inside = !inside;
  }
  return inside;
}

// The obstacle's whole outline in local metres, with the box round it. The box
// is what makes asking about the outline affordable in a loop: a point that is
// not even near the box cannot be near the outline inside it, and that is four
// comparisons against a hundred edge distances.
// Remembered per obstacle, because the planner asks for the same outline in the
// same frame a few hundred times over: the altitude search re-plans for every
// candidate, and the frame comes from the taps rather than from the candidate.
// A record is replaced wholesale whenever anything about it changes, so the key
// being the object itself is also the answer to staleness.
const outlines = new WeakMap();

export function localOutline(o, frame) {
  if (!Array.isArray(o.poly) || o.poly.length < 3) return null;
  const had = outlines.get(o);
  if (had && had.lat0 === frame.lat0 && had.lon0 === frame.lon0) return had.outline;
  const ring = localRing(o, frame);
  const outline = { ring, ...boundsOf(ring, o.height ?? 0) };
  outlines.set(o, { lat0: frame.lat0, lon0: frame.lon0, outline });
  return outline;
}

// Inside a ring that may have reflex corners, by crossing number. The convex
// test above is not enough for a raw footprint, and this is what lets the
// heights service sample the building rather than the block it stands in.
export function insideRing(p, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if ((a.y > p.y) !== (b.y > p.y)
        && p.x < a.x + ((p.y - a.y) / (b.y - a.y)) * (b.x - a.x)) {
      inside = !inside;
    }
  }
  return inside;
}

// Does the ray from (px,py,pz) along (dx,dy,dz), for tMax of it, enter the
// solid? A boolean, not a distance, and far cheaper than one: clip the ray
// against the solid's own planes -- the six of a box, or the ground, the roof
// and one per edge of a convex outline -- and see whether any of it is left.
//
// Exact, and it is the only question two callers ever ask. js/collide.js asks
// it of a leg when the altitude search wants a verdict rather than a
// clearance; js/coverage.js asks it of a line of sight. Scalars rather than
// points because both ask it millions of times and an allocation per call is
// the whole budget.
//
// Convex only. For a box that is free; for an outline it is what js/prism.js
// hands out anyway.
export function rayClipsSolid(b, px, py, pz, dx, dy, dz, tMax) {
  let t0 = 0;
  let t1 = tMax;
  // The bounding box first, always. It contains the solid, so a ray that
  // misses it misses the solid -- six subtractions that reject nearly
  // everything before an edge is looked at.
  const lo = [b.min.x, b.min.y, b.min.z];
  const hi = [b.max.x, b.max.y, b.max.z];
  const p = [px, py, pz];
  const d = [dx, dy, dz];
  for (let k = 0; k < 3; k++) {
    if (Math.abs(d[k]) < 1e-12) {
      if (p[k] < lo[k] || p[k] > hi[k]) return false;
      continue;
    }
    let ta = (lo[k] - p[k]) / d[k];
    let tb = (hi[k] - p[k]) / d[k];
    if (ta > tb) { const sw = ta; ta = tb; tb = sw; }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t0 > t1) return false;
  }
  if (b.poly) {
    for (let i = 0; i < b.poly.length; i++) {
      const a = b.poly[i];
      const c = b.poly[(i + 1) % b.poly.length];
      // Anticlockwise, so inside is left of every edge and (dy, -dx) points out.
      const nx = c.y - a.y;
      const ny = a.x - c.x;
      const den = nx * dx + ny * dy;
      const num = nx * (px - a.x) + ny * (py - a.y);
      if (Math.abs(den) < 1e-12) {
        if (num > 0) return false;        // parallel to this wall and outside
        continue;
      }
      const t = -num / den;
      if (den > 0) { if (t < t1) t1 = t; } else if (t > t0) t0 = t;
      if (t0 > t1) return false;
    }
  }
  // Something of it is inside, rather than the ray merely grazing the surface
  // where it starts. A leg is tens of metres, so this is under a millimetre.
  return t1 > 1e-4;
}
