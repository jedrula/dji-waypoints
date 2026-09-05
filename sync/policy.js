// What a stored list keeps, and what it is allowed to throw away.
//
// One rule, in one file, because three things apply it: the Worker, the Node
// service that speaks the same protocol, and the client that merges before it
// ever talks to either. A client that prunes differently from a server is how
// a record comes back from the dead, or fails to.
//
// The bug this exists to prevent, which was not hypothetical:
//
//   the list was capped at N records, sorted newest first, tombstones included.
//   Importing four hundred obstacles from OpenStreetMap and then clearing them
//   again leaves eight hundred entries, all of them newer than anything a
//   person placed by hand. Two rounds of that and the cap silently drops the
//   hand-placed ones off the end. Not deleted -- evicted, with no delete
//   anywhere and nothing to undo.
//
// So the cap applies to LIVE records only. A tombstone can never push out a
// real one; the dead are bounded separately and on their own terms.

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
