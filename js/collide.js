// Does the proposed flight hit anything that is already there?
//
// The flight is a polyline through the exported waypoints -- that is what the
// aircraft actually flies, including the long legs between one pass and the
// next. The obstacles are boxes. So the whole question reduces to: how close
// does each leg come to each box, and is that closer than you are willing to
// fly.
//
// What this does NOT model: the climb out from the home point, the return leg,
// wind push, GNSS error beyond whatever you put in the clearance, and terrain.
// Every height in this app is above the takeoff point, so a box on a slope is
// only as right as the height you gave it.

// Distance from a point to an axis-aligned box; zero inside it.
export function pointBoxDist(p, b) {
  const dx = Math.max(b.min.x - p.x, 0, p.x - b.max.x);
  const dy = Math.max(b.min.y - p.y, 0, p.y - b.max.y);
  const dz = Math.max(b.min.z - p.z, 0, p.z - b.max.z);
  return Math.hypot(dx, dy, dz);
}

// Distance from a segment to a box, and where along it that happens.
//
// Point-to-box distance is a convex function of the point, and a segment is an
// affine function of t, so the composition is convex in t with exactly one
// minimum. Ternary search walks straight to it -- no sampling, and so no near
// miss slipping between two samples -- for about forty distance evaluations.
export function segmentBoxDist(p0, p1, b) {
  const at = (t) => ({
    x: p0.x + (p1.x - p0.x) * t,
    y: p0.y + (p1.y - p0.y) * t,
    z: p0.z + (p1.z - p0.z) * t,
  });
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 40 && hi - lo > 1e-4; i++) {
    const a = lo + (hi - lo) / 3;
    const c = hi - (hi - lo) / 3;
    if (pointBoxDist(at(a), b) < pointBoxDist(at(c), b)) hi = c;
    else lo = a;
  }
  const t = (lo + hi) / 2;
  return { dist: pointBoxDist(at(t), b), t, at: at(t) };
}

// Gap between two axis-aligned boxes. A leg's own bounding box contains the
// leg, so this is a true lower bound on the segment-to-box distance -- which is
// what lets most legs be dismissed in six subtractions instead of forty
// distance evaluations.
function aabbGap(s, b) {
  const dx = Math.max(b.min.x - s.max.x, 0, s.min.x - b.max.x);
  const dy = Math.max(b.min.y - s.max.y, 0, s.min.y - b.max.y);
  const dz = Math.max(b.min.z - s.max.z, 0, s.min.z - b.max.z);
  return Math.hypot(dx, dy, dz);
}

// A leg is reported at its worst: `strike` if it goes through the box, `near`
// if it comes within the clearance. Both are worth seeing, and they are not the
// same news, so they do not get the same colour.
const gradeOf = (dist, clearance) => (dist <= 0.001 ? 'strike' : dist < clearance ? 'near' : null);

