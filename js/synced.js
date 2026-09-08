import { mergeRecords } from '../sync/protocol.js';
import { serviceUrl } from './service.js';
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



function newId() {
  const b = new Uint8Array(9);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Last write wins per id; a tombstone is a write like any other. The rule is
// imported rather than written again -- a client that merges differently from
// the server is worse than one rule in one file, and that includes how long
// each of them keeps a tombstone. If the client hoarded deletions the server
// had already forgotten, it would hand them back on every sync forever.
//
// No cap on the client: the browser is storing a few kilobytes and the server
// is the one with a list length to defend. Passing Infinity says that on
// purpose rather than by leaving an argument off.
export const merge = (a, b) => mergeRecords(a, b, Infinity);

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
// `local` marks records that live on this device and are never sent. Anything
// derived from a public dataset belongs here: it is re-fetchable, it is not
// anybody's work, and syncing it is how a list of four hundred imported
// obstacles and then four hundred tombstones for them ends up shoving
// hand-placed records out of a capped list.
export function createSyncedStore({
  collection, path, storageKey, shape = (r) => r,
  storage, fetchImpl, endpoint, local = () => false,
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

  const url = () => endpoint ?? serviceUrl();

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
      // A record no other device ever heard about needs no tombstone. Writing
      // one anyway is pure cost: it travels, it takes a slot, and there is
      // nothing anywhere for it to delete.
      const gone = records.find((r) => r.id === id);
      if (gone && local(gone)) {
        writeAll(records.filter((r) => r.id !== id));
        return;
      }
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
      const send = before.filter((r) => !local(r));
      const res = await http(`${to.replace(/\/$/, '')}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Sync-Key': SYNC_KEY },
        body: JSON.stringify({ [collection]: send }),
      });
      const body = await res.json().catch(() => ({}));
      // A 404 is the one failure with a specific cause: the service is up but
      // is running a build that predates this list. "not found" would send
      // someone hunting for a bad URL instead of redeploying the Worker.
      if (res.status === 404) {
        throw new Error(`the sync service has no ${collection} route — update the service`);
      }
      if (!res.ok) throw new Error(body.error ?? `sync failed (${res.status})`);
      const incoming = Array.isArray(body[collection]) ? body[collection] : [];
      // Merge against storage as it is NOW, not the copy taken before the round
      // trip. A write that landed while this request was in flight is in storage
      // and in neither `before` nor `incoming`, so merging the stale copy erases
      // it -- silently, and only sometimes, which is the worst way to lose a
      // record. Walking a site is where this bites: every stop is a write, and
      // each one starts a sync that the next stop can outrun.
      const merged = merge(readAll(), incoming);
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
