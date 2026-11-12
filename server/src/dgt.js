// Portugal's LiDAR: DGT's 2024 survey of the mainland, as 50 cm rasters.
//
// What Poland's LiDAR gives this app -- the buildings, the trees and the
// ground under them -- DGT publishes ready-made: an MDS (surface: roofs,
// canopy, cliff tops) and an MDT (bare earth) for every 1 km tile, 2000 x 2000
// float32 cells in PT-TM06 (EPSG:3763), open data, free account to download.
// Over Alvor on 2026-11-12, surface minus ground put the beachfront hotel
// towers at up to 47 m and 9.6% of the tile above 2 m -- trees and villas --
// and the two lined up with the satellite photograph.
//
// The tiles are files on disk in DATA_DIR/dgt, named as DGT names them
// (MDS-50cm-160018-04-2024_v01.tif). Fetching them is a separate job: DGT's
// downloads need a signed-in session, so the first ones were pulled through a
// browser. Nothing here asks DGT for anything.
//
// The tile id is the grid: 160018 is column 160, row 018, and the tile covers
//   east  (col - 200) * 1000 .. + 1000
//   north (row - 301) * 1000 .. + 1000
// checked against two tiles' own GeoTIFF origins: 159018 is (-41000, -282000)
// at its north-west corner, and 160017 lies south of 160018.

import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fromFile } from 'geotiff';

export const DGT_CELL = 1;          // what is served; the rasters are 0.5 m
export const DGT_MAX_SIDE = 2000;   // metres; 2000 x 2000 x 2 products x 2 bytes = 16 MB
const TILE = 1000;
const SRC = 0.5;
const NODATA = -32768;

// A PT-TM06 box, snapped OUTWARD to whole metres; null if it is not one this
// will serve.
export function dgtBox({ e0, n0, e1, n1 }) {
  if (![e0, n0, e1, n1].every(Number.isFinite)) return null;
  const box = { e0: Math.floor(e0), n0: Math.floor(n0), e1: Math.ceil(e1), n1: Math.ceil(n1) };
  if (box.e1 <= box.e0 || box.n1 <= box.n0) return null;
  if (box.e1 - box.e0 > DGT_MAX_SIDE || box.n1 - box.n0 > DGT_MAX_SIDE) return null;
  return box;
}

export const tileId = (e, n) => {
  const col = Math.floor(e / TILE) + 200;
  const row = Math.floor(n / TILE) + 301;
  return `${String(col).padStart(3, '0')}${String(row).padStart(3, '0')}`;
};

