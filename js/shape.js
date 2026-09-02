// Points to a footprint.
//
// You tap the things you want in the capture; the planner needs a shape to fly
// over. This module is the one place that turns one into the other, and it is
// its own file because which shape is right is not settled. A convex hull is
// the first answer -- a tight cluster of taps reads as an object, a spread-out
// set as an area, which is the same gesture for both jobs. Whether it beats a
// bounding box, or per-point targets, is a question for the aircraft rather
// than for an argument, so `SHAPES` is a table: a second answer is a second
// entry, not surgery on the planner.
//
// Everything here works in the planner's local metres, never in degrees. A hull
// taken in lat/lon is sheared by the cosine of the latitude, and an orbit
// radius measured in degrees is not a radius at all.

const EPS = 1e-9;

const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

// Andrew's monotone chain, counter-clockwise. Collinear points are dropped:
// they add vertices that every consumer then has to special-case, and they
// change nothing about the shape.
export function convexHull(points) {
  const seen = new Map();
  for (const p of points) seen.set(`${p.x.toFixed(4)},${p.y.toFixed(4)}`, p);
  const pts = [...seen.values()].sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length < 3) return pts;

  const half = (src) => {
    const out = [];
    for (const p of src) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) <= EPS) out.pop();
      out.push(p);
    }
    out.pop();
    return out;
  };
  const hull = [...half(pts), ...half([...pts].reverse())];
  // Three taps in a line, or two taps: no area, so no polygon. Hand back what
  // there is and let the caller decide -- for one point that is an orbit around
  // it, which is a perfectly good mission.
  return hull.length >= 3 ? hull : pts;
}

export function polygonArea(poly) {
  if (poly.length < 3) return 0;
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

// The area-weighted centre for a real polygon, and the plain mean when there is
// no area to weight by. What the orbit circles and what the cameras aim at.
export function centroid(poly) {
  if (!poly.length) return { x: 0, y: 0 };
  if (poly.length < 3 || polygonArea(poly) < EPS) {
    return {
      x: poly.reduce((s, p) => s + p.x, 0) / poly.length,
      y: poly.reduce((s, p) => s + p.y, 0) / poly.length,
    };
  }
  let cx = 0;
  let cy = 0;
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const w = p.x * q.y - q.x * p.y;
    cx += (p.x + q.x) * w;
    cy += (p.y + q.y) * w;
    a += w;
  }
  return { x: cx / (3 * a), y: cy / (3 * a) };
}

export function bounds(poly) {
  const xs = poly.map((p) => p.x);
  const ys = poly.map((p) => p.y);
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
}

// How far the furthest tap is from the middle: the radius an orbit has to stand
// outside of to have the whole thing in frame.
export function circumradius(poly, about = centroid(poly)) {
  return poly.reduce((r, p) => Math.max(r, Math.hypot(p.x - about.x, p.y - about.y)), 0);
}

export function pointInPolygon(p, poly) {
  if (poly.length < 3) return false;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    // Counter-clockwise, so inside is to the left of every edge.
    if ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x) < -EPS) return false;
  }
  return true;
}

// Cyrus-Beck: a segment crossing a convex polygon survives as one unbroken
// run of it, so clipping is a range of t narrowed by each edge in turn rather
// than a list of crossings to sort out. Returns null when the segment misses.
export function clipSegment(poly, a, b) {
  if (poly.length < 3) return null;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let t0 = 0;
  let t1 = 1;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    // Outward normal of a counter-clockwise edge. Inside is n · (P - p) <= 0.
    const nx = q.y - p.y;
    const ny = -(q.x - p.x);
    const A = (a.x - p.x) * nx + (a.y - p.y) * ny;
    const B = dx * nx + dy * ny;
    if (Math.abs(B) < EPS) {
      if (A > EPS) return null;      // parallel to this edge and outside it
      continue;
    }
    const t = -A / B;
    if (B > 0) t1 = Math.min(t1, t);
    else t0 = Math.max(t0, t);
    if (t0 > t1) return null;
  }
  return [
    { x: a.x + t0 * dx, y: a.y + t0 * dy },
    { x: a.x + t1 * dx, y: a.y + t1 * dy },
  ];
}

// The table the note at the top is about. A shape turns the taps into the
// footprint the planner flies, and nothing else in the app knows which one is
// in use.
export const SHAPES = {
  hull: {
    label: 'Hull',
    detail: 'fly the outline of what you tapped',
    of: (pts) => convexHull(pts),
  },
  box: {
    label: 'Box',
    detail: 'fly the whole rectangle around what you tapped',
    of: (pts) => {
      if (pts.length < 2) return convexHull(pts);
      const b = bounds(pts);
      return [
        { x: b.x0, y: b.y0 }, { x: b.x1, y: b.y0 },
        { x: b.x1, y: b.y1 }, { x: b.x0, y: b.y1 },
      ];
    },
  },
};

export const DEFAULT_SHAPE = 'hull';

export function footprintOf(points, shape = DEFAULT_SHAPE) {
  return (SHAPES[shape] ?? SHAPES[DEFAULT_SHAPE]).of(points);
}
