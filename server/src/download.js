// One big file from GUGiK, kept once.
//
// Three of these had grown by 2026-09-09 -- the LAZ store in gugik.js, the
// BDOT10k package store in bdot.js, and a third about to appear in
// buildings.js -- and they were the same twenty lines every time, differing
// only in a file extension and the wording of an error. That is the point at
// which a third copy is not allowed, so here it is once.
//
// The two properties worth keeping are both about failure. A half-downloaded
// file that looks complete is a cache poisoned until somebody deletes it by
// hand, so the write goes to `.part` and is renamed only when the stream ends.
// And two requests for the same cold tile arriving together used to fetch it
// twice, hundreds of megabytes each, so the in-flight promise is shared.

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, stat, rename, readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';

// Keyed on the URL, not on anything we know about the URL: these come out of
// national index services, and the day one of them changes its file naming is
// not the day we want a stale cache.
const inFlight = new Map();

export function createDownloadCache({ dir, ext, fetchImpl = fetch, what = 'GUGiK' }) {
  const fileFor = (url) => path.join(dir, `${createHash('sha1').update(url).digest('hex')}${ext}`);

  async function get(url, { signal } = {}) {
    const file = fileFor(url);
    try {
      const s = await stat(file);
      if (s.size > 0) return { file, bytes: s.size, cached: true };
    } catch { /* not cached */ }

    if (inFlight.has(file)) return inFlight.get(file);
    const job = (async () => {
      await mkdir(dir, { recursive: true });
      const res = await fetchImpl(url, { signal });
      if (!res.ok) throw new Error(`${what} returned ${res.status} for ${url}`);
      const tmp = `${file}.part`;
      await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
      await rename(tmp, file);
      return { file, bytes: (await stat(file)).size, cached: false };
    })().finally(() => inFlight.delete(file));
    inFlight.set(file, job);
    return job;
  }

  return { get, fileFor, read: (url) => readFile(fileFor(url)) };
}
