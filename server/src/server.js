// Measured obstacle heights for Poland, on demand.
//
// The app can already plan a flight with nothing but OpenStreetMap and a
// guess: an untagged building is assumed to be 24 m because that is the p90 of
// real LiDAR returns over a Wroclaw tile. A guess is fine for a footprint and
// dangerous for a clearance, so this service replaces the guess with the
// measurement -- and it has to do that for anywhere in Poland, for people who
// have never been there before, without asking them to install anything.
//
// The shape that makes that possible:
//
//   the raw LiDAR              tens of MB per tile, server-side only, once
//   the derived height tile    250 kB, ~30 kB gzipped, cached forever
//
// A survey flown in 2024 is not going to change its mind, so every tile is
// built once in the life of the service and served from disk after that. The
// first person to fly a new field waits; nobody else ever does. Meanwhile the
// app keeps working on estimates, because a height service that is down must
// degrade to the behaviour that already shipped, not to a blank map.

import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { toPuwg92, toWgs84, inPoland } from '../../js/puwg92.js';
import { findTiles, createTileStore } from './gugik.js';
import { createTile, tileOf, originOf, TILE_M, SIZE, NO_DATA } from './ndsm.js';
import { createStore, LISTS } from './store.js';
import { createScene, GRID, CELL_M, KIND } from './scene.js';
import { createOrthoStore, ORTHO_PX } from './ortho.js';
import { createBdotStore } from './bdot.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.DATA_DIR ?? path.join(HERE, '..', 'var');
const PORT = Number(process.env.PORT ?? 8130);

// GUGiK is a public agency doing us a favour. Two downloads at a time, and
// every byte kept, so a busy day costs them a few hundred requests and not a
// few hundred thousand.
const BUILD_CONCURRENCY = Number(process.env.BUILD_CONCURRENCY ?? 2);

const lazStore = createTileStore({ dir: path.join(ROOT, 'laz') });
const syncStore = createStore({ dir: path.join(ROOT, 'sync') });
const TILE_DIR = path.join(ROOT, 'tile');
const SCENE_DIR = path.join(ROOT, 'scene');
const orthoStore = createOrthoStore({ dir: path.join(ROOT, 'ortho') });
const bdotStore = createBdotStore({ dir: path.join(ROOT, 'bdot') });
const LINES_DIR = path.join(ROOT, 'lines');

// ---------------------------------------------------------------- tile build

const building = new Map();   // key -> promise, so N requests cause one build
let active = 0;
const waiting = [];

function throttle(fn) {
  return new Promise((resolve, reject) => {
    const run = () => {
      active++;
      fn().then(resolve, reject).finally(() => {
        active--;
        waiting.shift()?.();
      });
    };
    if (active < BUILD_CONCURRENCY) run(); else waiting.push(run);
  });
}

const tileKey = (tn, te) => `${tn}_${te}`;
const tilePath = (tn, te) => path.join(TILE_DIR, `${tn}_${te}.bin.gz`);
const metaPath = (tn, te) => path.join(TILE_DIR, `${tn}_${te}.json`);

async function cachedTile(tn, te) {
  try {
    const [body, meta] = await Promise.all([
      readFile(tilePath(tn, te)),
      readFile(metaPath(tn, te), 'utf8').then(JSON.parse),
    ]);
    return { body, meta };
  } catch {
    return null;
  }
}

