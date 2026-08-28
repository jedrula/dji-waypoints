// Plan sync. A plan is a ~200 character code (js/share.js), so the whole store
// for one person is a few kilobytes of JSON -- one KV entry per sync key, not
// one per plan. That makes a merge atomic enough for a single user with two
// devices, which is the entire user base this is built for.
//
// There are no accounts. The client sends one key, hardcoded in js/plans.js so
// that two devices share a list with nothing to set up; the namespace is its
// SHA-256, so a dump of KV does not hand anyone the keys. The key itself is
// public, since it ships in a public app -- the Worker treats it as a name, not
// a secret. When there is more than one person, the key becomes the user id and
// a real login sits in front of it -- nothing about the storage shape has to
// change.

const MAX_PLANS = 500;
const MAX_BODY = 64 * 1024;
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

// A plan is worth storing only if it is the shape the client promises. Anything
// else is a bug or an intruder, and neither should end up in someone's list.
function clean(p) {
  if (!p || typeof p !== 'object') return null;
  const id = String(p.id ?? '');
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(id)) return null;
  const updatedAt = Number(p.updatedAt);
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return null;
  const out = { id, updatedAt };
  if (p.deleted) { out.deleted = true; return out; }
  const name = String(p.name ?? '').slice(0, MAX_NAME);
  const code = String(p.code ?? '');
  if (!name || !code || code.length > MAX_CODE) return null;
  out.name = name;
  out.code = code;
  return out;
}

// Last write wins per id, and a tombstone is a write like any other -- which is
// what makes a delete on the phone reach the Mac. On an equal timestamp the
// incoming write wins, since it is the one that just travelled.
function merge(a, b) {
  const by = new Map();
  for (const p of [...a, ...b]) {
    const prev = by.get(p.id);
    if (!prev || p.updatedAt >= prev.updatedAt) by.set(p.id, p);
  }
  return [...by.values()]
    .sort((x, y) => y.updatedAt - x.updatedAt || x.id.localeCompare(y.id))
    .slice(0, MAX_PLANS);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
    if (url.pathname !== '/sync') return json({ error: 'not found' }, 404, origin);
    if (origin && !ORIGIN_OK.test(origin)) return json({ error: 'origin not allowed' }, 403, origin);

    const key = request.headers.get('X-Sync-Key') ?? '';
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) return json({ error: 'a sync key is required' }, 401, origin);
    const ns = `ns:${await namespace(key)}`;

    const stored = JSON.parse((await env.PLANS.get(ns)) ?? '[]');

    if (request.method === 'GET') return json({ plans: stored }, 200, origin);
    if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405, origin);

    const raw = await request.text();
    if (raw.length > MAX_BODY) return json({ error: 'too much' }, 413, origin);
    let incoming;
    try {
      incoming = JSON.parse(raw).plans;
    } catch {
      return json({ error: 'bad json' }, 400, origin);
    }
    if (!Array.isArray(incoming)) return json({ error: 'plans must be an array' }, 400, origin);

    const merged = merge(stored, incoming.map(clean).filter(Boolean));
    await env.PLANS.put(ns, JSON.stringify(merged));
    return json({ plans: merged }, 200, origin);
  },
};

export { merge, clean };
