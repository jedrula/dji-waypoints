// Reading a LAS/LAZ file far enough to get x, y, z and classification out.
//
// laz-perf does the hard part (the compression) and nothing else: it hands
// back raw point records and expects the caller to know the LAS header. So
// this parses the public header block itself, which is fixed-layout and small,
// and walks the points once.

import { createLazPerf } from 'laz-perf';
import { pl2000ToWgs84, toPuwg92 } from '../../js/puwg92.js';

let wasm = null;
const lazPerf = async () => (wasm ??= await createLazPerf());

// Byte offsets from the LAS 1.2-1.4 spec. The header grew over versions but
// everything here sits in the part all of them share.
export function readHeader(buf) {
  const h = rawHeader(buf);
  const toPuwg = pl2000Affine(h.bounds);
  if (!toPuwg) return h;
  const { e0, e1, n0, n1 } = h.bounds;
  const cs = [[e0, n0], [e1, n0], [e0, n1], [e1, n1]].map(([x, y]) => toPuwg(x, y));
  return {
    ...h,
    toPuwg,
    bounds: {
      e0: Math.min(...cs.map((c) => c[0])), e1: Math.max(...cs.map((c) => c[0])),
      n0: Math.min(...cs.map((c) => c[1])), n1: Math.max(...cs.map((c) => c[1])),
    },
  };
}

// The newer sheets (Wroclaw's 2025, 20 per m2) are flown in PL-2000, where an
// easting carries its zone: 6432800, not 362800. Everything downstream works
// in PUWG92, so those points are moved into it here, by an affine fitted to
// the sheet's corners -- the exact chain (inverse TM, then forward TM) per
// point is two projections times twenty million. Measured over a 1.2 km sheet
// at Wroclaw: worst error 2.5 mm against the exact chain, on an 11 x 11 grid.
// null for a PUWG92 sheet, which is left exactly as read.
function pl2000Affine({ e0, n0, e1, n1 }) {
  if (!(e0 >= 5e6)) return null;
  const f = (x, y) => {
    const g = pl2000ToWgs84(x, y);
    const p = toPuwg92(g.lat, g.lon);
    return [p.east, p.north];
  };
  const sx = Math.max(1, e1 - e0);
  const sy = Math.max(1, n1 - n0);
  const o = f(e0, n0);
  const ex = f(e0 + sx, n0);
  const ny = f(e0, n0 + sy);
  const a = (ex[0] - o[0]) / sx, b = (ex[1] - o[1]) / sx;
  const c = (ny[0] - o[0]) / sy, d = (ny[1] - o[1]) / sy;
  return (x, y) => [o[0] + (x - e0) * a + (y - n0) * c, o[1] + (x - e0) * b + (y - n0) * d];
}

function rawHeader(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (String.fromCharCode(...buf.subarray(0, 4)) !== 'LASF') throw new Error('not a LAS/LAZ file');
  const minor = buf[25];
  const legacy = dv.getUint32(107, true);
  return {
    version: `1.${minor}`,
    // The high bits of the format byte are the "is compressed" flag, and they
    // are set on every LAZ -- mask them off or the format reads as 131.
    format: buf[104] & 0b00111111,
    pointSize: dv.getUint16(105, true),
    count: minor >= 4 ? (Number(dv.getBigUint64(247, true)) || legacy) : legacy,
    scale: [dv.getFloat64(131, true), dv.getFloat64(139, true), dv.getFloat64(147, true)],
    offset: [dv.getFloat64(155, true), dv.getFloat64(163, true), dv.getFloat64(171, true)],
    bounds: {
      e0: dv.getFloat64(187, true), e1: dv.getFloat64(179, true),
      n0: dv.getFloat64(203, true), n1: dv.getFloat64(195, true),
    },
  };
}

// Point formats 0-5 keep classification in a bit-packed byte at 15, where only
// the low five bits are the class. Formats 6-10 gave it a byte of its own at
// 16 and moved everything after it along. Read the wrong one and every point
// comes back as class 0 or 1, which looks like an unclassified survey rather
// than a bug.
const classOffset = (format) => (format >= 6 ? 16 : 15);
const classMask = (format) => (format >= 6 ? 0xff : 0x1f);

