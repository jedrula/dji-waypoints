// Reading a LAS/LAZ file far enough to get x, y, z and classification out.
//
// laz-perf does the hard part (the compression) and nothing else: it hands
// back raw point records and expects the caller to know the LAS header. So
// this parses the public header block itself, which is fixed-layout and small,
// and walks the points once.

import { createLazPerf } from 'laz-perf';

let wasm = null;
const lazPerf = async () => (wasm ??= await createLazPerf());

// Byte offsets from the LAS 1.2-1.4 spec. The header grew over versions but
// everything here sits in the part all of them share.
export function readHeader(buf) {
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

// Calls `visit(east, north, z, classification)` for every point. One pass, no
// arrays built -- a tile is six million points and the caller only ever wants
// them binned.
export async function forEachPoint(buf, visit) {
  const L = await lazPerf();
  const h = readHeader(buf);
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
      visit(
        view.getInt32(0, true) * sx + ox,
        view.getInt32(4, true) * sy + oy,
        view.getInt32(8, true) * sz + oz,
        view.getUint8(co) & cm,
      );
    }
  } finally {
    zip.delete?.();
    L._free(pointPtr);
    L._free(ptr);
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
