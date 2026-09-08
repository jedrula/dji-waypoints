// The sync protocol: what a record is, what a list keeps, and what either is
// allowed to throw away.
//
// One file, because everything that touches these lists has to agree about
// them: the browser client merges before it ever talks to a server, and the
// server validates what arrives. A client that merges differently from a server
// is how a record comes back from the dead, or fails to.
//
// There are no accounts. The client sends one key, hardcoded in js/synced.js so
// that two devices share a list with nothing to set up, and the store
// namespaces by its SHA-256 -- so a dump of the storage does not hand anyone
// the keys. The key itself is public, since it ships in a public app; it is a
// name, not a secret. When there is more than one person the key becomes the
// user id and a real login sits in front of it, and nothing about the storage
// shape has to change.
//
// This used to live inside sync/worker.js, and the Node service imported it
// from there -- which had the only Cloudflare-specific file in the repo owning
// the rules for a service that is not Cloudflare. See server/README.md.

const MAX_NAME = 80;
const MAX_CODE = 2000;

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
export function clean(p) {
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

export function cleanObstacle(o) {
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

// A tombstone exists to tell the other device about a delete. Once every
// device has certainly seen it, it is only taking up room. Thirty days is far
// longer than the gap between two devices syncing in any normal week, and the
// cost of being wrong is bounded and known: a device that was offline for the
// whole window, still holding the record alive, will put it back on its next
// sync. That is the standard trade for not growing a list forever.
export const TOMBSTONE_MS = 30 * 24 * 60 * 60 * 1000;

// And a hard ceiling, so a pathological month cannot fill the store with
// nothing but deletions.
export const MAX_TOMBSTONES = 200;

const byNewest = (x, y) => y.updatedAt - x.updatedAt || String(x.id).localeCompare(String(y.id));

// Last write wins per id; a tombstone is a write like any other. `max` bounds
// the LIVE records. Pass `now` in tests.
export function mergeRecords(a, b, max = 500, now = Date.now()) {
  const by = new Map();
  for (const r of [...a, ...b]) {
    const prev = by.get(r.id);
    if (!prev || r.updatedAt >= prev.updatedAt) by.set(r.id, r);
  }
  const all = [...by.values()].sort(byNewest);
  const live = all.filter((r) => !r.deleted).slice(0, max);
  const dead = all
    .filter((r) => r.deleted && now - r.updatedAt < TOMBSTONE_MS)
    .slice(0, MAX_TOMBSTONES);
  return [...live, ...dead].sort(byNewest);
}

// Last write wins per id, and a tombstone is a write like any other -- which is
// what makes a delete on the phone reach the Mac. On an equal timestamp the
// incoming write wins, since it is the one that just travelled.
export const merge = (a, b, max = 500) => mergeRecords(a, b, max);
