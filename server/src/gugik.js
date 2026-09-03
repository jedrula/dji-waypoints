// Finding and fetching the LiDAR that covers a patch of Poland.
//
// GUGiK publishes the raw point cloud free and unrestricted, and it is the
// right source despite being the heaviest one. The derived surface model
// (NMPT) looked like the easy answer and is not: it does not cover Wroclaw at
// all, and where it does exist a single sheet is 122 MB of ASCII text -- more
// than the LAZ, for the same ground. So: point cloud, once per tile, cached
// forever, because a 2024 survey is not going to change its mind.

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, stat, rename, readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';

const WFS = 'https://mapy.geoportal.gov.pl/wss/service/PZGIK/'
  + 'DanePomiaroweLidarEVRF2007/WFS/Skorowidze';

// Newest first: a 2024 survey beats a 2018 one over the same ground.
const YEARS = [2026, 2025, 2024, 2023, 2022, 2021, 2020, 2019, 2018];

const num = (s) => s.trim().split(/\s+/).map(Number);
const tag = (xml, name) => (xml.match(new RegExp(`<gugik:${name}>([^<]+)<`)) || [])[1];

// One index query per year until a year yields tiles overlapping the box.
// `east`/`north` bounds are PUWG92 metres.
export async function findTiles({ e0, n0, e1, n1 }, { fetchImpl = fetch, signal } = {}) {
  for (const year of YEARS) {
    // BBOX is north,east -- see puwg92.js. The URN form is what pins the axis
    // order; drop it and the server picks, which is how this goes wrong.
    const bbox = `${n0},${e0},${n1},${e1},urn:ogc:def:crs:EPSG::2180`;
    const url = `${WFS}?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature`
      + `&TYPENAMES=gugik:SkorowidzDanychPomiarowychLIDAR${year}`
      + `&COUNT=200&BBOX=${encodeURIComponent(bbox)}`;
    let xml;
    try {
      const res = await fetchImpl(url, { signal });
      if (!res.ok) continue;
      xml = await res.text();
    } catch {
      continue;
    }

    const found = [];
    for (const member of xml.split('<wfs:member>').slice(1)) {
      const lower = (member.match(/<gml:lowerCorner>([^<]+)</) || [])[1];
      const upper = (member.match(/<gml:upperCorner>([^<]+)</) || [])[1];
      const href = tag(member, 'url_do_pobrania');
      const crs = tag(member, 'uklad_xy') || '';
      if (!lower || !upper || !href) continue;
      // The index is always PUWG92, but the LAZ carries whatever system the
      // survey was flown in, and newer ones are PL-2000 zones -- where an
      // easting starts with the zone number, 6432800 rather than 362800.
      // Reading one of those as PUWG92 puts every point in the Baltic and
      // the tile looks empty. Until the reader reprojects, skip them.
      if (!crs.includes('PL-1992')) continue;
      const [tn0, te0] = num(lower);
      const [tn1, te1] = num(upper);
      if (te0 > e1 || te1 < e0 || tn0 > n1 || tn1 < n0) continue;
      found.push({
        year, url: href, crs,
        density: tag(member, 'char_przestrz') || '?',
        bounds: { e0: te0, n0: tn0, e1: te1, n1: tn1 },
      });
    }
    if (found.length) return found;
  }
  return [];
}

// Downloads are the slow, rude part: tens of megabytes each, from a public
// agency doing us a favour. Every one is written once and kept, and a download
// already in flight is joined rather than started again.
const inFlight = new Map();

export function createTileStore({ dir, fetchImpl = fetch }) {
  const fileFor = (url) => path.join(dir, `${createHash('sha1').update(url).digest('hex')}.laz`);

  async function fetchLaz(url, { signal } = {}) {
    const file = fileFor(url);
    try {
      const s = await stat(file);
      if (s.size > 0) return { file, bytes: s.size, cached: true };
    } catch { /* not cached */ }

    if (inFlight.has(file)) return inFlight.get(file);
    const job = (async () => {
      await mkdir(dir, { recursive: true });
      const res = await fetchImpl(url, { signal });
      if (!res.ok) throw new Error(`GUGiK returned ${res.status} for ${url}`);
      // Write to a temporary name and rename: a half-downloaded file that
      // looks complete is a cache poisoned until someone deletes it by hand.
      const tmp = `${file}.part`;
      await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
      await rename(tmp, file);
      const s = await stat(file);
      return { file, bytes: s.size, cached: false };
    })().finally(() => inFlight.delete(file));
    inFlight.set(file, job);
    return job;
  }

  return { fetchLaz, read: (url) => readFile(fileFor(url)) };
}
