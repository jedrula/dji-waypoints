// Reading a survey tile: which cell a coordinate falls in, and how high the
// ground is there.
//
// Not in js/scene3d.js with the rest of the surface work, because this is the
// part that has to be RIGHT and that file cannot be tested -- it imports
// three.js from a bare specifier, which needs a browser and an import map.
// Everything here is arithmetic over a typed array, so it runs under node and
// has tests.
//
// Two datums meet in this file and getting them the wrong way round is how a
// flight ends up drawn ten metres under a roof:
//
//   the tile   heights are CENTIMETRES above the tile's own lowest point,
//              `meta.base` metres above sea level (see server/src/scene.js)
//   the app    every altitude is METRES above the takeoff point
//
// So nothing is converted to sea level at all. The surface is sampled at the
// mission's home point, and that reading becomes the zero everything else is
// measured from.

import { toPuwg92, toWgs84 } from './puwg92.js';

// Row 0 is the tile's NORTH edge, so north and row run opposite ways. Getting
// this backwards mirrors the whole tile, which looks plausible and is not.
export function cellAt(meta, lat, lon) {
  const { east, north } = toPuwg92(lat, lon);
  return {
    col: Math.round((east - meta.origin.east) / meta.cellMetres),
    row: Math.round((meta.origin.north + meta.tileMetres - north) / meta.cellMetres),
  };
}

export const onTile = (meta, { row, col }) =>
  row >= 0 && col >= 0 && row < meta.grid && col < meta.grid;

// Metres above sea level, or null off the tile -- which is not the same as zero
// and must never be read as ground.
export function groundAt(meta, height, lat, lon) {
  const cell = cellAt(meta, lat, lon);
  if (!onTile(meta, cell)) return null;
  return meta.base + height[cell.row * meta.grid + cell.col] / 100;
}

// PUWG92 metres to the mission's own local metres, as an affine map.
//
// Doing it properly per vertex means an inverse projection each time, and there
// are hundreds of thousands of vertices in a surface. Both frames are metric,
// so the map is derived once from three points and is then two multiplies and
// an add.
//
// Measured worst case over a whole 500 m tile: 51 mm. That is a twentieth of
// one cell, and it is the projection's own scale distortion over that distance
// rather than an error that could be tuned away. I had written "far under a
// centimetre" here before measuring it, which was wrong by a factor of five.
export function puwgToLocal(frame, e0, n0) {
  const at = (e, n) => {
    const g = toWgs84(e, n);
    return frame.toLocal(g.lat, g.lon);
  };
  const o = at(e0, n0);
  const de = at(e0 + 100, n0);
  const dn = at(e0, n0 + 100);
  const ex = (de.x - o.x) / 100;
  const ey = (de.y - o.y) / 100;
  const nx = (dn.x - o.x) / 100;
  const ny = (dn.y - o.y) / 100;
  return (e, n) => ({
    x: o.x + (e - e0) * ex + (n - n0) * nx,
    y: o.y + (e - e0) * ey + (n - n0) * ny,
  });
}

// A wire hangs at the height its voltage implies ABOVE THE GROUND UNDER IT, not
// above the takeoff point -- so every vertex is lifted by the surface it
// crosses. Drawn at one altitude the whole run sinks into the first rise it
// meets. Vertices off the tile are dropped rather than guessed: there is no
// ground there to hang them over.
export function drapeWire(meta, height, frame, datum, wire) {
  const out = [];
  for (const q of wire.path) {
    const ground = groundAt(meta, height, q.lat, q.lon);
    if (ground === null) continue;
    const l = frame.toLocal(q.lat, q.lon);
    out.push({ x: l.x, y: ground - datum + wire.height, z: -l.y });
  }
  return out;
}
