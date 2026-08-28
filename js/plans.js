// Saved plans, local first. Every plan is a name plus the ~200 character code
// from share.js, so the whole library fits in localStorage and works with no
// server at all. Sync sits on top and needs no setting up: every device runs
// under one hardcoded key, so a plan saved on the phone is on the Mac already.
//
// The local-first list, the merge and the round trip are the same ones the
// obstacle list uses and live in synced.js; what is left here is what a plan
// record actually is.

import { createSyncedStore, merge, SYNC_KEY, SYNC_URL } from './synced.js';

export { merge, SYNC_KEY, SYNC_URL };

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
