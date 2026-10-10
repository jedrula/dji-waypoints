// What each photo of a plan actually sees of the ground, measured against the
// survey, and two judgements built on it:
//
//   heat      per spot of ground or wall, how well the capture will
//             reconstruct it -- seen often, from close, from angles far
//             enough apart to triangulate
//   links     per pair of consecutive photos, whether they share enough of
//             the scene for SEQUENTIAL matching (GLOMAP / COLMAP sequential)
//             to chain them; and a fix that adds shots where they do not
//
// Everything is in the mission's local metres with z up, and every height
// comes from `yAt(x, y)`: the survey surface at that point, in metres above the
// same zero the waypoints' altitudes are measured from (see surface.js), or
// null where there is no survey. Pure arithmetic, so it is tested under node.
//
// Why not js/coverage.js: that scores a proxy of boxes, which is the right tool
// before there is a survey. This scores the survey itself -- the walls of a
// quarry are not boxes -- and only runs where one is loaded. Where none is,
// nothing here runs and the plan is what it was.

import { fov, orientation, CAMERAS } from './camera.js';

const DEG = Math.PI / 180;

// A cell steeper than this between neighbours is a face, not a slope: the
// same 1.75-2 m step js/scene3d.js already calls a wall.
const WALL_STEP_M = 2;

// The surface as sample points: one on the ground per grid cell, and a column
// of them up every face the grid steps over. `painted(x, y)` says which ones
// the person asked for; the rest are still sampled, because consecutive-photo
// overlap is a question about everything in the frame, not just the subject.
export function surfaceSamples({ yAt, x0, x1, y0, y1, step = 3, painted = () => false }) {
  const out = [];
  const h = (x, y) => yAt(x, y);
  for (let x = x0; x <= x1; x += step) {
    for (let y = y0; y <= y1; y += step) {
      const z = h(x, y);
      if (z === null || !Number.isFinite(z)) continue;
      // Normal from central differences; a raster has no better answer.
      const zx = (h(x + step / 2, y) ?? z) - (h(x - step / 2, y) ?? z);
      const zy = (h(x, y + step / 2) ?? z) - (h(x, y - step / 2) ?? z);
      const nx = -zx / step;
      const ny = -zy / step;
      const nl = Math.hypot(nx, ny, 1);
      const mine = painted(x, y);
      out.push({ x, y, z: z + 0.2, nx: nx / nl, ny: ny / nl, nz: 1 / nl, painted: mine, wall: false });
      // A face between this cell and the next one east, and north.
      for (const [dx, dy] of [[step, 0], [0, step]]) {
        const z2 = h(x + dx, y + dy);
        if (z2 === null || !Number.isFinite(z2) || Math.abs(z2 - z) < WALL_STEP_M) continue;
        const lowFirst = z < z2;
        const lo = Math.min(z, z2);
        const hi = Math.max(z, z2);
        // Facing the low side: that is where a camera has to be to see it.
        const fx = (lowFirst ? -dx : dx) / step;
        const fy = (lowFirst ? -dy : dy) / step;
        const mx = x + dx / 2;
        const my = y + dy / 2;
        const both = mine || painted(x + dx, y + dy);
        for (let zz = lo + 1; zz < hi; zz += 2) {
          out.push({ x: mx + fx * 0.3, y: my + fy * 0.3, z: zz, nx: fx, ny: fy, nz: 0, painted: both, wall: true });
        }
      }
    }
  }
  return out;
}

// Every photo the plan takes, in the order it takes them: a waypoint's fan is
// several frames from one place.
export function framesOf(mission) {
  const out = [];
  mission.exported.forEach((w, wi) => {
    if (w.photo === false) return;
    const p = mission.frame.toLocal(w.lat, w.lon);
    const yaw = w.yaw ?? w.heading?.angle ?? 0;
    for (const pitch of w.shots ?? [w.pitch]) {
      out.push({ x: p.x, y: p.y, z: w.alt, yaw, pitch, wp: wi });
    }
  });
  return out;
}

