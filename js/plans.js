// Saved plans, local first. Every plan is a name plus the ~200 character code
// from share.js, so the whole library fits in localStorage and works with no
// server at all. Sync sits on top and needs no setting up: every device runs
// under one hardcoded key, so a plan saved on the phone is on the Mac already.
//
// Storage and fetch are injected so this runs under node in the test suite --
// the merge is the part worth testing, and it is the same merge the Worker runs.

const PLANS = 'dji.plans';
const URL_OVERRIDE = 'dji.syncUrl';

// The whole of "logging in", until there is anything to log in to. One person,
// two devices, one key, compiled into the app -- which means it is as public as
// the app is, and anyone reading this file can read and write the plan list.
// That is the trade for having no key to copy between devices, and it holds
// only while a plan list is the sort of thing worth nobody's trouble. A real
// login replaces this constant with an account id; nothing else changes.
export const SYNC_KEY = 'andrzej-H5rGhCrCRmPXoRSFUA8etg';

// Set by `wrangler deploy` (see sync/README.md). Empty would mean local-only,
// which is still a perfectly good way to use the app.
export const SYNC_URL = 'https://dji-waypoints-sync.andrzej-swaton.workers.dev';

const now = () => Date.now();

function id() {
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
  for (const p of [...a, ...b]) {
    const prev = by.get(p.id);
    if (!prev || p.updatedAt >= prev.updatedAt) by.set(p.id, p);
  }
  return [...by.values()].sort((x, y) => y.updatedAt - x.updatedAt);
}

// Every write on a device gets a timestamp strictly later than every write
// before it. Date.now() alone is not enough: two saves inside one millisecond
// tie, and a tie is indistinguishable from no change -- the second save loses
// silently, and the list stops being ordered by when you saved.
function stamp(plans) {
  const latest = plans.reduce((max, p) => Math.max(max, p.updatedAt ?? 0), 0);
  return Math.max(now(), latest + 1);
}

export function createPlanStore({ storage, fetchImpl, endpoint } = {}) {
  const store = storage ?? globalThis.localStorage;
  const http = fetchImpl ?? globalThis.fetch?.bind(globalThis);

  const readAll = () => {
    try {
      const raw = JSON.parse(store.getItem(PLANS) ?? '[]');
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  };
  const writeAll = (plans) => store.setItem(PLANS, JSON.stringify(plans));

  const url = () => endpoint ?? store.getItem(URL_OVERRIDE) ?? SYNC_URL;

  return {
    // Tombstones are storage, not list entries.
    list: () => readAll().filter((p) => !p.deleted),

    save({ id: existing, name, code }) {
      const plans = readAll();
      const plan = { id: existing ?? id(), name: String(name).slice(0, 80), code, updatedAt: stamp(plans) };
      writeAll(merge(plans, [plan]));
      return plan;
    },

    remove(planId) {
      const plans = readAll();
      writeAll(merge(plans, [{ id: planId, deleted: true, updatedAt: stamp(plans) }]));
    },

    endpoint: url,

    // One round trip: send everything, get the union back. No cursors, no
    // conflict prompts -- with one person and two devices, whichever edit
    // happened later is the one meant.
    async sync() {
      const to = url();
      if (!to) throw new Error('no sync service configured');
      const before = readAll();
      const res = await http(`${to.replace(/\/$/, '')}/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Sync-Key': SYNC_KEY },
        body: JSON.stringify({ plans: before }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `sync failed (${res.status})`);
      const merged = merge(before, Array.isArray(body.plans) ? body.plans : []);
      writeAll(merged);
      // Count only what a person can see: a tombstone arriving from the other
      // device is a real change, but reporting it as "1 new plan" is a lie.
      const seen = new Set(before.map((p) => `${p.id}:${p.updatedAt}`));
      return { total: merged.filter((p) => !p.deleted).length,
               pulled: merged.filter((p) => !p.deleted && !seen.has(`${p.id}:${p.updatedAt}`)).length };
    },
  };
}