async function buildTile(tn, te) {
  const { e0, n0 } = originOf(te, tn);
  const box = { e0, n0, e1: e0 + TILE_M, n1: n0 + TILE_M };
  const sources = await findTiles(box);
  if (!sources.length) {
    const meta = { tn, te, empty: true, reason: 'no LiDAR coverage', builtAt: Date.now() };
    await persist(tn, te, new Uint8Array(SIZE * SIZE).fill(NO_DATA), meta);
    return { body: gzipSync(Buffer.alloc(0)), meta };
  }

  const acc = createTile(te, tn);
  const used = [];
  for (const src of sources) {
    const { file, bytes, cached } = await lazStore.fetchLaz(src.url);
    await acc.add(await readFile(file));
    used.push({ year: src.year, density: src.density, bytes, cached, url: src.url });
  }

  const done = acc.finish();
  const sw = toWgs84(e0, n0);
  const ne = toWgs84(e0 + TILE_M, n0 + TILE_M);
  const meta = {
    tn, te, size: SIZE, cellMetres: TILE_M / SIZE, tileMetres: TILE_M,
    origin: { east: e0, north: n0 },
    bounds: { south: sw.lat, west: sw.lon, north: ne.lat, east: ne.lon },
    sources: used.map(({ year, density, bytes }) => ({ year, density, bytes })),
    ...(done ? done.stats : { empty: true, reason: 'sources cover no part of this tile' }),
    builtAt: Date.now(),
  };
  const data = done ? done.data : new Uint8Array(SIZE * SIZE).fill(NO_DATA);
  return persist(tn, te, data, meta);
}

async function persist(tn, te, data, meta) {
  await mkdir(TILE_DIR, { recursive: true });
  // Stored gzipped and served gzipped -- the compression is the product, and
  // doing it once per tile rather than once per request is most of the reason
  // this can run on a home server.
  const body = gzipSync(Buffer.from(data.buffer, data.byteOffset, data.byteLength), { level: 9 });
  meta.gzipBytes = body.length;
  meta.rawBytes = data.length;
  const tmp = `${tilePath(tn, te)}.part`;
  await writeFile(tmp, body);
  await rename(tmp, tilePath(tn, te));
  await writeFile(metaPath(tn, te), JSON.stringify(meta));
  return { body, meta };
}

function requestTile(tn, te) {
  const key = tileKey(tn, te);
  if (building.has(key)) return building.get(key);
  const job = throttle(() => buildTile(tn, te)).finally(() => building.delete(key));
  building.set(key, job);
  return job;
}

// ------------------------------------------------------------ the rough model

const scenes = new Map();
const scenePath = (tn, te) => path.join(SCENE_DIR, `${tn}_${te}.bin.gz`);
const sceneMetaPath = (tn, te) => path.join(SCENE_DIR, `${tn}_${te}.json`);

async function cachedScene(tn, te) {
  try {
    const [body, meta] = await Promise.all([
      readFile(scenePath(tn, te)),
      readFile(sceneMetaPath(tn, te), 'utf8').then(JSON.parse),
    ]);
    // The photo is fetched alongside the geometry but is not part of it, and
    // the geometry takes minutes while the photo takes seconds. A WMS hiccup
    // during a build used to be written into the scene and kept forever, so
    // the tile was permanently colourless over a failure that had long since
    // passed. Check the disk instead of trusting what we recorded.
    if (meta.ortho?.error && !meta.ortho?.empty) {
      try {
        const s2 = await stat(orthoStore.fileFor(tn, te));
        if (s2.size > 0) {
          meta.ortho = { bytes: s2.size, pixels: ORTHO_PX };
          await writeFile(sceneMetaPath(tn, te), JSON.stringify(meta));
        }
      } catch { /* still missing; the recorded error stands */ }
    }
    return { body, meta };
  } catch {
    return null;
  }
}

