// The sync half of the service: the two lists this app keeps -- the plans you
// saved and the obstacles you drew -- on a disk.
//
// The record validation and the merge are IMPORTED from sync/protocol.js rather
// than written again here. A client that merges differently from a server is
// how a record comes back from the dead, and the browser applies the same rule
// before it ever talks to this.
//
// There was a Cloudflare Worker doing this job, and for a while both ran. It is
// gone: this service already spoke its protocol byte for byte, so keeping a
// second implementation of the same two routes bought nothing but a second
// place for the rules to drift.

import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { merge, clean, cleanObstacle } from '../../sync/protocol.js';

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
