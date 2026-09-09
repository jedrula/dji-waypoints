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

import { serviceUrl } from './heights.js';
import { serviceHeaders } from './service.js';

// How high a wire hangs, by voltage class. Not in the register -- BDOT10k says
// where a run goes and what it carries, never how far off the ground -- so
// every one of these is an assumption, and each is the top of the structure
// rather than the wire, because the number feeds a clearance check and the safe
// error is upward.
//
// They lived in js/osm.js with the building and tree guesses, which went when
// the obstacles did. server/src/bdot.js imports these to label a run.
export const ASSUMED = {
  powerLow: 10,          // 400 V distribution on wooden poles
  powerMedium: 16,       // 15-30 kV
  powerHigh: 40,         // 110 kV lattice towers
  powerVeryHigh: 60,     // 220-400 kV
};

export const SOURCE = 'bdot';

// How wide a box a power span gets. Not in any register -- BDOT10k says where a
// wire runs and what it carries, never how wide to treat it -- so it is a
// convention, and a generous one.
export const LINE_SPAN = 8;

const M_PER_DEG_LAT = 111132;
const mPerDegLon = (lat) => 111320 * Math.cos((lat * Math.PI) / 180);

// The rectangle round a ring of [lat, lon] pairs.
function bboxOfPairs(pairs) {
  const lats = pairs.map((p) => p[0]);
  const lons = pairs.map((p) => p[1]);
  return {
    north: Math.max(...lats), south: Math.min(...lats),
    east: Math.max(...lons), west: Math.min(...lons),
  };
}

// A wire is a strip: one obstacle per straight run, `span` wide, lying along
// the run at whatever angle the run happens to be at.
//
// This used to chop each run into 25 m pieces and put an axis-aligned box round
// every piece, because a single box round a 200 m diagonal would wall off a
// 200 m square of sky. A strip needs no chopping -- it is already the shape of
// the wire -- so a 200 m run is one obstacle instead of eight, and the eight
// were each still nearly twice as wide as the wire.
export function spanQuads(geometry, span) {
  const out = [];
  const half = span / 2;
  for (let i = 1; i < geometry.length; i++) {
    const a = geometry[i - 1];
    const b = geometry[i];
    const mLon = mPerDegLon(a.lat);
    const dx = (b.lon - a.lon) * mLon;
    const dy = (b.lat - a.lat) * M_PER_DEG_LAT;
    const len = Math.hypot(dx, dy);
    // Two mapped points in the same place are not a run of wire.
    if (len < 0.01) continue;
    // Out to the side of the run, half a span each way. A bend leaves a wedge
    // uncovered on its outside, which is air: the wire itself is inside both
    // strips, because both of them contain the vertex they meet at.
    const px = (-dy / len) * half;
    const py = (dx / len) * half;
    const dLat = py / M_PER_DEG_LAT;
    const dLon = px / mLon;
    const poly = [
      [a.lat + dLat, a.lon + dLon],
      [b.lat + dLat, b.lon + dLon],
      [b.lat - dLat, b.lon - dLon],
      [a.lat - dLat, a.lon - dLon],
    ];
    out.push({ ...bboxOfPairs(poly), poly });
  }
  return out;
}


// Tile geometry is the service's to define; asking keeps the two in step.
let grid = null;
async function tileGrid(fetchImpl) {
  if (grid) return grid;
  const res = await fetchImpl(`${serviceUrl()}/v1/health`, { headers: serviceHeaders() });
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

// One line's tile-local metres become the strips the collision check works in.
// The strip is osm.js's, deliberately: a wire is the same shape whichever
// importer found it, and that rule should exist once however many need it.
export function lineToObstacles(line, { tn, te, tileMetres }) {
  const e0 = te * tileMetres;
  const n0 = tn * tileMetres;
  const geometry = line.points.map(([x, y]) => toWgs84(e0 + x, n0 + y));
  if (geometry.length < 2) return [];
  return spanQuads(geometry, LINE_SPAN).map((rect) => ({
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
      const res = await fetchImpl(`${url}/v1/lines/${tn}/${te}`, { headers: serviceHeaders(), signal });
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
