// GUGiK's terrain model, for LOOKING at a place: Mnich to Morskie Oko is 1.4 km
// and the survey's 0.5 m LiDAR stops at 1.2 km -- and widening it is dozens of
// 500 m tiles at ~220 MB and minutes each. The national DTM (NMT) is the same
// LiDAR already gridded, served over WCS, and resampled by the server to 5 m a
// 3 km square is 600 x 600 cells: 5.9 MB, 51 s cold (measured 2026-11-04 at
// Mnich). Bare earth, so this is scenery for the flat 3D view and nothing
// judges a flight by it -- in Poland the survey does that.
//
// Proxied rather than asked by the browser because GUGiK sends no CORS header
// (checked 2026-11-04), and cached because 51 s is not something to pay twice.
//
// The answer arrives as multipart/related even for a plain GetCoverage; the
// grid is the part after the first blank line.

import { readFile } from 'node:fs/promises';
import { createDownloadCache } from './download.js';

const WCS = 'https://mapy.geoportal.gov.pl/wss/service/PZGIK/NMT/GRID1/WCS/DigitalTerrainModel';
// EVRF2007, the datum the newer LiDAR is in -- see gugik.js for the older one.
const COVERAGE = 'DTM_PL-EVRF2007-NH';
export const DTM_CELL = 5;
export const DTM_MAX_SIDE = 4000;

// PUWG92 metres, snapped outward to whole cells; null if it is not a box this
// will ask GUGiK for.
export function dtmBox({ e0, n0, e1, n1 }) {
  if (![e0, n0, e1, n1].every(Number.isFinite)) return null;
  const box = {
    e0: Math.floor(e0 / DTM_CELL) * DTM_CELL, n0: Math.floor(n0 / DTM_CELL) * DTM_CELL,
    e1: Math.ceil(e1 / DTM_CELL) * DTM_CELL, n1: Math.ceil(n1 / DTM_CELL) * DTM_CELL,
  };
  if (box.e1 <= box.e0 || box.n1 <= box.n0) return null;
  if (box.e1 - box.e0 > DTM_MAX_SIDE || box.n1 - box.n0 > DTM_MAX_SIDE) return null;
  return box;
}

// x is easting and y northing here, unlike the WFS BBOX in gugik.js -- checked
// against the answer's own xllcorner.
export const dtmUrl = (b) => `${WCS}?SERVICE=WCS&VERSION=2.0.1&REQUEST=GetCoverage`
  + `&COVERAGEID=${COVERAGE}&FORMAT=image/x-aaigrid`
  + `&SUBSET=x(${b.e0},${b.e1})&SUBSET=y(${b.n0},${b.n1})&SCALEFACTOR=${1 / DTM_CELL}`;

export function unwrapGrid(text) {
  if (!text.trimStart().startsWith('--')) return text;
  const start = text.search(/\r?\n\r?\n/);
  if (start < 0) throw new Error('multipart answer with no body');
  const body = text.slice(start).replace(/^\s+/, '');
  const end = body.search(/\r?\n--[^\r\n]*\s*$/);
  return end < 0 ? body : body.slice(0, end);
}

export function createDtmStore({ dir, fetchImpl = fetch }) {
  const cache = createDownloadCache({ dir, ext: '.asc', fetchImpl, what: 'GUGiK NMT' });
  return {
    async grid(box, { signal } = {}) {
      const { file } = await cache.get(dtmUrl(box), { signal });
      const text = unwrapGrid(await readFile(file, 'utf8'));
      if (!/^\s*ncols/i.test(text)) throw new Error('GUGiK answered with something that is not a grid');
      return text;
    },
  };
}
