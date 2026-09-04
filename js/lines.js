// Overhead lines as obstacles.
//
// These are the ones that matter. A building is visible from the air and a
// tree is obvious from the ground; a conductor strung across a field is
// neither, and it is what brings an aircraft down. OpenStreetMap has the
// transmission towers and very little of the distribution -- the 400 V run to
// a farm is exactly the wire nobody maps and exactly the one you fly into.
//
// BDOT10k has all of it, nationally, with a voltage class. It arrives through
// the heights service (see server/src/bdot.js) because resolving a coordinate
// to a powiat package and pulling one entry out of a 20 MB zip is not work for
// a phone. What comes back is where the wire runs; how high it hangs is still
// the assumption its voltage implies.

import { toPuwg92, toWgs84, inPoland } from './puwg92.js';
import { spanBoxes, LINE_SPAN } from './osm.js';
import { serviceUrl } from './heights.js';

export const SOURCE = 'bdot';

// Tile geometry is the service's to define; asking keeps the two in step.
let grid = null;
async function tileGrid(fetchImpl) {
  if (grid) return grid;
  const res = await fetchImpl(`${serviceUrl()}/v1/health`);
  if (!res.ok) throw new Error(`heights service answered ${res.status}`);
  const h = await res.json();
  grid = { tileMetres: h.tileMetres };
  return grid;
}

// Which tiles a lat/lon box touches.
export function tilesFor(bounds, tileMetres) {
  const sw = toPuwg92(bounds.south, bounds.west);
  const ne = toPuwg92(bounds.north, bounds.east);
  const out = [];
  for (let tn = Math.floor(sw.north / tileMetres); tn <= Math.floor(ne.north / tileMetres); tn++) {
    for (let te = Math.floor(sw.east / tileMetres); te <= Math.floor(ne.east / tileMetres); te++) {
      out.push([tn, te]);
    }
  }
  return out;
}

// One line's tile-local metres become the boxes the collision check works in.
// The chopping is osm.js's, deliberately: a diagonal span cut into one box
// would wall off a square the length of the span, and that rule should exist
// once however many importers need it.
export function lineToObstacles(line, { tn, te, tileMetres }) {
  const e0 = te * tileMetres;
  const n0 = tn * tileMetres;
  const geometry = line.points.map(([x, y]) => toWgs84(e0 + x, n0 + y));
  if (geometry.length < 2) return [];
  return spanBoxes(geometry, LINE_SPAN).map((rect) => ({
    ...rect,
    height: line.height,
    label: line.label,
    // Always an estimate. BDOT10k says where the wire is and what it carries,
    // never how far off the ground it hangs, and the sag between two poles is
    // metres. The number errs high, which is the only safe direction.
    assumed: true,
    source: SOURCE,
  }));
}

// Everything overhead in the view, ready for site.addImported. Silent when the
// service is absent: the app planned flights before this existed and has to go
// on doing it when the service is down.
export async function fetchLines(bounds, { fetchImpl = globalThis.fetch, signal, onProgress } = {}) {
  const url = serviceUrl();
  if (!url) return { obstacles: [], lines: 0, reason: 'no service' };
  if (!inPoland((bounds.north + bounds.south) / 2, (bounds.east + bounds.west) / 2)) {
    return { obstacles: [], paths: [], lines: 0, reason: 'outside Poland' };
  }

  let g;
  try {
    g = await tileGrid(fetchImpl);
  } catch (e) {
    return { obstacles: [], paths: [], lines: 0, reason: e.message };
  }

  const tiles = tilesFor(bounds, g.tileMetres);
  const obstacles = [];
  const paths = [];
  let lines = 0;
  let done = 0;
  for (const [tn, te] of tiles) {
    let body;
    try {
      const res = await fetchImpl(`${url}/v1/lines/${tn}/${te}`, { signal });
      if (!res.ok) { onProgress?.(++done, tiles.length); continue; }
      body = await res.json();
    } catch {
      onProgress?.(++done, tiles.length);
      continue;
    }
    for (const line of body.lines ?? []) {
      lines++;
      obstacles.push(...lineToObstacles(line, { tn, te, tileMetres: g.tileMetres }));
      // The boxes are what the collision check needs. The polyline is what a
      // person needs: twenty identical dots along a hedge is not a picture of
      // a power line, and the whole point of having this data is being able
      // to see the thing you would otherwise fly into.
      const e0 = te * g.tileMetres;
      const n0 = tn * g.tileMetres;
      paths.push({
        kind: line.kind, label: line.label, height: line.height,
        path: line.points.map(([x, y]) => toWgs84(e0 + x, n0 + y)),
      });
    }
    onProgress?.(++done, tiles.length);
  }
  return { obstacles, paths, lines, tiles: tiles.length };
}

export const _internals = { reset: () => { grid = null; } };