// For one frame, the samples it sees: in the frustum, facing it within
// `maxInc` of their normal, and with nothing in the survey standing above the
// line between them. The march stops once the ray is above everything, which
// is what keeps this affordable: most rays clear the terrain in a few steps.
export function frameSees(frame, samples, yAt, {
  cam = CAMERAS.mini5pro, maxInc = 75, march = 1, ceiling = Infinity, maxRange = 400,
} = {}) {
  const f = fov(cam);
  const tanH = Math.tan(f.h / 2);
  const tanV = Math.tan(f.v / 2);
  const o = orientation(frame.yaw, frame.pitch);
  const cosInc = Math.cos(maxInc * DEG);
  const seen = [];
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const dx = s.x - frame.x;
    const dy = s.y - frame.y;
    const dz = s.z - frame.z;
    const fz = dx * o.forward.x + dy * o.forward.y + dz * o.forward.z;
    if (fz <= 0) continue;
    if (Math.abs((dx * o.right.x + dy * o.right.y) / fz) > tanH) continue;
    if (Math.abs((dx * o.up.x + dy * o.up.y + dz * o.up.z) / fz) > tanV) continue;
    const d = Math.hypot(dx, dy, dz);
    if (d > maxRange) continue;
    // A sample with no normal -- a LiDAR point, which has a position and a
    // colour and no surface orientation -- is judged by sight line alone.
    const facing = s.nx || s.ny || s.nz;
    if (facing && -(dx * s.nx + dy * s.ny + dz * s.nz) / d < cosInc) continue;
    let blocked = false;
    for (let t = 1; t < d; t += march) {
      const k = t / d;
      const pz = s.z - dz * k;
      if (pz > ceiling) break;
      const g = yAt(s.x - dx * k, s.y - dy * k);
      if (g !== null && g > pz + 0.3) { blocked = true; break; }
    }
    if (!blocked) seen.push(i);
  }
  return seen;
}

// How well one spot will reconstruct, 0 (cold) to 1 (hot), from the photos
// that see it. Three things, multiplied, because each one alone is worthless
// without the others:
//
//   views      enough of them -- three is the floor the README's capture
//              guidance sets, so three full-weight views saturate it
//   closeness  a view's weight falls off past `nearM`: twice as far is half
//              the pixels on the thing, so half the detail
//   parallax   the widest angle between any two of its views; depth comes
//              from that angle, and under ~5 degrees there is next to none.
//              Saturates at `goodParallax`.
export function heatOf(sample, views, { nearM = 15, goodParallax = 20, need = 3 } = {}) {
  if (!views.length) return 0;
  let weight = 0;
  const dirs = [];
  for (const v of views) {
    const dx = v.x - sample.x;
    const dy = v.y - sample.y;
    const dz = v.z - sample.z;
    const d = Math.hypot(dx, dy, dz);
    weight += Math.min(1, nearM / Math.max(d, 1e-6));
    dirs.push([dx / d, dy / d, dz / d]);
  }
  let widest = 0;
  // Pairwise is quadratic, so a spot seen by a hundred frames is thinned to
  // forty: the widest pair is not going to hide among the rest.
  const step = Math.max(1, Math.floor(dirs.length / 40));
  for (let i = 0; i < dirs.length; i += step) {
    for (let j = i + step; j < dirs.length; j += step) {
      const c = dirs[i][0] * dirs[j][0] + dirs[i][1] * dirs[j][1] + dirs[i][2] * dirs[j][2];
      widest = Math.max(widest, Math.acos(Math.max(-1, Math.min(1, c))) / DEG);
    }
  }
  return Math.min(1, weight / need) * Math.min(1, widest / goodParallax);
}

// Everything at once: what each frame sees, and the heat of every sample.
export function measureViews(mission, samples, yAt, opts = {}) {
  const frames = framesOf(mission);
  const ceiling = samples.reduce((m, s) => Math.max(m, s.z), -Infinity) + 1;
  const sees = frames.map((fr) => frameSees(fr, samples, yAt, { ...opts, ceiling }));
  const byS = samples.map(() => []);
  sees.forEach((list, fi) => { for (const si of list) byS[si].push(frames[fi]); });
  const heat = samples.map((s, i) => heatOf(s, byS[i], opts));
  return { frames, sees, heat, ceiling };
}

// The share of the painted surface that is hot enough: what "every painted
// patch is captured" is measured as.
export function paintedCoverage(samples, heat, { hot = 0.5 } = {}) {
  let n = 0;
  let ok = 0;
  samples.forEach((s, i) => { if (s.painted) { n++; if (heat[i] >= hot) ok++; } });
  return n ? ok / n : null;
}

// Consecutive photos that share less than `minOverlap` of what they see.
// Overlap is shared samples over the smaller of the two sets. A frame that
// sees almost nothing of the sampled ground -- an outward horizon frame -- is
// not judged: the samples cannot speak for what it shares with its
// neighbour, and calling that a broken link would bridge the sky.
export function weakLinks(sees, { minOverlap = 0.3, minSeen = 15 } = {}) {
  const weak = [];
  for (let i = 0; i + 1 < sees.length; i++) {
    const a = sees[i];
    const b = sees[i + 1];
    if (a.length < minSeen || b.length < minSeen) continue;
    if (shared(a, b) < minOverlap) weak.push(i);
  }
  return weak;
}

