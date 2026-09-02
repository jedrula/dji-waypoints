import { fov, orientation } from './camera.js';

// Geometric coverage scoring. Published capture guidance is written in terms of
// geometry -- every surface in at least three frames, from a spread of
// directions, including one from above -- so a proxy of the site plus the
// planned camera poses answers most capture questions without rendering
// anything or training a splat.
//
// It scores COVERAGE, not reconstruction quality. Coverage is necessary but not
// sufficient: a surface can be well covered and still reconstruct badly if it
// is textureless or moving. Treat a good score as "not obviously starved",
// not as "this will look great".

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const len = (a) => Math.hypot(a.x, a.y, a.z);
const scale = (a, s) => ({ x: a.x * s, y: a.y * s, z: a.z * s });

export const SCORE_DEFAULTS = {
  minViews: 3,          // guidance: every surface in at least three frames
  minSpreadDeg: 15,     // below this the views share a viewpoint -- no parallax
  downAngleDeg: 40,     // a view counts as "from above" past this elevation
  maxIncidenceDeg: 75,  // grazing views carry almost no surface detail
  minRange: 1,
  maxRange: 250,
  maxCameras: 0,        // 0 = use every frame; set a cap for interactive use
  groundStep: 3,        // metres between ground samples
  faceStep: 1.2,        // metres between samples on a structure face
};

// The surfaces the scorer measures: one cube per subject the planner flies
// around. Deliberately derived from the SAME list -- subjectsOf in
// js/planner.js -- because a plan optimised for one set of things and graded
// against another is a plan optimised for nothing.
//
// It used to invent five blocks in a crossroads, sized off the bounding box and
// one global subject height, because that was all the app knew. That fiction
// scored somewhere you never described, and drew an imaginary town over the
// real site in 3D.
export function buildProxy(subjects = []) {
  return subjects
    .filter((s) => (s.height ?? 0) > 0.5)
    .map((s) => {
      // Two half-spans: a long thing squared off would have the scorer grading
      // the ground beside it as facade.
      const hx = Math.max(0.5, (s.spanX ?? s.span ?? 6) / 2);
      const hy = Math.max(0.5, (s.spanY ?? s.span ?? 6) / 2);
      return {
        min: { x: s.x - hx, y: s.y - hy, z: 0 },
        max: { x: s.x + hx, y: s.y + hy, z: s.height },
      };
    });
}

// `boxes` are the surfaces being scored; `occluders` is everything solid,
// which is those plus whatever you drew. There is no ground under either.
function sampleSurfaces(halfX, halfY, boxes, occluders, cfg) {
  const out = [];
  const inABox = (x, y) => occluders.some((b) =>
    x > b.min.x && x < b.max.x && y > b.min.y && y < b.max.y);

  // ground
  for (let x = -halfX; x <= halfX; x += cfg.groundStep) {
    for (let y = -halfY; y <= halfY; y += cfg.groundStep) {
      if (inABox(x, y)) continue;
      out.push({ p: { x, y, z: 0 }, n: { x: 0, y: 0, z: 1 }, kind: 'ground' });
    }
  }

  // structure faces: four walls plus the top
  for (const b of boxes) {
    const w = b.max.x - b.min.x;
    const d = b.max.y - b.min.y;
    const h = b.max.z;
    const st = cfg.faceStep;
    for (let z = st / 2; z < h; z += st) {
      for (let x = b.min.x + st / 2; x < b.max.x; x += st) {
        out.push({ p: { x, y: b.min.y, z }, n: { x: 0, y: -1, z: 0 }, kind: 'wall' });
        out.push({ p: { x, y: b.max.y, z }, n: { x: 0, y: 1, z: 0 }, kind: 'wall' });
      }
      for (let y = b.min.y + st / 2; y < b.max.y; y += st) {
        out.push({ p: { x: b.min.x, y, z }, n: { x: -1, y: 0, z: 0 }, kind: 'wall' });
        out.push({ p: { x: b.max.x, y, z }, n: { x: 1, y: 0, z: 0 }, kind: 'wall' });
      }
    }
    for (let x = b.min.x + st / 2; x < b.max.x; x += st) {
      for (let y = b.min.y + st / 2; y < b.max.y; y += st) {
        out.push({ p: { x, y, z: h }, n: { x: 0, y: 0, z: 1 }, kind: 'top' });
      }
    }
    void w; void d;
  }
  return out;
}

// Slab test. Returns true if the segment from `p` towards `dir` for `maxT`
// metres enters the box.
function raySegmentHitsBox(p, dir, maxT, b) {
  let t0 = 0;
  let t1 = maxT;
  for (const ax of ['x', 'y', 'z']) {
    const d = dir[ax];
    if (Math.abs(d) < 1e-9) {
      if (p[ax] < b.min[ax] || p[ax] > b.max[ax]) return false;
      continue;
    }
    let ta = (b.min[ax] - p[ax]) / d;
    let tb = (b.max[ax] - p[ax]) / d;
    if (ta > tb) { const s = ta; ta = tb; tb = s; }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t0 > t1) return false;
  }
  return t1 > 1e-4;
}

