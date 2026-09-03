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

// Off unless the page is itself local, so the deployed app does not spend a
// round trip on a service that is only ever running on someone's laptop. Set
// localStorage['dji.heightsUrl'] to point anywhere.
const LOCAL = /^(localhost|127\.0\.0\.1)$/.test(globalThis.location?.hostname ?? '');
const DEFAULT_URL = LOCAL ? 'http://localhost:8130' : '';

export function serviceUrl() {
  try {
    return (globalThis.localStorage?.getItem('dji.heightsUrl') ?? DEFAULT_URL).replace(/\/$/, '');
  } catch {
    return DEFAULT_URL;
  }
}

// The grid comes from the service rather than being written down twice. If the
// two ever disagreed the sampling would be silently off by whole tiles, which
// looks like bad data rather than a bug.
let geometry = null;
async function grid(fetchImpl) {
  if (geometry) return geometry;
  const res = await fetchImpl(`${serviceUrl()}/v1/health`);
  if (!res.ok) throw new Error(`heights service answered ${res.status}`);
  const h = await res.json();
  geometry = { tileMetres: h.tileMetres, size: h.size };
  return geometry;
}

const tiles = new Map();   // "tn/te" -> Uint8Array | null

// A tile that is not built yet answers 202 and starts building. The first
// visit to an area is a real wait -- four LAZ tiles have to come down from
// GUGiK -- so this keeps asking rather than failing, and gives up before
// anyone starts wondering whether it is broken.
async function fetchTile(tn, te, { fetchImpl, signal, waitMs, onWait }) {
  const key = `${tn}/${te}`;
  if (tiles.has(key)) return tiles.get(key);

  const until = Date.now() + waitMs;
  let told = false;
  for (;;) {
    const res = await fetchImpl(`${serviceUrl()}/v1/tile/${tn}/${te}`, { signal });
    if (res.status === 200) {
      const data = new Uint8Array(await res.arrayBuffer());
      tiles.set(key, data);
      return data;
    }
    if (res.status !== 202 || Date.now() > until) {
      tiles.set(key, null);
      return null;
    }
    if (!told) { told = true; onWait?.(); }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

// The tallest measured cell under a footprint. A building is what its roof is,
// not what its average is, and the whole point of measuring is to stop being
// optimistic about the thing you are flying at.
function sampleMax(rect, { tileMetres, size }, get) {
  const cell = tileMetres / size;
  const sw = toPuwg92(rect.south, rect.west);
  const ne = toPuwg92(rect.north, rect.east);
  let best = null;
  let blank = 0;
  let seen = 0;
  for (let north = Math.floor(sw.north); north <= Math.ceil(ne.north); north += cell) {
    for (let east = Math.floor(sw.east); east <= Math.ceil(ne.east); east += cell) {
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
  fetchImpl = globalThis.fetch, signal, waitMs = 150000, onWait, onProgress,
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

// For the tests and for anyone poking at it from a console.
export const _internals = { sampleMax, tilesFor, reset: () => { tiles.clear(); geometry = null; } };
