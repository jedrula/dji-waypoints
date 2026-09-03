// Turning a point cloud into the one number the planner needs: how far above
// the ground the tallest thing in each square metre stands.
//
// The whole point of the exercise is size. The LAZ tiles feeding one of these
// are tens of megabytes each; what comes out is 250 kB, and around 30 kB once
// the HTTP layer gzips it -- because a height field is mostly flat, mostly
// zero, and compresses like it. That is the difference between data you can
// only process on a server and data a phone can hold.

import { forEachPoint, CLASS } from './laz.js';

export const TILE_M = 500;   // tile edge, metres. A drone site fits in one or two.
export const CELL_M = 1;     // output resolution
export const SIZE = TILE_M / CELL_M;
export const GROUND_M = 10;  // ground is modelled coarser than the surface -- see below
const GSIZE = TILE_M / GROUND_M;

// One byte per cell. Metres, rounded UP, because this is used to decide how
// high to fly: rounding a 24.6 m building down to 24 spends the margin the
// clearance setting was supposed to provide.
export const NO_DATA = 255;
export const MAX_H = 254;

// Tile addresses are PUWG92 kilometre-and-a-half grid indices, so a URL is
// stable forever and two clients asking about the same field get the same
// bytes out of the same cache entry.
export const tileOf = (east, north) => ({
  te: Math.floor(east / TILE_M),
  tn: Math.floor(north / TILE_M),
});
export const originOf = (te, tn) => ({ e0: te * TILE_M, n0: tn * TILE_M });

export function createTile(te, tn) {
  const { e0, n0 } = originOf(te, tn);
  // Surface: the highest return in each cell, whatever it came off.
  const dsm = new Float32Array(SIZE * SIZE).fill(-Infinity);
  // Ground: the lowest ground-classified return in each coarse cell. Coarse
  // because ground returns are sparse under canopy and inside courtyards --
  // at 1 m most cells would be empty and every height measured against them
  // would be missing. At 10 m the gaps are rare enough to interpolate across,
  // and real terrain does not do anything interesting in 10 m anyway.
  const gnd = new Float32Array(GSIZE * GSIZE).fill(Infinity);
  let points = 0, kept = 0;
  let lowest = Infinity;
  const seen = new Map();   // classification -> count, for the report

  return {
    te, tn, e0, n0,

    // One point. The LAZ reader drives this six million times a tile, and a
    // test drives it a hundred times with numbers it can reason about.
    addPoint(east, north, z, klass) {
      points++;
      if (klass === CLASS.noise) return;
      const dx = east - e0;
      const dy = north - n0;
      if (dx < 0 || dy < 0 || dx >= TILE_M || dy >= TILE_M) return;
      kept++;
      seen.set(klass, (seen.get(klass) || 0) + 1);
      if (z < lowest) lowest = z;
      // Row 0 is the NORTH edge, so the buffer reads like an image: the
      // client draws it straight onto a canvas without flipping anything.
      const col = Math.min(SIZE - 1, Math.floor(dx / CELL_M));
      const row = Math.min(SIZE - 1, Math.floor((TILE_M - dy) / CELL_M));
      const i = row * SIZE + col;
      if (z > dsm[i]) dsm[i] = z;
      if (klass === CLASS.ground) {
        const gi = Math.min(GSIZE - 1, Math.floor((TILE_M - dy) / GROUND_M)) * GSIZE
          + Math.min(GSIZE - 1, Math.floor(dx / GROUND_M));
        if (z < gnd[gi]) gnd[gi] = z;
      }
    },

    async add(buf) {
      return forEachPoint(buf, this.addPoint);
    },

    finish() {
      if (!kept) return null;
      const ground = fillGaps(gnd, GSIZE, Number.isFinite(lowest) ? lowest : 0);
      const out = new Uint8Array(SIZE * SIZE).fill(NO_DATA);
      let max = 0;
      for (let row = 0; row < SIZE; row++) {
        for (let col = 0; col < SIZE; col++) {
          const i = row * SIZE + col;
          const top = dsm[i];
          if (top === -Infinity) continue;
          const h = top - sampleGround(ground, GSIZE, col, row);
          const v = Math.min(MAX_H, Math.max(0, Math.ceil(h)));
          out[i] = v;
          if (v > max) max = v;
        }
      }
      const filled = out.reduce((n, v) => n + (v !== NO_DATA ? 1 : 0), 0);
      return {
        data: out,
        stats: {
          points, kept, maxHeight: max,
          coverage: +(filled / out.length).toFixed(3),
          classes: Object.fromEntries([...seen].sort((a, b) => b[1] - a[1])),
        },
      };
    },
  };
}

// Ground cells with no ground return borrow from their neighbours, spreading
// inwards a ring at a time until the grid is full. Anything still unreached --
// a tile that is all roof -- falls back to the lowest point seen, which is
// wrong by however much the terrain slopes but is never wrong in the dangerous
// direction: it makes objects look taller, not shorter.
function fillGaps(src, n, fallback) {
  const g = Float32Array.from(src);
  const has = (v) => v !== Infinity;
  for (let pass = 0; pass < n; pass++) {
    let holes = 0;
    const next = Float32Array.from(g);
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const i = r * n + c;
        if (has(g[i])) continue;
        let sum = 0, cnt = 0;
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            const rr = r + dr, cc = c + dc;
            if (rr < 0 || cc < 0 || rr >= n || cc >= n) continue;
            const v = g[rr * n + cc];
            if (has(v)) { sum += v; cnt++; }
          }
        }
        if (cnt) next[i] = sum / cnt; else holes++;
      }
    }
    g.set(next);
    if (!holes) break;
  }
  for (let i = 0; i < g.length; i++) if (!has(g[i])) g[i] = fallback;
  return g;
}

// Bilinear, so a slope does not come out as 10 m terraces.
function sampleGround(g, n, col, row) {
  const gx = (col * CELL_M) / GROUND_M - 0.5;
  const gy = (row * CELL_M) / GROUND_M - 0.5;
  const x0 = Math.max(0, Math.min(n - 1, Math.floor(gx)));
  const y0 = Math.max(0, Math.min(n - 1, Math.floor(gy)));
  const x1 = Math.min(n - 1, x0 + 1);
  const y1 = Math.min(n - 1, y0 + 1);
  const fx = Math.max(0, Math.min(1, gx - x0));
  const fy = Math.max(0, Math.min(1, gy - y0));
  const a = g[y0 * n + x0], b = g[y0 * n + x1];
  const c = g[y1 * n + x0], d = g[y1 * n + x1];
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}
