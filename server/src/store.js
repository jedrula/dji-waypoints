// The sync half of the service: the same two lists the Cloudflare Worker
// keeps, with the same rules, on a disk instead of in KV.
//
// The record validation and the merge are IMPORTED from the Worker rather than
// copied. The Worker's own comment makes the case: a client that merges
// differently from the server is worse than one copy of a rule in two places,
// and that goes double for two servers. Those exports are pure -- no Cloudflare
// globals outside `fetch` -- so Node can just use them, and while both are
// running they cannot drift.

import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { merge, clean, cleanObstacle } from '../../sync/worker.js';

export const LISTS = {
  '/sync': { field: 'plans', prefix: 'ns', max: 500, maxBody: 64 * 1024, clean },
  '/obstacles': { field: 'obstacles', prefix: 'obs', max: 800, maxBody: 256 * 1024, clean: cleanObstacle },
};

// Same namespacing as the Worker: the key is a name, not a secret, but there is
// no reason for a directory listing to hand it over.
const nsOf = (key) => createHash('sha256').update(key).digest('hex');

export function createStore({ dir }) {
  // One write at a time per list, or two syncs landing together read the same
  // file, merge against the same stale copy, and the later write silently
  // drops whatever the earlier one added. KV made this atomic for free; a
  // filesystem does not.
  const locks = new Map();
  const serialise = (file, fn) => {
    const prev = locks.get(file) ?? Promise.resolve();
    const next = prev.then(fn, fn).finally(() => { if (locks.get(file) === next) locks.delete(file); });
    locks.set(file, next);
    return next;
  };

  const fileFor = (list, key) => path.join(dir, `${list.prefix}-${nsOf(key)}.json`);

  const read = async (file) => {
    try {
      const raw = JSON.parse(await readFile(file, 'utf8'));
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  };

  return {
    get: (list, key) => read(fileFor(list, key)),

    put(list, key, incoming) {
      const file = fileFor(list, key);
      return serialise(file, async () => {
        await mkdir(dir, { recursive: true });
        const stored = await read(file);
        const merged = merge(stored, incoming.map(list.clean).filter(Boolean), list.max);
        const tmp = `${file}.tmp`;
        await writeFile(tmp, JSON.stringify(merged));
        await rename(tmp, file);
        return merged;
      });
    },
  };
}