function shared(a, b) {
  const [small, big] = a.length < b.length ? [a, b] : [b, a];
  if (!small.length) return 0;
  const set = new Set(big);
  let n = 0;
  for (const i of small) if (set.has(i)) n++;
  return n / small.length;
}

// Shots added along the legs where consecutive photos do not overlap.
//
// Each added shot is a waypoint ON THE STRAIGHT LEG between the two waypoints
// either side of the gap -- the line the aircraft already flies between them
// -- with the camera turned part of the way from one view to the other. So the
// path is the same path: nothing here can move the aircraft anywhere the plan
// did not already send it, which is the argument for it being safe to apply
// without a second collision check. What it does cost is a stop per shot.
//
// Bisection: try the midpoint, and recurse into either half that still does
// not overlap, to a depth of `maxDepth` (at most 2^maxDepth - 1 shots a gap).
export function bridgeMission(mission, samples, yAt, opts = {}) {
  const { minOverlap = 0.3, minSeen = 15, maxDepth = 3, maxWaypoints = 200 } = opts;
  const ceiling = samples.reduce((m, s) => Math.max(m, s.z), -Infinity) + 1;
  const see = (fr) => frameSees(fr, samples, yAt, { ...opts, ceiling });
  const wps = mission.exported;
  const local = (w) => ({ ...mission.frame.toLocal(w.lat, w.lon), z: w.alt });
  const yawOf = (w) => w.yaw ?? w.heading?.angle ?? 0;
  const lastShot = (w) => (w.shots ?? [w.pitch]).at(-1);
  const firstShot = (w) => (w.shots ?? [w.pitch])[0];

  const added = new Map();   // index of the waypoint the shots follow -> [wp]
  let total = 0;
  for (let i = 0; i + 1 < wps.length; i++) {
    const A = wps[i];
    const B = wps[i + 1];
    if (A.photo === false || B.photo === false) continue;
    const pa = local(A);
    const pb = local(B);
    const fa = { ...pa, yaw: yawOf(A), pitch: lastShot(A) };
    const fb = { ...pb, yaw: yawOf(B), pitch: firstShot(B) };
    const sa = see(fa);
    const sb = see(fb);
    if (sa.length < minSeen || sb.length < minSeen || shared(sa, sb) >= minOverlap) continue;
    const mids = [];
    const split = (t0, s0, t1, s1, depth) => {
      if (shared(s0, s1) >= minOverlap || depth >= maxDepth) return;
      const t = (t0 + t1) / 2;
      const yaw = yawOf(A) + (((yawOf(B) - yawOf(A) + 540) % 360) - 180) * t;
      const pitch = lastShot(A) + (firstShot(B) - lastShot(A)) * t;
      const fr = { x: pa.x + (pb.x - pa.x) * t, y: pa.y + (pb.y - pa.y) * t,
        z: pa.z + (pb.z - pa.z) * t, yaw: (yaw + 360) % 360, pitch };
      const sm = see(fr);
      split(t0, s0, t, sm, depth + 1);
      mids.push({ t, fr });
      split(t, sm, t1, s1, depth + 1);
    };
    split(0, sa, 1, sb, 0);
    if (!mids.length) continue;
    if (wps.length + total + mids.length > maxWaypoints) break;
    total += mids.length;
    added.set(i, mids.map(({ fr }) => {
      const g = mission.frame.toLatLon(fr.x, fr.y);
      return {
        lat: g.lat, lon: g.lon, alt: fr.z, speed: A.speed, pass: 'bridge',
        yaw: fr.yaw, pitch: fr.pitch, shots: [fr.pitch],
        heading: { mode: 'smoothTransition', angle: fr.yaw },
      };
    }));
  }
  if (!total) return { mission, added: 0 };

  const exported = [];
  wps.forEach((w, i) => { exported.push(w); for (const m of added.get(i) ?? []) exported.push(m); });
  exported.forEach((w, i) => { w.exportIndex = i; });
  const stats = {
    ...mission.stats,
    waypoints: exported.length,
    photos: mission.stats.photos + total,
    // A stop and a shutter each, the planner's own stop cost.
    seconds: mission.stats.seconds + total * 2.5,
  };
  stats.minutes = stats.seconds / 60;
  stats.batteries = Math.ceil(stats.minutes / (mission.params?.usableFlightMin ?? 18));
  return { mission: { ...mission, exported, stats }, added: total };
}
