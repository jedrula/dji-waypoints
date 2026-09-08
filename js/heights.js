// Replacing assumed heights with measured ones.
//
// An imported obstacle arrives from OpenStreetMap with a height that is often
// invented: 24 m for an untagged building, because that is the p90 of real
// LiDAR returns. The heights service (see server/) turns Poland's national
// LiDAR into a byte per square metre, and this asks it what is actually there.
//
// Everything here is an UPGRADE. The app plans fine without it -- the service
// being absent, unreachable, still building a tile or simply having no survey
// for that field all end the same way, with the estimate the app already had.
// A height service that is down must degrade to yesterday's behaviour, never
// to a blank map.

import { toPuwg92, inPoland } from './puwg92.js';
import { insideRing } from './prism.js';
import { serviceUrl, serviceHeaders } from './service.js';


// The grid comes from the service rather than being written down twice. If the
// two ever disagreed the sampling would be silently off by whole tiles, which
// looks like bad data rather than a bug.
let geometry = null;
async function grid(fetchImpl) {
  if (geometry) return geometry;
  const res = await fetchImpl(`${serviceUrl()}/v1/health`, { headers: serviceHeaders() });
  if (!res.ok) throw new Error(`heights service answered ${res.status}`);
  const h = await res.json();
  geometry = { tileMetres: h.tileMetres, size: h.size };
  return geometry;
}

const tiles = new Map();   // "tn/te" -> Uint8Array | null