// `load(kind, id)` -> { z, w, h, ox, oy } or null; the files by default, an
// in-memory raster in server/test/run.mjs (a 2000 x 2000 float GeoTIFF is
// not something to keep as a fixture).
export function createDgtStore({ dir, load = null }) {
  // Decoded rasters, few at a time: one is 16 MB, and a site spans four.
  const cache = new Map();
  const KEEP = 8;
  let names = null;

  async function fileFor(kind, id) {
    names ??= await readdir(dir).catch(() => []);
    // The newest version when DGT has reissued a tile (_v01, _v02 ...).
    const hits = names.filter((f) => f.startsWith(`${kind}-50cm-${id}-`) && f.endsWith('.tif')).sort();
    return hits.length ? path.join(dir, hits[hits.length - 1]) : null;
  }

  async function raster(kind, id) {
    const key = `${kind}/${id}`;
    if (cache.has(key)) {
      const v = cache.get(key);
      cache.delete(key); cache.set(key, v);
      return v;
    }
    let v = null;
    const file = load ? null : await fileFor(kind, id);
    if (load) v = await load(kind, id);
    else if (file) {
      const im = await (await fromFile(file)).getImage();
      const [z] = await im.readRasters();
      const [ox, oy] = im.getOrigin();
      v = { z, w: im.getWidth(), h: im.getHeight(), ox, oy, nodata: im.getGDALNoData() };
    }
    cache.set(key, v);
    while (cache.size > KEEP) cache.delete(cache.keys().next().value);
    return v;
  }

  // The box at 1 m, both products, as decimetres in Int16 (+-3276 m, which
  // covers mainland Portugal's 1993 m top). Each 1 m cell is FOUR 0.5 m cells,
  // and the two products are pooled in opposite directions, each the safe
  // one: the surface takes the HIGHEST of the four, rounded up -- a chimney
  // narrower than a metre must not vanish -- and the ground the LOWEST,
  // rounded down, because the ground under the takeoff is what every altitude
  // is added to, and reading it high puts the aircraft lower than it thinks.
  //
  // Nodata (DGT's -3.4e38) inside a tile is the sea: the two products share
  // the mask exactly (339,512 cells each in tile 159018), and it follows the
  // coastline. Sea level, then -- 0. A tile that is not on disk is NOT the sea:
  // its cells stay NODATA, and the browser reads them as unknown.
  async function grid(box) {
    const cols = (box.e1 - box.e0) / DGT_CELL;
    const rows = (box.n1 - box.n0) / DGT_CELL;
    const surface = new Int16Array(cols * rows).fill(NODATA);
    const ground = new Int16Array(cols * rows).fill(NODATA);
    const ids = new Set();
    for (let e = Math.floor(box.e0 / TILE) * TILE; e < box.e1; e += TILE) {
      for (let n = Math.floor(box.n0 / TILE) * TILE; n < box.n1; n += TILE) ids.add(tileId(e, n));
    }
    let found = 0;
    for (const id of ids) {
      const [s, t] = await Promise.all([raster('MDS', id), raster('MDT', id)]);
      if (!s || !t) continue;
      found++;
      for (let r = 0; r < rows; r++) {
        // Row 0 is the north edge, here and in the rasters.
        const nTop = box.n1 - r * DGT_CELL;
        const sr = Math.round((s.oy - nTop) / SRC);
        if (sr < 0 || sr + 1 >= s.h) continue;
        for (let c = 0; c < cols; c++) {
          const eLeft = box.e0 + c * DGT_CELL;
          const sc = Math.round((eLeft - s.ox) / SRC);
          if (sc < 0 || sc + 1 >= s.w) continue;
          let hi = -Infinity;
          let lo = Infinity;
          let sea = 0;
          for (const [dr, dc] of [[0, 0], [0, 1], [1, 0], [1, 1]]) {
            const i = (sr + dr) * s.w + sc + dc;
            const a = s.z[i];
            const b = t.z[i];
            if (!(a > -1000) || !(b > -1000)) { sea++; continue; }
            if (a > hi) hi = a;
            if (b < lo) lo = b;
          }
          const o = r * cols + c;
          if (sea === 4) { surface[o] = 0; ground[o] = 0; continue; }
          // Part sea, part land: the land is what is there.
          surface[o] = Math.min(32767, Math.ceil(Math.max(hi, 0) * 10));
          ground[o] = Math.max(-32767, Math.floor(Math.min(lo, hi) * 10));
        }
      }
    }
    return { cols, rows, e0: box.e0, n0: box.n0, cell: DGT_CELL, tiles: ids.size, found, surface, ground };
  }

  return { grid };
}

// The wire format: a 4-byte little-endian header length, the JSON header,
// padding to an even byte, then surface and ground as Int16 decimetres.
export function encodeGrid(g) {
  const head = Buffer.from(JSON.stringify({
    cols: g.cols, rows: g.rows, e0: g.e0, n0: g.n0, cell: g.cell, tiles: g.tiles, found: g.found,
    nodata: NODATA, unit: 'dm', crs: 'EPSG:3763',
  }));
  const pad = (4 + head.length) % 2;
  const out = Buffer.alloc(4 + head.length + pad + g.surface.byteLength + g.ground.byteLength);
  out.writeUInt32LE(head.length, 0);
  head.copy(out, 4);
  let at = 4 + head.length + pad;
  Buffer.from(g.surface.buffer, g.surface.byteOffset, g.surface.byteLength).copy(out, at);
  at += g.surface.byteLength;
  Buffer.from(g.ground.buffer, g.ground.byteOffset, g.ground.byteLength).copy(out, at);
  return out;
}
