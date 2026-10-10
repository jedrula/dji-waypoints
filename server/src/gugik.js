// Finding and fetching the LiDAR that covers a patch of Poland.
//
// GUGiK publishes the raw point cloud free and unrestricted, and it is the
// right source despite being the heaviest one. The derived surface model
// (NMPT) looked like the easy answer and is not: it does not cover Wroclaw at
// all, and where it does exist a single sheet is 122 MB of ASCII text -- more
// than the LAZ, for the same ground. So: point cloud, once per tile, cached
// forever, because a 2024 survey is not going to change its mind.

import { createDownloadCache } from './download.js';
import { insideRing } from '../../js/prism.js';

const WFS = 'https://mapy.geoportal.gov.pl/wss/service/PZGIK/'
  + 'DanePomiaroweLidarEVRF2007/WFS/Skorowidze';

// Newest first: a 2024 survey beats a 2018 one over the same ground.
const YEARS = [2026, 2025, 2024, 2023, 2022, 2021, 2020, 2019, 2018];

const num = (s) => s.trim().split(/\s+/).map(Number);
const tag = (xml, name) => (xml.match(new RegExp(`<gugik:${name}>([^<]+)<`)) || [])[1];

// Newest year first, and older years only for what the newer left uncovered.
// This stopped at the first year with ANY sheet in the box, so a box on the
// edge of a 2025 survey got the 2025 half and nothing for the other half,
// though 2023 covered it. Coverage is judged on a grid of points over the box
// against each sheet's own outline -- PL-2000 sheets sit rotated about a
// degree in PUWG92, and their envelope overstates them by a sliver.
// `east`/`north` bounds are PUWG92 metres.
const GRID_N = 8;
export async function findTiles({ e0, n0, e1, n1 }, { fetchImpl = fetch, signal } = {}) {
  let open = [];
  for (let i = 0; i < GRID_N; i++) {
    for (let j = 0; j < GRID_N; j++) {
      open.push({ x: e0 + ((i + 0.5) / GRID_N) * (e1 - e0), y: n0 + ((j + 0.5) / GRID_N) * (n1 - n0) });
    }
  }
  const chosen = [];
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
      // survey was flown in: PUWG92, or for the newer ones a PL-2000 zone,
      // which laz.js moves into PUWG92 as it reads. Anything else is skipped:
      // read as PUWG92 it puts every point in the Baltic.
      if (!crs.includes('PL-1992') && !crs.includes('PL-2000')) continue;
      const [tn0, te0] = num(lower);
      const [tn1, te1] = num(upper);
      if (te0 > e1 || te1 < e0 || tn0 > n1 || tn1 < n0) continue;
      const godlo = tag(member, 'godlo') ?? href;
      const flown = (member.match(/akt_data[^>]*><gml:timePosition>([^<]+)</) || [])[1] ?? '';
      // One sheet can be flown twice in a year: Wroclaw's 6.149.12.23.2 has a
      // March 2025 flight (leaves off) and an August one. Both at once double
      // every point and drape bare branches through the canopy, so keep the
      // later -- leaf-on, like the summer photograph it is drawn under.
      const twin = found.findIndex((f) => f.godlo === godlo);
      if (twin >= 0) {
        if (found[twin].flown >= flown) continue;
        found.splice(twin, 1);
      }
      const pos = (member.match(/<gml:posList[^>]*>([^<]+)</) || [])[1];
      const nums = pos ? num(pos) : [];
      const ring = [];
      for (let k = 0; k + 1 < nums.length; k += 2) ring.push({ x: nums[k + 1], y: nums[k] });
      found.push({
        year, url: href, crs, godlo, flown,
        density: tag(member, 'char_przestrz') || '?',
        bounds: { e0: te0, n0: tn0, e1: te1, n1: tn1 },
        ring: ring.length >= 3 ? ring
          : [{ x: te0, y: tn0 }, { x: te1, y: tn0 }, { x: te1, y: tn1 }, { x: te0, y: tn1 }],
      });
    }
    // Within a year: the later flight, then the denser -- Gdansk's 2022 has a
    // 12 per m2 PUWG92 sheet and a 40 per m2 PL-2000 one over the same ground.
    found.sort((a, b) => b.flown.localeCompare(a.flown) || parseFloat(b.density) - parseFloat(a.density));
    for (const f of found) {
      if (!open.some((p) => insideRing(p, f.ring))) continue;
      chosen.push(f);
      open = open.filter((p) => !insideRing(p, f.ring));
    }
    if (!open.length) break;
  }
  return chosen;
}

// Downloads are the slow, rude part: tens of megabytes each, from a public
// agency doing us a favour. Every one is written once and kept, and a download
// already in flight is joined rather than started again -- see src/download.js.

export function createTileStore({ dir, fetchImpl = fetch }) {
  // See src/download.js: the write-then-rename and the shared in-flight
  // promise used to live here, and in bdot.js, and were about to live in
  // buildings.js too.
  const cache = createDownloadCache({ dir, ext: '.laz', fetchImpl, what: 'GUGiK' });
  return { fetchLaz: cache.get, read: cache.read };
}
