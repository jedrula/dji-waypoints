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

import { ringDist, rayClipsSolid } from './prism.js';

// Distance from a point to one solid; zero inside it.
//
// A solid is a footprint extruded from the ground. When it carries a `poly`
// -- a CONVEX ring in the same local metres, see js/prism.js -- the flat part
// of the distance comes from the ring instead of from two subtractions. The
// vertical part, and the hypot that puts them together, are unchanged: a
// convex prism is a convex polygon crossed with a height range, so the
// distance separates exactly the way a box's three sides always did.
export function pointBoxDist(p, b) {
  const dz = Math.max(b.min.z - p.z, 0, p.z - b.max.z);
  if (b.poly) return Math.hypot(ringDist(p, b.poly), dz);
  const dx = Math.max(b.min.x - p.x, 0, p.x - b.max.x);
  const dy = Math.max(b.min.y - p.y, 0, p.y - b.max.y);
  return Math.hypot(dx, dy, dz);
}

// Distance from a segment to a solid, and where along it that happens.
//
// Point-to-solid distance is a convex function of the point, and a segment is
// an affine function of t, so the composition is convex in t with exactly one
// minimum. Ternary search walks straight to it -- no sampling, and so no near
// miss slipping between two samples -- for about forty distance evaluations.
//
// That argument is why js/prism.js cuts a footprint into convex pieces before
// anything gets here. Distance to a convex set is convex whatever its shape;
// distance to an L is not, and the search could then settle in the wrong dip.
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
//
// This is where the bounding box earns its keep now that it is no longer the
// obstacle: a solid's box contains the solid, so the bound stays true and being
// generous only means a few more exact measurements.
export function aabbGap(s, b) {
  const dx = Math.max(b.min.x - s.max.x, 0, s.min.x - b.max.x);
  const dy = Math.max(b.min.y - s.max.y, 0, s.min.y - b.max.y);
  const dz = Math.max(b.min.z - s.max.z, 0, s.min.z - b.max.z);
  return Math.hypot(dx, dy, dz);
}

// One box round the whole flight, in the mission's own local metres. Anything
// further from this than the clearance cannot come within the clearance of any
// leg, because the box contains every leg -- which is what lets a caller drop
// most of a city's worth of import before measuring anything.
export function pathBounds(mission) {
  const f = mission.frame;
  const path = mission.exported ?? mission.waypoints ?? [];
  if (!path.length) return null;
  const lo = { x: Infinity, y: Infinity, z: Infinity };
  const hi = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const w of path) {
    const l = f.toLocal(w.lat, w.lon);
    const p = { x: l.x, y: l.y, z: w.alt };
    for (const ax of ['x', 'y', 'z']) {
      if (p[ax] < lo[ax]) lo[ax] = p[ax];
      if (p[ax] > hi[ax]) hi[ax] = p[ax];
    }
  }
  return { min: lo, max: hi };
}

// A leg is reported at its worst: `strike` if it goes through the box, `near`
// if it comes within the clearance. Both are worth seeing, and they are not the
// same news, so they do not get the same colour.
const gradeOf = (dist, clearance) => (dist <= 0.001 ? 'strike' : dist < clearance ? 'near' : null);

// The pieces of one obstacle, behind one box that contains all of them. They
// arrive already sharing their obstacle's id (see js/prism.js), so this is only
// a grouping -- but it is what makes a footprint affordable. The whole cost of
// this file is a lower bound per leg per solid, and computing that bound once
// per BUILDING instead of once per triangle is an order of magnitude on a real
// import: 58 obstacles came to 667 convex pieces over a Krakow block.
//
// It stays exact because a group's box contains every piece in it, so the
// group's gap to a leg is a lower bound on each piece's gap. A bound that is
// too small only ever means measuring something that turns out to be far away;
// it can never dismiss something that is close.
function grouped(boxes) {
  const out = [];
  const byId = new Map();
  for (const b of boxes) {
    const key = b.id === undefined ? out.length : b.id;
    let g = byId.get(key);
    if (!g) {
      g = { min: { ...b.min }, max: { ...b.max }, parts: [] };
      byId.set(key, g);
      out.push(g);
    }
    g.parts.push(b);
    for (const ax of ['x', 'y', 'z']) {
      if (b.min[ax] < g.min[ax]) g.min[ax] = b.min[ax];
      if (b.max[ax] > g.max[ax]) g.max[ax] = b.max[ax];
    }
  }
  return out;
}

// One entry per OBSTACLE, from however many convex pieces it was cut into.
// Pieces share their obstacle's id, so this is where an L-shaped building stops
// being four triangles and goes back to being a building: the closest piece is
// the closest approach, the worst grade is the grade, and "the flight hits 2
// obstacles" counts buildings rather than triangles.
function byObstacle(pieces) {
  const worst = { strike: 2, near: 1 };
  const out = new Map();
  for (const p of pieces) {
    const prev = out.get(p.id);
    if (!prev) { out.set(p.id, { ...p }); continue; }
    prev.legs += p.legs;
    if ((worst[p.grade] ?? 0) > (worst[prev.grade] ?? 0)) prev.grade = p.grade;
    if (p.dist < prev.dist) { prev.dist = p.dist; prev.at = p.at; }
    prev.height = Math.max(prev.height, p.height);
  }
  return [...out.values()];
}

