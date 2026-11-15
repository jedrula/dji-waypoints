// A painted wall, flown from in front.
//
// Asked for on 2026-11-13 at Lagos: a facade painted in 3D came back as an
// outline plus a height (js/site.js paintedSite), and the planner flew rings
// round the building and over its roof -- the wall photographed at -24 to -55
// degrees from above, never head on. A wall wants the drone standing off it at
// a fixed distance, camera level and facing it, on a vertical lawnmower.
//
// Two decisions this file makes, and the evidence for each:
//
//  - It IS a facade when most of what was painted is steep. The brush records
//    the surface's normal where it lands (scene3d paintAt); a wall's is
//    horizontal, a roof's or a field's points up. Outline alone cannot tell:
//    the Lagos stroke covered 30 x 24 m with 14 m of relief, which is a wall
//    and its roof edge and a slope alike.
//
//  - One waypoint per photo, one heading per waypoint. DJI Fly on a Mini 5 Pro
//    ignores turn and extra-shutter actions inside a waypoint (flown
//    2026-11-08, see TODO.md), so nothing here relies on them.
//
// Heights come from the terrain grid, not from the brush: the brush's y is in
// whatever frame the 3D view stood in when it painted, and that frame moves.
// The grid's ground (DGT's MDT in Portugal) gives the foot of the wall and the
// takeoff; its surface (MDS) gives the top.

import { frame, bearing } from './geo.js';
import { fov } from './camera.js';

// How much of a stroke has to be steep, and what steep is: a surface within
// 60 degrees of vertical (|up| < 0.5).
const STEEP_UP = 0.5;
const STEEP_SHARE = 0.5;

// The painted cells -> a wall, or null if this is not one.
//   { centre {lat,lon}, out {e,n} (unit, away from the wall), along {e,n},
//     faceE/faceN: the wall line (outermost painted point), s0..s1 along it,
//     cells: the steep ones, in local metres }
export function facadeFrom(cells) {
  if (!cells?.length) return null;
  const withN = cells.filter((c) => c.normal);
  if (withN.length < 6) return null;
  const steep = withN.filter((c) => Math.abs(c.normal.u) < STEEP_UP);
  if (steep.length < STEEP_SHARE * withN.length) return null;
  let se = 0;
  let sn = 0;
  for (const c of steep) {
    const h = Math.hypot(c.normal.e, c.normal.n) || 1;
    se += c.normal.e / h;
    sn += c.normal.n / h;
  }
  const len = Math.hypot(se, sn);
  // Facing every which way -- a tower painted all round, a rock -- is not one
  // wall; leave it to the orbit.
  if (len < 0.6 * steep.length) return null;
  const mean = { e: se / len, n: sn / len };
  const f = frame(steep[0].lat, steep[0].lon);
  const local = steep.map((c) => f.toLocal(c.lat, c.lon));
  // The wall's direction from where the paint LIES -- the line the steep
  // spots spread along (their principal axis) -- and the normals only for
  // which side is outside. Taking the direction from the averaged normals
  // tilted the wall with their noise: 1.15 degrees of lean in the test
  // normals put stations 10.6 m off a 10 m standoff at the end of a 30 m
  // wall. A stroke too short to have a direction falls back to the normals.
  const cx = local.reduce((a, p) => a + p.x, 0) / local.length;
  const cy = local.reduce((a, p) => a + p.y, 0) / local.length;
  let sxx = 0; let syy = 0; let sxy = 0;
  for (const p of local) { sxx += (p.x - cx) ** 2; syy += (p.y - cy) ** 2; sxy += (p.x - cx) * (p.y - cy); }
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const spread = Math.sqrt(Math.max(sxx, syy) / local.length);
  let out = mean;
  if (spread > 2) {
    const ax = { e: Math.cos(ang), n: Math.sin(ang) };
    const perp = { e: -ax.n, n: ax.e };
    out = perp.e * mean.e + perp.n * mean.n >= 0 ? perp : { e: -perp.e, n: -perp.n };
  }
  const along = { e: -out.n, n: out.e };
  const off = local.map((p) => p.x * out.e + p.y * out.n);
  // How far along the wall: everything painted, not only the steep spots.
  // Lagos 2026-11-14: 64 m of wall painted, 76 of 137 cells steep, and the
  // steep ones all at one end -- along the rest the brush landed on balcony
  // floors and the roof edge, which point up -- so the plan covered 37 m and
  // stopped. The direction and the side still come from the steep cells; the
  // length is what you painted.
  const s = cells.map((c) => { const p = f.toLocal(c.lat, c.lon); return p.x * along.e + p.y * along.n; });
  const face = Math.max(...off);   // the outermost painted point: stand off from THAT
  const s0 = Math.min(...s);
  const s1 = Math.max(...s);
  const mid = f.toLatLon(out.e * face + along.e * (s0 + s1) / 2, out.n * face + along.n * (s0 + s1) / 2);
  return { f, out, along, face, s0, s1, centre: mid, steep: steep.length, of: withN.length };
}

