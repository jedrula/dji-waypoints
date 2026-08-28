// Storage for the two lists this app keeps: the plans you saved, and the
// obstacles you drew on the map. A plan is a ~200 character code (js/share.js)
// and an obstacle is a rectangle plus a height, so the whole store for one
// person is a few kilobytes of JSON -- one KV entry per list per sync key, not
// one per record. That makes a merge atomic enough for a single user with two
// devices, which is the entire user base this is built for.
//
// There are no accounts. The client sends one key, hardcoded in js/synced.js so
// that two devices share a list with nothing to set up; the namespace is its
// SHA-256, so a dump of KV does not hand anyone the keys. The key itself is
// public, since it ships in a public app -- the Worker treats it as a name, not
// a secret. When there is more than one person, the key becomes the user id and
// a real login sits in front of it -- nothing about the storage shape has to
// change.

const MAX_NAME = 80;
const MAX_CODE = 2000;

const ORIGIN_OK = /^https:\/\/[a-z0-9-]+\.github\.io$|^http:\/\/localhost:\d+$|^http:\/\/127\.0\.0\.1:\d+$/;

function cors(origin) {
  const h = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Sync-Key',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (origin && ORIGIN_OK.test(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors(origin) },
  });
}

async function namespace(key) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Whatever else a record is, it needs an id nobody forged and a timestamp the
// merge can order by. A tombstone needs nothing more than that.
function envelope(r) {
  if (!r || typeof r !== 'object') return null;
  const id = String(r.id ?? '');
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(id)) return null;
  const updatedAt = Number(r.updatedAt);
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return null;
  return { id, updatedAt, ...(r.deleted ? { deleted: true } : {}) };
}

// A plan is worth storing only if it is the shape the client promises. Anything
// else is a bug or an intruder, and neither should end up in someone's list.
function clean(p) {
  const out = envelope(p);
  if (!out || out.deleted) return out;
  const name = String(p.name ?? '').slice(0, MAX_NAME);
  const code = String(p.code ?? '');
  if (!name || !code || code.length > MAX_CODE) return null;
  out.name = name;
  out.code = code;
  return out;
}

// Roughly 5 km a side. Nothing you would draw as a cube is bigger, and the cap
// is what stops a stray edit from storing a box the size of a country.
const MAX_SPAN_DEG = 0.05;

function cleanObstacle(o) {
  const out = envelope(o);
  if (!out || out.deleted) return out;
  const num = (v, lo, hi) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= lo && n <= hi ? n : null;
  };
  const north = num(o.north, -90, 90);
  const south = num(o.south, -90, 90);
  const east = num(o.east, -180, 180);
  const west = num(o.west, -180, 180);
  const height = num(o.height, 0, 1000);
  if ([north, south, east, west, height].some((n) => n === null)) return null;
  // West of east and south of north, always: the client normalises before it
  // sends, and a box that crosses the antimeridian is not something this app
  // can draw anyway.
  if (north <= south || east <= west) return null;
  if (north - south > MAX_SPAN_DEG || east - west > MAX_SPAN_DEG) return null;
  out.name = String(o.name ?? '').slice(0, MAX_NAME);
  out.north = north; out.south = south; out.east = east; out.west = west;
  out.height = height;
  return out;
}

// One route per list. The prefix keeps them apart inside the one KV namespace,
// and `ns:` is what plans were stored under before obstacles existed.
const LISTS = {
  '/sync': { field: 'plans', prefix: 'ns:', max: 500, maxBody: 64 * 1024, clean },
  '/obstacles': { field: 'obstacles', prefix: 'obs:', max: 800, maxBody: 256 * 1024, clean: cleanObstacle },
};

// Last write wins per id, and a tombstone is a write like any other -- which is
// what makes a delete on the phone reach the Mac. On an equal timestamp the
// incoming write wins, since it is the one that just travelled.
function merge(a, b, max = 500) {
  const by = new Map();
  for (const p of [...a, ...b]) {
    const prev = by.get(p.id);
    if (!prev || p.updatedAt >= prev.updatedAt) by.set(p.id, p);
  }
  return [...by.values()]
    .sort((x, y) => y.updatedAt - x.updatedAt || x.id.localeCompare(y.id))
    .slice(0, max);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
    const list = LISTS[url.pathname];
    if (!list) return json({ error: 'not found' }, 404, origin);
    if (origin && !ORIGIN_OK.test(origin)) return json({ error: 'origin not allowed' }, 403, origin);

    const key = request.headers.get('X-Sync-Key') ?? '';
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) return json({ error: 'a sync key is required' }, 401, origin);
    const ns = `${list.prefix}${await namespace(key)}`;

    const stored = JSON.parse((await env.PLANS.get(ns)) ?? '[]');

    if (request.method === 'GET') return json({ [list.field]: stored }, 200, origin);
    if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405, origin);

    const raw = await request.text();
    if (raw.length > list.maxBody) return json({ error: 'too much' }, 413, origin);
    let incoming;
    try {
      incoming = JSON.parse(raw)[list.field];
    } catch {
      return json({ error: 'bad json' }, 400, origin);
    }
    if (!Array.isArray(incoming)) return json({ error: `${list.field} must be an array` }, 400, origin);

    const merged = merge(stored, incoming.map(list.clean).filter(Boolean), list.max);
    await env.PLANS.put(ns, JSON.stringify(merged));
    return json({ [list.field]: merged }, 200, origin);
  },
};

export { merge, clean, cleanObstacle };