// A tile that is not built yet answers 202 and starts building. The first
// visit to an area is a real wait -- several LAZ sheets have to come down from
// GUGiK -- so this keeps asking rather than failing, and gives up before
// anyone starts wondering whether it is broken.
//
// The budget is 240 s because 150 s was measurably too short: a cold tile in
// Krakow took 152 s end to end. Giving up is cheap now (see below), so the
// number only has to cover the common case rather than the worst one.
async function fetchTile(tn, te, { fetchImpl, signal, waitMs, onWait }) {
  const key = `${tn}/${te}`;
  if (tiles.has(key)) return tiles.get(key);

  const until = Date.now() + waitMs;
  let told = false;
  for (;;) {
    const res = await fetchImpl(`${serviceUrl()}/v1/tile/${tn}/${te}`, { headers: serviceHeaders(), signal });
    if (res.status === 200) {
      const data = new Uint8Array(await res.arrayBuffer());
      tiles.set(key, data);
      return data;
    }
    // A definite answer that is not a tile: no survey here, or the service is
    // unwell. Remember it, so importing fifty obstacles does not ask fifty
    // times.
    if (res.status !== 202) {
      tiles.set(key, null);
      return null;
    }
    // Giving up waiting is NOT the same as there being nothing here, and
    // remembering it as such was costing real measurements. A cold tile took
    // 152 s to build (measured 2026-09-09, Krakow 488/1134: five GUGiK sheets,
    // 331 MB, for a 75 kB tile) against a budget of 150 s -- so the first
    // visit to a new area timed out about two seconds before its own tile
    // landed, cached the miss for the rest of the session, and left the
    // heights as estimates until the page was reloaded. The build carries on
    // server-side regardless, so forgetting the miss is what lets the next
    // import pick up a tile that is by then instant.
    if (Date.now() > until) return null;
    if (!told) { told = true; onWait?.(); }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

// The obstacle's outline in the survey's own coordinates, so a cell can be
// asked whether it is on the building or merely near it.
const ringPuwg = (rect) => (Array.isArray(rect.poly) && rect.poly.length >= 3
  ? rect.poly.map(([lat, lon]) => {
    const p = toPuwg92(lat, lon);
    return { x: p.east, y: p.north };
  })
  : null);

// The tallest measured cell under a footprint. A building is what its roof is,
// not what its average is, and the whole point of measuring is to stop being
// optimistic about the thing you are flying at.
//
// Over the FOOTPRINT, though, not over the rectangle round it. This was the
// worst of the bounding box, worse than the wasted sky: at a median 1.9x too
// big, the rectangle round a building routinely covers the neighbour's roof, so
// a single-storey garage beside a 24 m block measured 24 m -- and `assumed`
// went false, which is the app stating as measured fact a number belonging to a
// different building. The one thing js/osm.js says it must never do.
function sampleMax(rect, { tileMetres, size }, get) {
  const cell = tileMetres / size;
  const sw = toPuwg92(rect.south, rect.west);
  const ne = toPuwg92(rect.north, rect.east);
  const ring = ringPuwg(rect);
  const sweep = (step) => {
    let best = null;
    let blank = 0;
    let seen = 0;
    for (let north = Math.floor(sw.north); north <= Math.ceil(ne.north); north += step) {
      for (let east = Math.floor(sw.east); east <= Math.ceil(ne.east); east += step) {
        if (ring && !insideRing({ x: east, y: north }, ring)) continue;
        const tn = Math.floor(north / tileMetres);
        const te = Math.floor(east / tileMetres);
        const data = get(tn, te);
        if (!data) continue;
        const col = Math.min(size - 1, Math.floor((east - te * tileMetres) / cell));
        const row = Math.min(size - 1, Math.floor((tileMetres - (north - tn * tileMetres)) / cell));
        const v = data[row * size + col];
        seen++;
        // 255 is NOT zero. It is water, or ground the survey missed, and reading
        // it as "nothing here" is how you fly into whatever the laser missed.
        if (v === 255) { blank++; continue; }
        if (best === null || v > best) best = v;
      }
    }
    return { height: best, blank, seen };
  };
  const got = sweep(cell);
  // A footprint smaller than the grid, or unluckily placed on it, can fall
  // between lattice points. Asking again at quarter steps is cheaper than
  // reporting "no survey here" for a shed that is plainly on the map -- and far
  // better than the old answer, which was whatever stood next to it.
  if (ring && !got.seen) return sweep(cell / 4);
  return got;
}

// Which tiles a set of rectangles touches, so they are fetched once each
// rather than once per obstacle.
function tilesFor(rects, { tileMetres }) {
  const need = new Set();
  for (const r of rects) {
    const sw = toPuwg92(r.south, r.west);
    const ne = toPuwg92(r.north, r.east);
    for (let tn = Math.floor(sw.north / tileMetres); tn <= Math.floor(ne.north / tileMetres); tn++) {
      for (let te = Math.floor(sw.east / tileMetres); te <= Math.floor(ne.east / tileMetres); te++) {
        need.add(`${tn}/${te}`);
      }
    }
  }
  return [...need].map((k) => k.split('/').map(Number));
}

// Takes what the OSM import produced and hands back the same list with every
// height it could measure replaced. `assumed` goes false on those, which is
// what drops the `~` from the label and stops the app calling it a guess.
export async function measure(found, {
  fetchImpl = globalThis.fetch, signal, waitMs = 240000, onWait, onProgress,
} = {}) {
  const url = serviceUrl();
  const wanted = found.filter((f) => f.assumed);
  if (!url || !wanted.length) return { obstacles: found, measured: 0, reason: url ? null : 'no service' };
  if (!wanted.every((f) => inPoland(f.north, f.east))) {
    // Mixed or outside: measure what is in Poland, leave the rest.
  }

  let g;
  try {
    g = await grid(fetchImpl);
  } catch (e) {
    return { obstacles: found, measured: 0, reason: e.message };
  }

  const needed = tilesFor(wanted.filter((f) => inPoland(f.north, f.east)), g);
  let done = 0;
  for (const [tn, te] of needed) {
    await fetchTile(tn, te, { fetchImpl, signal, waitMs, onWait });
    onProgress?.(++done, needed.length);
  }

  const get = (tn, te) => tiles.get(`${tn}/${te}`) ?? null;
  let measured = 0;
  let blanked = 0;
  const obstacles = found.map((f) => {
    if (!f.assumed || !inPoland(f.north, f.east)) return f;
    const { height, blank, seen } = sampleMax(f, g, get);
    if (height === null) { if (seen && blank === seen) blanked++; return f; }
    // A measured zero means the survey looked and found flat ground -- a
    // demolished building, a footprint OSM still carries. Trust it, but never
    // let it become an obstacle of height 0 that the planner then ignores;
    // dropping it is the caller's business, so mark it and move on.
    measured++;
    return { ...f, height, assumed: false, measured: true };
  });
  return { obstacles, measured, blanked, tiles: needed.length };
}

// What the survey says is standing under a whole area, rather than under one
// footprint someone imported.
//
// This is the difference between planning around a list and planning around
// the ground. `measure` above corrects the height of an obstacle OpenStreetMap
// already knew about; it can say nothing at all about a thing nobody mapped --
// a line of poplars along a field edge, a pole, a crane, a barn extension. The
// survey saw all of it: one byte per square metre, measured, whether or not
// anyone ever drew it.
//
// So the honest ceiling for a flight is the tallest measured cell anywhere
// under it, and that is what this returns. It is deliberately blunt: the
// maximum over the whole area, not per leg, because an aircraft holds one
// barometric altitude for the flight and the tallest thing it crosses is the
// one that decides whether that altitude is safe.
//
// Everything it cannot vouch for is reported rather than assumed away:
//
//   `missing`  tiles that are not built yet, or have no survey at all
//   `blank`    cells the laser did not measure -- water, shadow, gaps
//
// A caller that ignores those is claiming to know a number it does not, which
// for a clearance is the difference between a bad photograph and a crash. Both
// counts being zero is the only case where `height` is the whole truth.
export async function surveyCeiling(bounds, {
  fetchImpl = globalThis.fetch, signal, waitMs = 240000, onWait, onProgress,
} = {}) {
  const url = serviceUrl();
  if (!url) return { height: null, reason: 'no service' };
  // The corners, not the centre: a site straddling the border is half a survey
  // and the half outside it is unknown, not flat.
  if (!inPoland(bounds.north, bounds.east) || !inPoland(bounds.south, bounds.west)) {
    return { height: null, reason: 'outside the survey' };
  }

  let g;
  try {
    g = await grid(fetchImpl);
  } catch (e) {
    return { height: null, reason: e.message };
  }

  const needed = tilesFor([bounds], g);
  let done = 0;
  let missing = 0;
  for (const [tn, te] of needed) {
    if (!(await fetchTile(tn, te, { fetchImpl, signal, waitMs, onWait }))) missing++;
    onProgress?.(++done, needed.length);
  }

  const get = (tn, te) => tiles.get(`${tn}/${te}`) ?? null;
  const { height, blank, seen } = sampleMax(bounds, g, get);
  return { height, blank, seen, tiles: needed.length, missing };
}

export { serviceUrl };

// For the tests and for anyone poking at it from a console.
export const _internals = { sampleMax, tilesFor, reset: () => { tiles.clear(); geometry = null; } };
