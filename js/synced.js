// One person, a few devices, and a list of things worth keeping. Plans were the
// first such list; the obstacles you draw on the map are the second, and the
// rule for keeping them in step is the same one -- local first, last write wins
// per id, and a tombstone travels like any other edit.
//
// Writing that rule twice is how two lists start disagreeing with each other
// and with the Worker, so it lives here once. Each list then says only what its
// own records look like.
//
// Storage and fetch are injected so this runs under node in the test suite.

// The whole of "logging in", until there is anything to log in to. One person,
// two devices, one key, compiled into the app -- which means it is as public as
// the app is, and anyone reading this file can read and write the lists. That
// is the trade for having no key to copy between devices, and it holds only
// while a plan list is the sort of thing worth nobody's trouble. A real login
// replaces this constant with an account id; nothing else changes.
export const SYNC_KEY = 'andrzej-H5rGhCrCRmPXoRSFUA8etg';

// Set by `wrangler deploy` (see sync/README.md). Empty would mean local-only,
// which is still a perfectly good way to use the app.
export const SYNC_URL = 'https://dji-waypoints-sync.andrzej-swaton.workers.dev';

const URL_OVERRIDE = 'dji.syncUrl';

function newId() {
  const b = new Uint8Array(9);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Last write wins per id; a tombstone is a write like any other. Same rule as
// the Worker, deliberately -- two copies of one rule is bad, but a client that
// merges differently from the server is worse. Ties go to whatever came later
// in the arguments, which is the write that just arrived.
export function merge(a, b) {
  const by = new Map();
  for (const r of [...a, ...b]) {
    const prev = by.get(r.id);
    if (!prev || r.updatedAt >= prev.updatedAt) by.set(r.id, r);
  }
  return [...by.values()].sort((x, y) => y.updatedAt - x.updatedAt);
}

// Every write on a device gets a timestamp strictly later than every write
// before it. Date.now() alone is not enough: two saves inside one millisecond
// tie, and a tie is indistinguishable from no change -- the second save loses
// silently, and the list stops being ordered by when you saved.
function stamp(records) {
  const latest = records.reduce((max, r) => Math.max(max, r.updatedAt ?? 0), 0);
  return Math.max(Date.now(), latest + 1);
}

// `collection` is the JSON key on the wire and `path` the Worker route; the two
// together are all that separates one list from another.
export function createSyncedStore({
  collection, path, storageKey, shape = (r) => r,
  storage, fetchImpl, endpoint,
} = {}) {
  const store = storage ?? globalThis.localStorage;
  const http = fetchImpl ?? globalThis.fetch?.bind(globalThis);

  const readAll = () => {
    try {
      const raw = JSON.parse(store.getItem(storageKey) ?? '[]');
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  };
  const writeAll = (records) => store.setItem(storageKey, JSON.stringify(records));

  const url = () => endpoint ?? store.getItem(URL_OVERRIDE) ?? SYNC_URL;

  return {
    // Tombstones are storage, not list entries.
    list: () => readAll().filter((r) => !r.deleted),

    // `input.id` names an existing record to overwrite; without one this is new.
    put(input) {
      const records = readAll();
      const record = { ...shape(input), id: input.id ?? newId(), updatedAt: stamp(records) };
      writeAll(merge(records, [record]));
      return record;
    },

    remove(id) {
      const records = readAll();
      writeAll(merge(records, [{ id, deleted: true, updatedAt: stamp(records) }]));
    },

    endpoint: url,

    // One round trip: send everything, get the union back. No cursors, no
    // conflict prompts -- with one person and two devices, whichever edit
    // happened later is the one meant.
    async sync() {
      const to = url();
      if (!to) throw new Error('no sync service configured');
      const before = readAll();
      const res = await http(`${to.replace(/\/$/, '')}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Sync-Key': SYNC_KEY },
        body: JSON.stringify({ [collection]: before }),
      });
      const body = await res.json().catch(() => ({}));
      // A 404 is the one failure with a specific cause: the service is up but
      // is running a build that predates this list. "not found" would send
      // someone hunting for a bad URL instead of redeploying the Worker.
      if (res.status === 404) {
        throw new Error(`the sync service has no ${collection} route — deploy sync/worker.js`);
      }
      if (!res.ok) throw new Error(body.error ?? `sync failed (${res.status})`);
      const incoming = Array.isArray(body[collection]) ? body[collection] : [];
      const merged = merge(before, incoming);
      writeAll(merged);
      // Count only what a person can see: a tombstone arriving from the other
      // device is a real change, but reporting it as "1 new" is a lie.
      const seen = new Set(before.map((r) => `${r.id}:${r.updatedAt}`));
      return {
        total: merged.filter((r) => !r.deleted).length,
        pulled: merged.filter((r) => !r.deleted && !seen.has(`${r.id}:${r.updatedAt}`)).length,
      };
    },
  };
}