// Two ways of asking for less, because most of the cost here is answering more
// than the caller wanted.
//
// `distances: false` drops "and this one is clear by 18 m" for the obstacles
// that came nowhere near. Every such obstacle otherwise costs one exact
// measurement -- the whole point of the branch and bound -- and over a city
// block's worth of import that is 7841 of them per replan. Strikes, near
// misses, grades and flagged legs are all unaffected: they come from obstacles
// the flight actually came close to, which are measured either way. `dist` is
// then null, which means not asked rather than zero.
//
// `verdictOnly` is the altitude search's question and nothing else: does this
// flight hit anything at all. It implies the above and also stops at the first
// strike, so `strikes` becomes 0 or 1 and is no longer a census, `near` and
// `minDist` are not filled in, and the list holds only what was looked at. The
// search tries a few hundred candidates and throws most of them away.
export function checkObstacles(
  mission, boxes, { clearance = 5, verdictOnly = false, distances = !verdictOnly } = {},
) {
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

  const nearIdx = [];
  for (const group of grouped(boxes)) {
    // The lower bound per leg, once for the whole obstacle. Every piece inside
    // it inherits these, which is where the order of magnitude comes from: the
    // scan over every leg happens once per building, not once per triangle.
    let bestBound = Infinity;
    let bestBoundIdx = -1;
    nearIdx.length = 0;
    for (let i = 0; i < segs.length; i++) {
      const bound = aabbGap(segs[i], group);
      bounds[i] = bound;
      if (bound < bestBound) { bestBound = bound; bestBoundIdx = i; }
      if (bound < clearance) nearIdx.push(i);
    }
    // Nothing about this obstacle can be within the clearance, and nobody
    // asked how far clear it is.
    if (!distances && !nearIdx.length) continue;

    for (const b of group.parts) {
      let closest = Infinity;
      let closestAt = null;
      let legs = 0;
      let grade = null;

      // Everything that could be within the clearance, measured exactly. The
      // group's bound got us to a handful of legs; this piece's own bound is
      // what says whether the piece is near any of them, and it is computed
      // only for those few.
      for (const i of nearIdx) {
        if (aabbGap(segs[i], b) >= clearance) continue;
        // A verdict does not need a number. Does this leg go through the
        // thing: clip it against the solid and see whether any of it survives.
        if (verdictOnly) {
          const { p0, p1 } = segs[i];
          if (!rayClipsSolid(b, p0.x, p0.y, p0.z,
            p1.x - p0.x, p1.y - p0.y, p1.z - p0.z, 1)) continue;
          grade = 'strike';
          legs++;
          break;
        }
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

      // Nothing came near, but "18 m clear" is still the answer to the
      // question, so find the real closest approach. Branch and bound off the
      // tightest lower bound: after the first exact measurement almost every
      // other leg is dismissed by arithmetic that already happened.
      //
      // `closest` has to be BELOW the clearance to be trusted as the answer.
      // A piece whose group came near but which is not itself near ends the
      // loop above holding some distance to a leg that happened to be checked,
      // which is a distance and not the smallest one -- the legs that were
      // skipped were only ever proved to be at least a clearance away.
      if (distances && !(closest < clearance) && bestBoundIdx >= 0) {
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
      if (verdictOnly && grade === 'strike') {
        return {
          clearance, legs: [], strikes: 1, near: 0, minDist: null,
          obstacles: byObstacle(obstacles),
        };
      }
    }
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

  const found = byObstacle(obstacles).sort((a, c) => a.dist - c.dist);
  // Never measured, because nobody asked: a number is missing, not zero.
  for (const o of found) if (o.dist === Infinity) o.dist = null;
  return {
    clearance,
    obstacles: found,
    legs,
    strikes: found.filter((o) => o.grade === 'strike').length,
    near: found.filter((o) => o.grade === 'near').length,
    minDist: minDist === Infinity ? null : minDist,
  };
}

// The lowest altitude the plan could fly at and still clear everything it
// passes over, which is the number you actually want the moment the answer is
// "it hits something". A tower off to one side does not set your altitude, so
// only boxes the path crosses horizontally count.
// Takes `{ clearance }` rather than a bare number, like checkObstacles beside
// it. It used to take the number, the app passed it the object, and JavaScript
// quietly compared metres with an object: every test came out false and the
// suggestion the whole function exists to make never appeared. The two
// functions are called on the same line and now read the same.
export function clearingAltitude(mission, boxes, { clearance = 5 } = {}) {
  if (!mission || !boxes?.length) return null;
  const f = mission.frame;
  const path = mission.exported ?? mission.waypoints ?? [];
  // The path in local metres ONCE, not once per solid: with a city block
  // imported that was 180,000 conversions to answer one question.
  const pts = path.map((w) => f.toLocal(w.lat, w.lon));
  // Tallest first, so that anything which could not raise the answer even if
  // the flight went straight through it is never asked about.
  const tall = [...boxes].sort((a, b) => b.max.z - a.max.z);
  let need = 0;
  for (const b of tall) {
    const top = b.max.z + clearance;
    if (top <= need) break;
    const over = pts.some((l) => {
      // The box first; it contains the outline, so a point outside it by more
      // than the clearance is outside the outline by more than the clearance.
      if (l.x <= b.min.x - clearance || l.x >= b.max.x + clearance
          || l.y <= b.min.y - clearance || l.y >= b.max.y + clearance) return false;
      return b.poly ? ringDist(l, b.poly) < clearance : true;
    });
    if (over) need = top;
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
