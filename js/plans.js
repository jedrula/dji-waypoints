// Saved plans, local first. Every plan is a name plus the ~200 character code
// from share.js, so the whole library fits in localStorage and works with no
// server at all. Sync sits on top: the key this device made up (js/service.js)
// names the library, and copying it into a second device is what puts a plan
// saved on the phone onto the Mac.
//
// The local-first list, the merge and the round trip are the same ones the
// obstacle list uses and live in synced.js; what is left here is what a plan
// record actually is.

import { createSyncedStore, merge } from './synced.js';

export { merge };

export function createPlanStore({ storage, fetchImpl, endpoint } = {}) {
  const base = createSyncedStore({
    collection: 'plans',
    path: '/sync',
    storageKey: 'dji.plans',
    shape: ({ name, code }) => ({ name: String(name).slice(0, 80), code }),
    storage, fetchImpl, endpoint,
  });

  return {
    list: base.list,
    save: ({ id, name, code }) => base.put({ id, name, code }),
    remove: base.remove,
    endpoint: base.endpoint,
    sync: base.sync,
  };
}

// How a capture is named, and therefore how one is recognised.
//
// A site bigger than one battery is several missions, and nothing in the record
// says which belong together -- deliberately, because adding a field to a
// record two devices sync is the one change this repo has to be careful with
// (see the `local: isImported` note in js/obstacles.js). So the group is the
// part of the NAME before the first "·", which is how these already get
// written: "Staszica · B1 nadir 36 m".
//
// It lives here rather than in either pane because BOTH read it: the library
// groups its rows by it and the Fly pane installs a whole group in one go. Two
// copies of this rule would be two answers to "what is a capture".
export const GROUP_SEP = '·';

export function groupOf(name) {
  const at = String(name ?? '').indexOf(GROUP_SEP);
  if (at < 0) return null;
  const head = name.slice(0, at).trim();
  const rest = name.slice(at + GROUP_SEP.length).trim();
  return head && rest ? { head, rest } : null;
}

// Plans bucketed into captures, newest bucket first, and by name inside one --
// which is flight order, because that is what B1/B2/B3 sort into. A group of
// one is not a group: it comes back with `head: null` so a pane can draw it as
// a plain row under its whole name.
export function groupPlans(plans) {
  const buckets = new Map();
  for (const p of plans) {
    const g = groupOf(p.name);
    const key = g ? g.head : `\u0000${p.id}`;
    if (!buckets.has(key)) buckets.set(key, { head: g?.head ?? null, members: [] });
    buckets.get(key).members.push(p);
  }
  const out = [];
  for (const { head, members } of buckets.values()) {
    if (head && members.length > 1) {
      members.sort((a, b) => String(a.name).localeCompare(String(b.name)));
      out.push({ head, members });
    } else {
      for (const p of members) out.push({ head: null, members: [p] });
    }
  }
  return out;
}
