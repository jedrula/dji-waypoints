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
// So this hands back the points inside a disc, thinned to a budget, packed
// small:
//
//   int16 x, int16 y   centimetres east / north of the disc's centre
//   uint16 z           centimetres above the lowest point kept
//   uint8 r, g, b      colour, 8-bit; mid-grey where the survey has none
//   uint8 class        ASPRS classification
//
// Ten bytes a point. A 150 m disc at 12 points per m2 is 850k points; the
// default budget of 1.2 million keeps all of them, at 12 MB before gzip.

export const MAX_RADIUS_M = 300;   // int16 centimetres reach 327 m
const NOISE = new Set([7, 18]);    // low and high noise: never worth drawing

export function createPointSet({ e, n, r, keep = 1, seed = 1 }) {
  const rr = Math.min(r, MAX_RADIUS_M);
  const r2 = rr * rr;
  // A fixed sequence, not Math.random: the same request thins to the same
  // points, which is what lets the result be cached and still be "the" answer.
  let state = seed >>> 0 || 1;
  const rand = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
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
      if (keep < 1 && rand() >= keep) return;
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
      const count = xs.length;
      let zMin = Infinity;
      for (const z of zs) if (z < zMin) zMin = z;
      // 16-bit colour that never exceeds 255 was written 8-bit and is read
      // as-is; anything above is the usual scaled-up 16-bit, shifted down.
      const shift = maxColour > 255 ? 8 : 0;
      const buf = Buffer.alloc(count * 10);
      for (let i = 0; i < count; i++) {
        const o = i * 10;
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
        meta: { count, e, n, r: rr, zBase: count ? zMin : 0, hasRgb, keep, bytesPerPoint: 10 },
      };
    },
  };
}

// What fraction to keep for a budget, from the sheets' own headers: each one
// knows its point count and extent, so the density inside the disc is known
// before a single point is decompressed. Each sheet is charged for the part of
// the disc's square it overlaps, times pi/4 for the disc inside the square.
// The first cut charged every sheet for the whole disc, and over Kadzielnia --
// a disc straddling two sheets -- kept 39% where the budget allowed most.
export function keepFor(headers, { e, n, r, maxPoints }) {
  let expected = 0;
  for (const h of headers) {
    const b = h.bounds;
    const area = Math.max(1, (b.e1 - b.e0) * (b.n1 - b.n0));
    const ow = Math.max(0, Math.min(b.e1, e + r) - Math.max(b.e0, e - r));
    const oh = Math.max(0, Math.min(b.n1, n + r) - Math.max(b.n0, n - r));
    expected += (h.count / area) * ow * oh * (Math.PI / 4);
  }
  return expected > maxPoints ? maxPoints / expected : 1;
}
