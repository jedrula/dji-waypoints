// The survey as points, for looking at.
//
// Everything else the service makes from the LiDAR is a raster: one height per
// half-metre cell, the top of whatever was there. That is the right shape for
// "how tall is this" and the wrong one for looking at a quarry, because a
// vertical face has no cells of its own -- the app's 3D view draws a rock wall
// as a photograph stretched down a cliff of triangles, and a tree as a spike.
// The points themselves do not have that problem: an airborne scanner sweeps
// off-nadir, so a wall facing the flight line gets returns ON it, and the
// 2025 Kielce sheets carry colour per point. Measured over Kadzielnia: 12
// points per square metre, RGB in every record (point format 3).
//
// So this hands back the points inside a disc, one per voxel and then to a
// budget, packed small:
//
//   int16 x, int16 y   centimetres east / north of the disc's centre
//   uint16 z           centimetres above the lowest point kept
//   uint8 r, g, b      colour, 8-bit; mid-grey where the survey has none
//   uint8 class        ASPRS classification
//
// Ten bytes a point: 2M, the service's budget, is 20 MB before gzip.

export const MAX_RADIUS_M = 300;   // int16 centimetres reach 327 m
const NOISE = new Set([7, 18]);    // low and high noise: never worth drawing

export function createPointSet({ e, n, r, voxel = 0, maxPoints = Infinity, seed = 1 }) {
  const rr = Math.min(r, MAX_RADIUS_M);
  const r2 = rr * rr;
  // A fixed sequence, not Math.random: the same request thins to the same
  // points, which is what lets the result be cached and still be "the" answer.
  let state = seed >>> 0 || 1;
  const rand = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
  // One point per voxel, the first to arrive. This was a coin toss per point
  // at the budget's rate, and over Wroclaw's 2025 sheets (20 per m2, flown in
  // overlapping strips) it kept one in four: the doubled strips stayed doubled
  // and the single ones went patchy. A voxel keeps what a surface has and
  // drops only what repeats it. Keys stay exact integers: x and y are under
  // 2400 cells of 0.25 m across the 600 m disc, and even Rysy's 2499 m makes
  // the key ~1.7e11, far below 2^53.
  const seen = voxel > 0 ? new Set() : null;
  const xs = [];
  const ys = [];
  const zs = [];
  const cols = [];
  const cls = [];
  let maxColour = 0;
  let hasRgb = false;

  return {
    addPoint(pe, pn, z, klass, red, green, blue) {
      if (NOISE.has(klass)) return;
      const dx = pe - e;
      const dy = pn - n;
      if (dx * dx + dy * dy > r2) return;
      if (seen) {
        const ix = Math.floor((dx + MAX_RADIUS_M) / voxel);
        const iy = Math.floor((dy + MAX_RADIUS_M) / voxel);
        const iz = Math.floor(Math.max(0, z + 100) / voxel);
        const key = (iz * 4096 + iy) * 4096 + ix;
        if (seen.has(key)) return;
        seen.add(key);
      }
      xs.push(dx); ys.push(dy); zs.push(z); cls.push(klass);
      if (red !== undefined) {
        hasRgb = true;
        cols.push(red, green, blue);
        if (red > maxColour) maxColour = red;
        if (green > maxColour) maxColour = green;
        if (blue > maxColour) maxColour = blue;
      }
    },

    finish() {
      // Still over budget after the voxels: thinned evenly, deterministically.
      const keep = xs.length > maxPoints ? maxPoints / xs.length : 1;
      const pick = [];
      for (let i = 0; i < xs.length; i++) if (keep >= 1 || rand() < keep) pick.push(i);
      const count = pick.length;
      let zMin = Infinity;
      for (const i of pick) if (zs[i] < zMin) zMin = zs[i];
      // 16-bit colour that never exceeds 255 was written 8-bit and is read
      // as-is; anything above is the usual scaled-up 16-bit, shifted down.
      const shift = maxColour > 255 ? 8 : 0;
      const buf = Buffer.alloc(count * 10);
      for (let j = 0; j < count; j++) {
        const i = pick[j];
        const o = j * 10;
        buf.writeInt16LE(Math.round(xs[i] * 100), o);
        buf.writeInt16LE(Math.round(ys[i] * 100), o + 2);
        buf.writeUInt16LE(Math.min(65535, Math.round((zs[i] - zMin) * 100)), o + 4);
        if (hasRgb) {
          buf[o + 6] = cols[i * 3] >> shift;
          buf[o + 7] = cols[i * 3 + 1] >> shift;
          buf[o + 8] = cols[i * 3 + 2] >> shift;
        } else {
          buf[o + 6] = buf[o + 7] = buf[o + 8] = 150;
        }
        buf[o + 9] = cls[i];
      }
      return {
        body: buf,
        meta: { count, e, n, r: rr, zBase: count ? zMin : 0, hasRgb, voxel, keep, bytesPerPoint: 10 },
      };
    },
  };
}