// The stations. `ground(lat, lon)` and `surface(lat, lon)` are metres above sea
// level from the terrain grid (bare earth read low, surface read high), null
// off it. Returns waypoints in the planner's shape, altitudes above the ground
// under the FIRST station, which is where the plan's own checks measure from.
export function facadeStations(w, { standoff = 10, sideOverlap = 0.7, frontOverlap = 0.8, speed = 3,
  cam, ground, surface, floor = null }) {
  const v = fov(cam);
  const frameW = 2 * standoff * Math.tan(v.h / 2);
  const frameH = 2 * standoff * Math.tan(v.v / 2);
  const dCol = Math.max(1, frameW * (1 - sideOverlap));
  const dRow = Math.max(1, frameH * (1 - frontOverlap));
  // Columns from end to end, inset by nothing: the end frames overhang.
  const length = Math.max(0, w.s1 - w.s0);
  const nCol = Math.max(1, Math.ceil(length / dCol) + 1);
  const cols = Array.from({ length: nCol }, (_, k) => (nCol === 1 ? (w.s0 + w.s1) / 2 : w.s0 + (length * k) / (nCol - 1)));

  const atRaw = (s, d) => w.f.toLatLon(w.out.e * (w.face + d) + w.along.e * s, w.out.n * (w.face + d) + w.along.n * s);
  // Where the wall actually is, along each column: walk outward from the
  // paint until the surface comes down to the ground (within 1.5 m) and stays
  // there for 2 m. The paint alone does not say: at Lagos on 2026-11-13 the
  // steep spots the brush found were roof edges and steps in the 1 m surface,
  // and the "outermost painted point" sat 15 m inside the block -- every
  // station on the roof, 123 legs struck. The ground model knows where the
  // building ends; the wall's offset is the furthest of the columns' (all the
  // stations stand off ONE plane, so a recess is seen from further back).
  //
  // The FIRST open run after the building, not the last: the walk used to
  // forget an edge whenever the surface rose again, so it reported the far
  // side of the next block or the street's trees -- 35 m out at Lagos.
  // Building has to be seen first, so a courtyard behind the painted wall is
  // not taken for the street in front of it.
  let wallD = -Infinity;
  for (let k = 0; k <= 8; k++) {
    const s = w.s0 + ((w.s1 - w.s0) * k) / 8;
    let built = false;
    let start = null;   // where the current run of open ground began
    let edge = null;
    for (let d = -10; d <= 40 && edge === null; d += 0.5) {
      const p = atRaw(s, d);
      const g = ground(p.lat, p.lon);
      const t = surface(p.lat, p.lon);
      if (g === null || t === null) { start = null; continue; }
      if (t - g >= 1.5) { built = true; start = null; continue; }
      if (!built) continue;
      if (start === null) start = d;
      if (d - start >= 2) edge = start;
    }
    if (edge !== null) wallD = Math.max(wallD, edge);
  }
  if (!Number.isFinite(wallD)) return null;
  const at = (s, d) => atRaw(s, wallD + d);
  // The wall's foot and top, along its line: ground just in front of it (read
  // low), surface just behind its face (read high).
  const feet = [];
  const tops = [];
  for (const s of cols) {
    const g = ground(...Object.values(at(s, 3)));
    if (g !== null) feet.push(g);
    for (const d of [-1, -3, -6]) {
      const t = surface(...Object.values(at(s, d)));
      if (t !== null) tops.push(t);
    }
  }
  if (!feet.length || !tops.length) return null;
  const foot = Math.min(...feet);
  const top = Math.max(...tops);
  if (top - foot < 3) return null;

  // Rows from 3 m above the foot to just over the top; the last one looks down
  // 20 degrees across the roof edge, the rest are level.
  const rows = [];
  for (let z = foot + 3; z < top; z += dRow) rows.push({ z, pitch: 0 });
  rows.push({ z: top + frameH * 0.25, pitch: -20 });

  const facing = (bearing(at(0, 1), at(0, 0)) + 360) % 360;
  const first = at(cols[0], standoff);
  const datum = ground(first.lat, first.lon);
  if (datum === null) return null;

  // Never under the clearance floor where a station stands, nor halfway to
  // the next column: the rows are laid from the LOWEST foot along the wall,
  // and the street in front is not level, nor empty -- at Lagos the bottom
  // row put 27 legs within 3 m of kerbs, bushes and parked cars. Floored at
  // the stations alone, two legs were still struck, both the hop along the
  // bottom row from one column to the next, over something between them.
  // The midpoint's floor reaches clearance + 1 m round it, and the columns
  // are about 5 m apart, so the station's and the midpoint's together cover
  // the whole hop. Up, never out -- out is the next block.
  const fl = (lat, lon) => { const v = floor?.(lat, lon); return Number.isFinite(v) ? v : -Infinity; };
  const own = cols.map((s) => { const p = at(s, standoff); return fl(p.lat, p.lon); });
  const mid = cols.slice(1).map((s, i) => { const p = at((cols[i] + s) / 2, standoff); return fl(p.lat, p.lon); });
  const pts = [];
  cols.forEach((s, ci) => {
    const p = at(s, standoff);
    const lo = Math.max(own[ci], ci > 0 ? mid[ci - 1] : -Infinity, ci < mid.length ? mid[ci] : -Infinity);
    const zs = rows.map((r) => (Number.isFinite(lo) ? Math.max(r.z, lo) : r.z));
    // A row lifted to within half a row of the next one is that row again:
    // the lift made 5.8 m and 6.2 m at Lagos, two photos of the same strip.
    const keep = rows.map((r, i) => i === rows.length - 1 || zs[i + 1] - zs[i] >= dRow / 2);
    const col = rows.map((r, i) => ({ r, z: zs[i] })).filter((_, i) => keep[i]);
    const order = ci % 2 === 0 ? col : [...col].reverse();
    order.forEach(({ r, z }, ri) => {
      pts.push({
        lat: p.lat, lon: p.lon, alt: +(Math.ceil((z - datum) * 10) / 10).toFixed(1),
        pitch: r.pitch, heading: { mode: 'smoothTransition', angle: facing > 180 ? facing - 360 : facing },
        pass: 'facade', lineStart: ri === 0, speed,
      });
    });
  });
  // The wall itself, end to end, for the views to draw as the thing being
  // photographed -- the outline of the stroke was the roof and the wall
  // together, and drawn as 24 dots it read as waypoints.
  const wall = [at(w.s0, 0), at(w.s1, 0)];
  return { pts, foot, top, datum, cols: nCol, rows: rows.length, dCol, dRow, frameW, frameH, facing, wall };
}