export function checkObstacles(mission, boxes, { clearance = 5 } = {}) {
  const empty = { clearance, obstacles: [], legs: [], strikes: 0, near: 0, minDist: null };
  if (!mission || !boxes?.length) return empty;

  const f = mission.frame;
  const path = mission.exported ?? mission.waypoints ?? [];
  if (path.length < 2) return empty;

  // Waypoints carry lat/lon; the boxes are metres. Convert once, and give each
  // leg its bounding box while we are here.
  const pts = path.map((w) => {
    const l = f.toLocal(w.lat, w.lon);
    return { x: l.x, y: l.y, z: w.alt, lat: w.lat, lon: w.lon, alt: w.alt, pass: w.pass };
  });
  const segs = [];
  for (let i = 1; i < pts.length; i++) {
    const p0 = pts[i - 1];
    const p1 = pts[i];
    segs.push({
      i, p0, p1,
      min: { x: Math.min(p0.x, p1.x), y: Math.min(p0.y, p1.y), z: Math.min(p0.z, p1.z) },
      max: { x: Math.max(p0.x, p1.x), y: Math.max(p0.y, p1.y), z: Math.max(p0.z, p1.z) },
    });
  }

  const worstLeg = new Map();   // leg index -> the closest call on that leg
  const obstacles = [];
  const bounds = new Float64Array(segs.length);
  let minDist = Infinity;

  for (const b of boxes) {
    let closest = Infinity;
    let closestAt = null;
    let bestBound = Infinity;
    let bestBoundIdx = -1;
    let legs = 0;
    let grade = null;

    // Everything that could be within the clearance, measured exactly.
    for (let i = 0; i < segs.length; i++) {
      const bound = aabbGap(segs[i], b);
      bounds[i] = bound;
      if (bound < bestBound) { bestBound = bound; bestBoundIdx = i; }
      if (bound >= clearance) continue;
      const r = segmentBoxDist(segs[i].p0, segs[i].p1, b);
      if (r.dist < closest) { closest = r.dist; closestAt = r.at; }
      const g = gradeOf(r.dist, clearance);
      if (!g) continue;
      legs++;
      if (grade !== 'strike') grade = g;
      const prev = worstLeg.get(segs[i].i);
      if (!prev || r.dist < prev.dist) {
        worstLeg.set(segs[i].i, { seg: segs[i], dist: r.dist, grade: g, obstacle: b.id });
      }
    }

    // Nothing came near, but "18 m clear" is still the answer to the question,
    // so find the real closest approach. Branch and bound off the tightest
    // lower bound: after the first exact measurement almost every other leg is
    // dismissed by arithmetic that already happened.
    if (closest === Infinity && bestBoundIdx >= 0) {
      closest = segmentBoxDist(segs[bestBoundIdx].p0, segs[bestBoundIdx].p1, b).dist;
      for (let i = 0; i < segs.length; i++) {
        if (i === bestBoundIdx || bounds[i] >= closest) continue;
        const d = segmentBoxDist(segs[i].p0, segs[i].p1, b).dist;
        if (d < closest) closest = d;
      }
    }

    if (closest < minDist) minDist = closest;
    obstacles.push({
      id: b.id, name: b.name, height: b.max.z,
      dist: closest, legs, grade, at: closestAt,
    });
  }

  const legs = [...worstLeg.values()]
    .sort((a, c) => a.seg.i - c.seg.i)
    .map((l) => ({
      a: { lat: l.seg.p0.lat, lon: l.seg.p0.lon, alt: l.seg.p0.alt },
      b: { lat: l.seg.p1.lat, lon: l.seg.p1.lon, alt: l.seg.p1.alt },
      index: l.seg.i,
      pass: l.seg.p1.pass,
      dist: l.dist,
      grade: l.grade,
      obstacle: l.obstacle,
    }));

  obstacles.sort((a, c) => a.dist - c.dist);
  return {
    clearance,
    obstacles,
    legs,
    strikes: obstacles.filter((o) => o.grade === 'strike').length,
    near: obstacles.filter((o) => o.grade === 'near').length,
    minDist: minDist === Infinity ? null : minDist,
  };
}

// The lowest altitude the plan could fly at and still clear everything it
// passes over, which is the number you actually want the moment the answer is
// "it hits something". A tower off to one side does not set your altitude, so
// only boxes the path crosses horizontally count.
export function clearingAltitude(mission, boxes, clearance = 5) {
  if (!mission || !boxes?.length) return null;
  const f = mission.frame;
  const path = mission.exported ?? mission.waypoints ?? [];
  let need = 0;
  for (const b of boxes) {
    const over = path.some((w) => {
      const l = f.toLocal(w.lat, w.lon);
      return l.x > b.min.x - clearance && l.x < b.max.x + clearance
          && l.y > b.min.y - clearance && l.y < b.max.y + clearance;
    });
    if (over) need = Math.max(need, b.max.z + clearance);
  }
  return need || null;
}

// Where the LOWEST orbit ring should fly: just over the tallest thing on the
// site, by the clearance you are willing to fly at. It is a framing number as
// much as a safety one -- the first ring is the one that looks along the tops
// of things, and half the set altitude, which is what the planner uses without
// it, is a shape rather than a measurement.
//
// The tallest thing anywhere on the site, not just under the ring: the ring
// flies OUTSIDE the site, so nothing it passes over sets this. What sets it is
// what you are photographing.
//
// Heights rather than boxes, unlike everything else here, because this is the
// one question in the file that footprints have no bearing on -- and asking for
// heights means it can be answered before there is a plan to build a local
// frame from, which is where it is needed.
export function ringFloor(heights, clearance = 5) {
  if (!heights?.length) return null;
  return Math.max(...heights) + clearance;
}