// Where a format keeps its colour, or null for the formats that have none.
// 2 puts it straight after the 20-byte core; 3 and 5 after the GPS time; 7, 8
// and 10 after the 30-byte core of the 1.4 formats. Values are 16-bit, and
// most writers scale 8-bit colour up into them -- the caller looks at the
// largest it saw before deciding.
export const rgbOffset = (format) => ({ 2: 20, 3: 28, 5: 28, 7: 30, 8: 30, 10: 30 }[format] ?? null);

// Calls `visit(east, north, z, classification)` for every point -- and the
// colour as three more arguments when `rgb` is asked for and the format has
// it. One pass, no arrays built: a tile is six million points and the caller
// only ever wants them binned.
export async function forEachPoint(buf, visit, { rgb = false } = {}) {
  const h = readHeader(buf);
  // A PL-2000 sheet is moved into PUWG92 on the way past (readHeader).
  if (h.toPuwg) {
    const inner = visit;
    const t = h.toPuwg;
    visit = (x, y, ...rest) => { const p = t(x, y); inner(p[0], p[1], ...rest); };
  }
  // Plain LAS -- the 2019-2021 sheets are, and an older year now fills what
  // a newer one leaves (gugik.js) -- has no compression for laz-perf to undo:
  // the records sit at the header's offset to point data, back to back.
  if (!(buf[104] & 0x80)) return forEachRaw(buf, h, visit, rgb);
  const L = await lazPerf();
  const ptr = L._malloc(buf.length);
  const pointPtr = L._malloc(h.pointSize);
  const zip = new L.LASZip();
  try {
    L.HEAPU8.set(buf, ptr);
    zip.open(ptr, buf.length);
    const [sx, sy, sz] = h.scale;
    const [ox, oy, oz] = h.offset;
    const co = classOffset(h.format);
    const cm = classMask(h.format);
    const ro = rgb ? rgbOffset(h.format) : null;
    // The decompressor allocates as it goes, and when the WASM heap grows the
    // old ArrayBuffer is DETACHED -- every DataView onto it throws from that
    // point on. Whether it happens depends on how much headroom the heap had,
    // so a cached view survives one file and dies on the third, which is the
    // worst possible schedule for finding out. Re-derive on the identity
    // change, which costs one reference comparison per point.
    let heap = L.HEAPU8.buffer;
    let view = new DataView(heap, pointPtr, h.pointSize);
    for (let i = 0; i < h.count; i++) {
      zip.getPoint(pointPtr);
      if (L.HEAPU8.buffer !== heap) {
        heap = L.HEAPU8.buffer;
        view = new DataView(heap, pointPtr, h.pointSize);
      }
      if (ro === null) {
        visit(
          view.getInt32(0, true) * sx + ox,
          view.getInt32(4, true) * sy + oy,
          view.getInt32(8, true) * sz + oz,
          view.getUint8(co) & cm,
        );
      } else {
        visit(
          view.getInt32(0, true) * sx + ox,
          view.getInt32(4, true) * sy + oy,
          view.getInt32(8, true) * sz + oz,
          view.getUint8(co) & cm,
          view.getUint16(ro, true), view.getUint16(ro + 2, true), view.getUint16(ro + 4, true),
        );
      }
    }
  } finally {
    zip.delete?.();
    L._free(pointPtr);
    L._free(ptr);
  }
  return h;
}

function forEachRaw(buf, h, visit, rgb) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const start = dv.getUint32(96, true);
  const [sx, sy, sz] = h.scale;
  const [ox, oy, oz] = h.offset;
  const co = classOffset(h.format);
  const cm = classMask(h.format);
  const ro = rgb ? rgbOffset(h.format) : null;
  const n = Math.min(h.count, Math.floor((buf.length - start) / h.pointSize));
  for (let i = 0, o = start; i < n; i++, o += h.pointSize) {
    const x = dv.getInt32(o, true) * sx + ox;
    const y = dv.getInt32(o + 4, true) * sy + oy;
    const z = dv.getInt32(o + 8, true) * sz + oz;
    const k = buf[o + co] & cm;
    if (ro === null) visit(x, y, z, k);
    else visit(x, y, z, k, dv.getUint16(o + ro, true), dv.getUint16(o + ro + 2, true), dv.getUint16(o + ro + 4, true));
  }
  return h;
}

// ASPRS classes this service cares about.
export const CLASS = {
  ground: 2,
  lowVeg: 3, medVeg: 4, highVeg: 5,
  building: 6,
  noise: 7,
  water: 9,
};
