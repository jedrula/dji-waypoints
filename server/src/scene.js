// A rough 3D model of a place, from the two things Poland gives away.
//
// The height service answers "how tall is that", which is a number. This
// answers "what does it look like", which is a surface: the LiDAR for shape
// and the national orthophoto for colour. It is deliberately a WORSE model
// than the one you are going to fly for -- that is the point of it. It is the
// init. It gets the massing, the roof heights, the tree canopy and the ground
// right to within a metre, from data that is already on disk, and it is honest
// about the one thing it cannot know.
//
// What it cannot know is walls. Every return here was measured from an
// aircraft looking down, so roofs and ground are seen and vertical surfaces
// are not. A 2.5D surface renders those as smears. Rather than dress that up,
// the grid marks them, and the viewer draws them as blank faces -- which is a
// picture of exactly what the drone is being sent to collect.

import { forEachPoint, CLASS } from './laz.js';
import { TILE_M } from './ndsm.js';

export const CELL_M = 0.5;                  // finer than the height tiles: roof edges matter here
export const GRID = TILE_M / CELL_M;        // 1000 x 1000

// What the highest return in a cell was, which is what you would see looking
// down at it. Kept deliberately small -- the viewer colours by these.
export const KIND = { none: 0, ground: 1, building: 2, vegetation: 3, water: 4 };

const kindOf = (klass) => {
  if (klass === CLASS.building) return KIND.building;
  if (klass === CLASS.highVeg || klass === CLASS.medVeg || klass === CLASS.lowVeg) return KIND.vegetation;
  if (klass === CLASS.water) return KIND.water;
  if (klass === CLASS.ground) return KIND.ground;
  return KIND.none;
};

export function createScene(te, tn) {
  const e0 = te * TILE_M;
  const n0 = tn * TILE_M;
  const top = new Float32Array(GRID * GRID).fill(-Infinity);
  const kind = new Uint8Array(GRID * GRID);
  let lowest = Infinity;
  let highest = -Infinity;
  let kept = 0;

  const addPoint = (east, north, z, klass) => {
    if (klass === CLASS.noise) return;
    const dx = east - e0;
    const dy = north - n0;
    if (dx < 0 || dy < 0 || dx >= TILE_M || dy >= TILE_M) return;
    const col = Math.min(GRID - 1, Math.floor(dx / CELL_M));
    const row = Math.min(GRID - 1, Math.floor((TILE_M - dy) / CELL_M));
    const i = row * GRID + col;
    if (z <= top[i]) return;
    top[i] = z;
    kind[i] = kindOf(klass);
    kept++;
    if (z < lowest) lowest = z;
    if (z > highest) highest = z;
  };

  return {
    addPoint,
    add: (buf) => forEachPoint(buf, addPoint),

    finish() {
      if (!kept) return null;
      // Water returns almost nothing, so the river arrives as a hole. Left
      // unfilled it becomes a canyon; filled from its rim it becomes a flat
      // sheet at about the right level, which is what a river is. Cells filled
      // this way keep KIND.none so the viewer can say it is guessing.
      const filled = fill(top, kind, lowest);

      // Heights as centimetres above the tile's lowest point. uint16 covers
      // 655 m of relief, which is more than anywhere in Poland has.
      const base = lowest;
      const height = new Uint16Array(GRID * GRID);
      for (let i = 0; i < height.length; i++) {
        height[i] = Math.max(0, Math.min(65535, Math.round((filled[i] - base) * 100)));
      }
      const counts = {};
      for (const k of kind) counts[k] = (counts[k] || 0) + 1;
      return {
        height,
        kind,
        stats: {
          base: +base.toFixed(2),
          relief: +(highest - lowest).toFixed(2),
          measured: kept,
          filledCells: filled.holes,
          kinds: {
            ground: counts[KIND.ground] || 0,
            building: counts[KIND.building] || 0,
            vegetation: counts[KIND.vegetation] || 0,
            water: counts[KIND.water] || 0,
            guessed: counts[KIND.none] || 0,
          },
        },
      };
    },
  };
}

// Spread inwards from the rim of each hole until it is closed. Cheap, and for
// water -- which is flat -- it is very nearly right.
function fill(src, kind, fallback) {
  const g = Float32Array.from(src);
  let holes = 0;
  for (let pass = 0; pass < 64; pass++) {
    let left = 0;
    const next = Float32Array.from(g);
    for (let r = 0; r < GRID; r++) {
      for (let c = 0; c < GRID; c++) {
        const i = r * GRID + c;
        if (g[i] !== -Infinity) continue;
        let sum = 0, n = 0;
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            const rr = r + dr, cc = c + dc;
            if (rr < 0 || cc < 0 || rr >= GRID || cc >= GRID) continue;
            const v = g[rr * GRID + cc];
            if (v !== -Infinity) { sum += v; n++; }
          }
        }
        if (n) next[i] = sum / n; else left++;
      }
    }
    g.set(next);
    if (!left) break;
  }
  for (let i = 0; i < g.length; i++) {
    if (g[i] === -Infinity) { g[i] = fallback; holes++; }
    else if (src[i] === -Infinity) holes++;
  }
  // Diffusion closes a hole but leaves a slope across it, and the biggest
  // holes are the river, which is flat. Smooth only the cells that were
  // invented, so measured ground keeps every centimetre it earned.
  const invented = (i) => src[i] === -Infinity;
  for (let pass = 0; pass < 12; pass++) {
    const next = Float32Array.from(g);
    for (let r = 1; r < GRID - 1; r++) {
      for (let c = 1; c < GRID - 1; c++) {
        const i = r * GRID + c;
        if (!invented(i)) continue;
        next[i] = (g[i - 1] + g[i + 1] + g[i - GRID] + g[i + GRID]) * 0.25;
      }
    }
    g.set(next);
  }
  g.holes = holes;
  return g;
}