async function buildScene(tn, te) {
  const { e0, n0 } = originOf(te, tn);
  const sources = await findTiles({ e0, n0, e1: e0 + TILE_M, n1: n0 + TILE_M });
  if (!sources.length) throw new Error('no LiDAR coverage here');

  const acc = createScene(te, tn);
  for (const src of sources) {
    const { file } = await lazStore.fetchLaz(src.url);
    await acc.add(await readFile(file));
  }
  const done = acc.finish();
  if (!done) throw new Error('the sources cover no part of this tile');

  // The colour is fetched alongside but is not fatal: a model with grey roofs
  // is still a model, and the geometry is the expensive half.
  let ortho = null;
  try {
    const got = await orthoStore.fetchOrtho(tn, te);
    ortho = { bytes: got.bytes, pixels: ORTHO_PX };
  } catch (err) {
    ortho = err.blank ? { empty: true, reason: String(err.message) } : { error: String(err.message ?? err) };
  }

  // heights first, then one classification byte per cell -- one file, one
  // request, and the gzip sees the whole thing at once.
  const bytes = Buffer.alloc(done.height.byteLength + done.kind.byteLength);
  Buffer.from(done.height.buffer, done.height.byteOffset, done.height.byteLength).copy(bytes, 0);
  Buffer.from(done.kind.buffer, done.kind.byteOffset, done.kind.byteLength).copy(bytes, done.height.byteLength);
  const body = gzipSync(bytes, { level: 9 });

  const sw = toWgs84(e0, n0);
  const ne = toWgs84(e0 + TILE_M, n0 + TILE_M);
  const meta = {
    tn, te, grid: GRID, cellMetres: CELL_M, tileMetres: TILE_M,
    origin: { east: e0, north: n0 },
    bounds: { south: sw.lat, west: sw.lon, north: ne.lat, east: ne.lon },
    heightUnit: 'cm above base', kinds: KIND,
    sources: sources.map((s2) => ({ year: s2.year, density: s2.density })),
    ortho,
    ...done.stats,
    rawBytes: bytes.length, gzipBytes: body.length,
    builtAt: Date.now(),
  };
  await mkdir(SCENE_DIR, { recursive: true });
  const tmp = `${scenePath(tn, te)}.part`;
  await writeFile(tmp, body);
  await rename(tmp, scenePath(tn, te));
  await writeFile(sceneMetaPath(tn, te), JSON.stringify(meta));
  return { body, meta };
}

function requestScene(tn, te) {
  const key = `${tn}_${te}`;
  if (scenes.has(key)) return scenes.get(key);
  const job = throttle(() => buildScene(tn, te)).finally(() => scenes.delete(key));
  scenes.set(key, job);
  return job;
}

// ------------------------------------------------------------------- routing

const ORIGIN_OK = /^https:\/\/[a-z0-9-]+\.github\.io$|^http:\/\/localhost:\d+$|^http:\/\/127\.0\.0\.1:\d+$/;