// `opts.boxes` are the obstacles you drew, in the mission's local frame. They
// block the view of everything behind them, and they are never sampled: a tree
// next to the house is not a surface you failed to photograph, and scoring it
// would only make a good plan look bad.
export function scoreCoverage(mission, opts = {}) {
  const cfg = { ...SCORE_DEFAULTS, ...opts };
  const halfX = mission.sizeX / 2;
  const halfY = mission.sizeY / 2;
  const boxes = buildProxy(mission.subjects ?? []);
  const occluders = [...boxes, ...(opts.boxes ?? [])];
  // Sample density follows site size: a 20 m playground needs finer steps than
  // a 400 m block, and a fixed step would either under-sample one or bury the
  // other in millions of rays.
  const scaleCfg = {
    ...cfg,
    groundStep: opts.groundStep ?? Math.max(1, Math.min(6, Math.min(halfX, halfY) / 6)),
    faceStep: opts.faceStep ?? Math.max(0.4, Math.min(2.5, Math.min(halfX, halfY) / 12)),
  };
  const samples = sampleSurfaces(halfX, halfY, boxes, occluders, scaleCfg);

  // One camera per frame: a stop with a 3-pitch fan is three cameras.
  const f = fov(mission.cam);
  const tanH = Math.tan(f.h / 2);
  const tanV = Math.tan(f.v / 2);
  const cams = [];
  const wpStep = cfg.maxCameras
    ? Math.max(1, Math.ceil(mission.exported.length / cfg.maxCameras))
    : 1;
  for (let i = 0; i < mission.exported.length; i += wpStep) {
    const w = mission.exported[i];
    const l = mission.frame.toLocal(w.lat, w.lon);
    for (const pitch of (w.shots ?? [w.pitch])) {
      cams.push({ pos: { x: l.x, y: l.y, z: w.alt }, ...orientation(w.yaw ?? 0, pitch), pass: w.pass });
    }
  }

  const cosMaxInc = Math.cos((cfg.maxIncidenceDeg * Math.PI) / 180);
  const sinDown = Math.sin((cfg.downAngleDeg * Math.PI) / 180);
  const cosSpread = Math.cos((cfg.minSpreadDeg * Math.PI) / 180);

  const results = [];
  for (const s of samples) {
    const dirs = [];
    let down = false;
    let bestInc = 0;
    const passes = new Set();

    for (const c of cams) {
      const d = sub(c.pos, s.p);
      const dist = len(d);
      if (dist < cfg.minRange || dist > cfg.maxRange) continue;
      const dir = scale(d, 1 / dist);
      const cosInc = dot(s.n, dir);
      if (cosInc < cosMaxInc) continue;         // backface or grazing

      const v = scale(dir, -1);                 // camera -> point
      const z = dot(v, c.forward);
      if (z <= 0) continue;
      if (Math.abs(dot(v, c.right) / z) > tanH) continue;
      if (Math.abs(dot(v, c.up) / z) > tanV) continue;

      const start = { x: s.p.x + s.n.x * 0.02, y: s.p.y + s.n.y * 0.02, z: s.p.z + s.n.z * 0.02 };
      if (occluders.some((b) => raySegmentHitsBox(start, dir, dist - 0.05, b))) continue;

      dirs.push(dir);
      passes.add(c.pass);
      if (cosInc > bestInc) bestInc = cosInc;
      if (dir.z > sinDown) down = true;
    }

    // Widest angle between any two views: the triangulation baseline.
    let minCos = 1;
    for (let i = 0; i < dirs.length; i++) {
      for (let j = i + 1; j < dirs.length; j++) {
        const c = dot(dirs[i], dirs[j]);
        if (c < minCos) minCos = c;
      }
    }
    const spreadDeg = dirs.length > 1 ? (Math.acos(Math.max(-1, Math.min(1, minCos))) * 180) / Math.PI : 0;

    let grade;
    if (dirs.length === 0) grade = 'unseen';
    else if (dirs.length < cfg.minViews) grade = 'thin';
    else if (minCos > cosSpread) grade = 'flat';   // enough views, no parallax
    else grade = 'good';

    results.push({
      ...s,
      views: dirs.length,
      spreadDeg,
      down,
      grade,
      incidenceDeg: (Math.acos(Math.min(1, bestInc)) * 180) / Math.PI,
      passes: [...passes],
    });
  }

  const n = results.length || 1;
  const pct = (fn) => (100 * results.filter(fn).length) / n;
  const byKind = {};
  for (const kind of ['ground', 'wall', 'top']) {
    const set = results.filter((r) => r.kind === kind);
    if (!set.length) continue;
    byKind[kind] = {
      samples: set.length,
      good: (100 * set.filter((r) => r.grade === 'good').length) / set.length,
      unseen: (100 * set.filter((r) => r.grade === 'unseen').length) / set.length,
      down: (100 * set.filter((r) => r.down).length) / set.length,
      meanViews: set.reduce((a, r) => a + r.views, 0) / set.length,
    };
  }

  return {
    samples: results,
    boxes,
    occluders,
    cameras: cams.length,
    summary: {
      surfaces: results.length,
      good: pct((r) => r.grade === 'good'),
      flat: pct((r) => r.grade === 'flat'),
      thin: pct((r) => r.grade === 'thin'),
      unseen: pct((r) => r.grade === 'unseen'),
      withDownAngle: pct((r) => r.down),
      meanViews: results.reduce((a, r) => a + r.views, 0) / n,
      meanSpread: results.reduce((a, r) => a + r.spreadDeg, 0) / n,
      byKind,
    },
  };
}

export const GRADE_COLOR = {
  unseen: '#ff5d5d',
  thin: '#ff9b3d',
  flat: '#ffd83d',
  good: '#4ad991',
};