function headers(origin, extra = {}) {
  const h = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Sync-Key',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
    ...extra,
  };
  if (origin && ORIGIN_OK.test(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

const send = (res, status, body, origin, extra) => {
  res.writeHead(status, headers(origin, { 'Content-Type': 'application/json', ...extra }));
  res.end(JSON.stringify(body));
};

const readBody = (req, limit) => new Promise((resolve, reject) => {
  let n = 0;
  const parts = [];
  req.on('data', (c) => {
    n += c.length;
    if (n > limit) { reject(new Error('too much')); req.destroy(); return; }
    parts.push(c);
  });
  req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
  req.on('error', reject);
});

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const q = url.searchParams;

  try {
    if (req.method === 'OPTIONS') { res.writeHead(204, headers(origin)); return res.end(); }

    if (url.pathname === '/v1/health') {
      return send(res, 200, {
        ok: true, tileMetres: TILE_M, size: SIZE,
        building: building.size, active, queued: waiting.length,
      }, origin);
    }

    // What LiDAR exists here, without downloading any of it. Cheap enough to
    // call on every map pan, which is how the app can say "measured heights
    // available" before committing anyone to a wait.
    if (url.pathname === '/v1/coverage') {
      const lat = Number(q.get('lat')); const lon = Number(q.get('lon'));
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return send(res, 400, { error: 'lat and lon required' }, origin);
      if (!inPoland(lat, lon)) return send(res, 200, { covered: false, reason: 'outside Poland' }, origin);
      const { east, north } = toPuwg92(lat, lon);
      const { te, tn } = tileOf(east, north);
      const { e0, n0 } = originOf(te, tn);
      const sources = await findTiles({ e0, n0, e1: e0 + TILE_M, n1: n0 + TILE_M });
      const ready = await cachedTile(tn, te);
      return send(res, 200, {
        covered: sources.length > 0,
        tile: { tn, te },
        ready: Boolean(ready),
        sources: sources.map((s) => ({ year: s.year, density: s.density })),
      }, origin, { 'Cache-Control': 'public, max-age=3600' });
    }

    // The raster. 202 while it is being built, because the alternative is an
    // HTTP request held open for a minute -- which every proxy between here
    // and a phone will kill, at which point the work is thrown away and the
    // client tries again and starts it over.
    const m = url.pathname.match(/^\/v1\/tile\/(-?\d+)\/(-?\d+)$/);
    if (m) {
      const tn = Number(m[1]); const te = Number(m[2]);
      const ready = await cachedTile(tn, te);
      if (ready) {
        res.writeHead(200, headers(origin, {
          'Content-Type': 'application/octet-stream',
          'Content-Encoding': 'gzip',
          'Cache-Control': 'public, max-age=31536000, immutable',
          'X-Tile-Meta': JSON.stringify(ready.meta).slice(0, 3900),
        }));
        return res.end(ready.body);
      }
      if (q.get('wait') === '1') {
        const built = await requestTile(tn, te);
        res.writeHead(200, headers(origin, {
          'Content-Type': 'application/octet-stream',
          'Content-Encoding': 'gzip',
          'Cache-Control': 'public, max-age=31536000, immutable',
          'X-Tile-Meta': JSON.stringify(built.meta).slice(0, 3900),
        }));
        return res.end(built.body);
      }
      requestTile(tn, te).catch(() => {});
      return send(res, 202, { status: 'building', tile: { tn, te } }, origin, { 'Retry-After': '10' });
    }

    // One height, for the common case of "how tall is that". Builds the tile
    // if it has to, so the first call at a new site is the slow one.
    if (url.pathname === '/v1/height') {
      const lat = Number(q.get('lat')); const lon = Number(q.get('lon'));
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return send(res, 400, { error: 'lat and lon required' }, origin);
      if (!inPoland(lat, lon)) return send(res, 404, { error: 'outside Poland' }, origin);
      const { east, north } = toPuwg92(lat, lon);
      const { te, tn } = tileOf(east, north);
      const { e0, n0 } = originOf(te, tn);
      let entry = await cachedTile(tn, te);
      if (!entry) {
        if (q.get('wait') !== '1') {
          requestTile(tn, te).catch(() => {});
          return send(res, 202, { status: 'building', tile: { tn, te } }, origin, { 'Retry-After': '10' });
        }
        entry = await requestTile(tn, te);
      }
      const { gunzipSync } = await import('node:zlib');
      const data = gunzipSync(entry.body);
      const col = Math.min(SIZE - 1, Math.max(0, Math.floor(east - e0)));
      const row = Math.min(SIZE - 1, Math.max(0, Math.floor(TILE_M - (north - n0))));
      const v = data.length ? data[row * SIZE + col] : NO_DATA;
      return send(res, 200, {
        height: v === NO_DATA ? null : v,
        unit: 'm above local ground',
        measured: v !== NO_DATA,
        tile: { tn, te },
        source: entry.meta.sources?.[0] ?? null,
      }, origin);
    }

    // The rough model: geometry, colour, and a page to look at them in.
    const sceneMatch = url.pathname.match(/^\/v1\/scene\/(-?\d+)\/(-?\d+)(\.json|\.jpg)?$/);
    if (sceneMatch) {
      const tn = Number(sceneMatch[1]);
      const te = Number(sceneMatch[2]);
      const ext = sceneMatch[3];

      if (ext === '.jpg') {
        try {
          const { file } = await orthoStore.fetchOrtho(tn, te);
          const body = await readFile(file);
          res.writeHead(200, headers(origin, {
            'Content-Type': 'image/jpeg',
            'Cache-Control': 'public, max-age=31536000, immutable',
          }));
          return res.end(body);
        } catch (err) {
          return send(res, 502, { error: String(err.message ?? err) }, origin);
        }
      }

      let entry = await cachedScene(tn, te);
      if (!entry) {
        if (q.get('wait') !== '1' && ext !== '.json') {
          requestScene(tn, te).catch(() => {});
          return send(res, 202, { status: 'building', tile: { tn, te } }, origin, { 'Retry-After': '15' });
        }
        try {
          entry = await requestScene(tn, te);
        } catch (err) {
          return send(res, 404, { error: String(err.message ?? err) }, origin);
        }
      }
      if (ext === '.json') return send(res, 200, entry.meta, origin);
      res.writeHead(200, headers(origin, {
        'Content-Type': 'application/octet-stream',
        'Content-Encoding': 'gzip',
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Scene-Meta': JSON.stringify(entry.meta).slice(0, 3900),
      }));
      return res.end(entry.body);
    }

    // Overhead lines over a tile. The one obstacle the point cloud cannot see
    // and the one most likely to matter.
    const lineMatch = url.pathname.match(/^\/v1\/lines\/(-?\d+)\/(-?\d+)$/);
    if (lineMatch) {
      const tn = Number(lineMatch[1]);
      const te = Number(lineMatch[2]);
      const cache = path.join(LINES_DIR, `${tn}_${te}.json`);
      try {
        const hit = JSON.parse(await readFile(cache, 'utf8'));
        return send(res, 200, hit, origin, { 'Cache-Control': 'public, max-age=604800' });
      } catch { /* build it */ }
      try {
        const out = await throttle(() => bdotStore.linesFor(tn, te));
        await mkdir(LINES_DIR, { recursive: true });
        await writeFile(cache, JSON.stringify(out));
        return send(res, 200, out, origin, { 'Cache-Control': 'public, max-age=604800' });
      } catch (err) {
        return send(res, 502, { error: String(err.message ?? err) }, origin);
      }
    }

    // Where is the nearest thing worth looking at, given a lat/lon.
    if (url.pathname === '/v1/locate') {
      const lat = Number(q.get('lat'));
      const lon = Number(q.get('lon'));
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return send(res, 400, { error: 'lat and lon required' }, origin);
      if (!inPoland(lat, lon)) return send(res, 404, { error: 'outside Poland' }, origin);
      const { east, north } = toPuwg92(lat, lon);
      const { te, tn } = tileOf(east, north);
      return send(res, 200, { tile: { tn, te }, east, north }, origin);
    }

    if (url.pathname === '/' || url.pathname === '/scene') {
      const page = await readFile(path.join(HERE, '..', 'public', 'scene.html'));
      res.writeHead(200, headers(origin, { 'Content-Type': 'text/html; charset=utf-8' }));
      return res.end(page);
    }

    // The two sync lists, byte-for-byte the Worker's protocol, so switching a
    // client over is a URL change and nothing else.
    const list = LISTS[url.pathname];
    if (list) {
      if (origin && !ORIGIN_OK.test(origin)) return send(res, 403, { error: 'origin not allowed' }, origin);
      const key = req.headers['x-sync-key'] ?? '';
      if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) return send(res, 401, { error: 'a sync key is required' }, origin);
      if (req.method === 'GET') return send(res, 200, { [list.field]: await syncStore.get(list, key) }, origin);
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' }, origin);
      let raw;
      try { raw = await readBody(req, list.maxBody); } catch { return send(res, 413, { error: 'too much' }, origin); }
      let incoming;
      try { incoming = JSON.parse(raw)[list.field]; } catch { return send(res, 400, { error: 'bad json' }, origin); }
      if (!Array.isArray(incoming)) return send(res, 400, { error: `${list.field} must be an array` }, origin);
      return send(res, 200, { [list.field]: await syncStore.put(list, key, incoming) }, origin);
    }

    return send(res, 404, { error: 'not found' }, origin);
  } catch (err) {
    return send(res, 500, { error: String(err?.message ?? err) }, origin);
  }
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(PORT, () => {
    console.log(`heights service on :${PORT}  data ${ROOT}  tiles ${TILE_M} m`);
  });
}

export { server, buildTile, requestTile };
