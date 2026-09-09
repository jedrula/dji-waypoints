// Buildings with walls in them.
//
// Everything else in this service is a 2.5D heightfield: one measured height
// per half-metre cell. That representation has no walls -- a building is a
// plateau, and the side of the plateau is a cliff one cell wide whose texture
// is the roof edge stretched downwards. Both viewers detect that cliff with a
// step heuristic and paint it as unknown, which is honest but is not a wall:
// measured over one crop of tile 725/724, 40% of what the heuristic marked had
// less than the 1.75 m of vertical extent that defines a wall.
//
// GUGiK also publishes the buildings as solids, in CityGML 2.0, built from the
// BDOT10k footprints and this same LiDAR, free and free to use. LoD1 is one
// prism per building -- true footprint, flat roof at the eaves height -- and
// covers the whole country. LoD2 adds the roof shape and covers ten
// voivodeships, not including Dolnoslaskie, so Wroclaw gets LoD1 and that is
// the reason this module asks for LoD1 by default.
//
// It is cheap in a way nothing else here is: the entire city of Wroclaw, all
// 63,090 buildings, is a 22 MB download. One LiDAR tile is 223 MB.
//
// What LoD1 is better at than the raster: the wall, which it has and the
// raster cannot. What it is worse at: the roof, which it flattens to the eaves
// and the raster measures. So this does not replace the surface, it stands in
// it -- see docs/2026-09-09-real-walls-not-smeared-ones.md.

import { readFile, writeFile } from 'node:fs/promises';
import { unzip } from '../../js/kmzread.js';
import { createDownloadCache } from './download.js';
import { TILE_M } from './ndsm.js';

const INDEX = 'https://integracja.gugik.gov.pl/cgi-bin/ModeleBudynkow3D';

// Which powiat package covers a point, and how to get it. Same shape of answer
// as bdot.js's findPackage and for the same reason: the only published way to
// resolve a coordinate to a package is a WMS whose GetFeatureInfo returns an
// HTML fragment with the download link in it.
//
// The two layers both advertise the whole country in GetCapabilities, which is
// the service envelope and not the coverage, so asking for lod2 outside those
// ten voivodeships succeeds and returns nothing. Measured 2026-09-09 with a
// 450 m GetMap: lod2 over Cybulskiego 22 came back a 700-byte blank, lod2 over
// Krakow's Rynek and lod1 over Cybulskiego both came back drawn.
export async function findPackage(east, north, { lod = 'lod1', fetchImpl = fetch, signal } = {}) {
  const url = `${INDEX}?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetFeatureInfo`
    + `&LAYERS=${lod}&QUERY_LAYERS=${lod}&CRS=EPSG:2180`
    + `&BBOX=${north - 500},${east - 500},${north + 500},${east + 500}`
    + `&WIDTH=101&HEIGHT=101&I=50&J=50&INFO_FORMAT=text/html`;
  const res = await fetchImpl(url, { signal });
  if (!res.ok) throw new Error(`Budynki3D index answered ${res.status}`);
  const html = await res.text();
  const zip = (html.match(/https?:\/\/[^"'<>\s]+\.zip/) ?? [])[0];
  if (!zip) return null;
  const cell = (name) => {
    const m = html.match(new RegExp(`<th>${name}</th>\\s*<td>([^<]*)<`));
    return m ? m[1].trim() : null;
  };
  return {
    url: zip,
    lod,
    teryt: cell('TERYT') ?? (zip.match(/(\d{4})_gml\.zip$/i) ?? [])[1] ?? '?',
    unit: cell('Jednostka'),
    count: Number(cell('Liczba budynków')) || null,
  };
}

// One prism per building, from one sheet of CityGML.
//
// The posList order is EASTING first. The srsName is a compound URN
// (EPSG::2180 + PL-KRON86-NH), and the authority axis order for EPSG:2180 is
// northing first, so reading the URN would have got this backwards. It was
// measured instead, against our own LiDAR over the 189 footprints whose
// centroid falls in tile 725/724:
//
//     first = NORTH   16% of centroids land on a LiDAR "building" cell,
//                     median |LoD1 roof - LiDAR surface| = 17.15 m
//     first = EAST    73%,  median 0.55 m
//
// That second number is worth more than the axis order it settled: the heights
// need no conversion. PL-KRON86-NH is the datum our own tile heights are in,
// and a median half-metre between a flattened LoD1 roof and the measured
// surface is the flattening, not a datum error.
//
// A LoD1 solid is a closed box: the first polygon is the footprint at ground
// level, then one quad per wall, then the roof. So the first ring is the
// footprint and there is nothing to reconstruct -- the walls are implied by two
// heights and the ring, which is exactly what js/prism.js wants.
export function parseBuildings(xml, box = null) {
  const out = [];
  for (const b of xml.match(/<bldg:Building\b[\s\S]*?<\/bldg:Building>/g) ?? []) {
    const lists = b.match(/<gml:posList>[^<]+<\/gml:posList>/g);
    if (!lists?.length) continue;

    const first = lists[0].replace(/<[^>]+>/g, '').trim().split(/\s+/).map(Number);
    const ring = [];
    let base = Infinity;
    for (let i = 0; i + 2 < first.length; i += 3) {
      ring.push([first[i], first[i + 1]]);
      base = Math.min(base, first[i + 2]);
    }
    // A GML ring repeats its first point to close itself; a footprint does not.
    if (ring.length > 1) {
      const a = ring[0]; const z = ring[ring.length - 1];
      if (a[0] === z[0] && a[1] === z[1]) ring.pop();
    }
    if (ring.length < 3) continue;

    let e0 = Infinity; let n0 = Infinity; let e1 = -Infinity; let n1 = -Infinity;
    for (const [e, n] of ring) {
      if (e < e0) e0 = e;
      if (e > e1) e1 = e;
      if (n < n0) n0 = n;
      if (n > n1) n1 = n;
    }
    // Overlap, not containment: a building on the edge of the box is exactly
    // the one an aircraft at the edge of the box can hit.
    if (box && (e1 < box.e0 || e0 > box.e1 || n1 < box.n0 || n0 > box.n1)) continue;

    let top = -Infinity;
    for (const l of lists) {
      const v = l.replace(/<[^>]+>/g, '').trim().split(/\s+/).map(Number);
      for (let i = 2; i < v.length; i += 3) if (v[i] > top) top = v[i];
    }
    if (!Number.isFinite(base) || !Number.isFinite(top) || top <= base) continue;

    out.push({
      id: (b.match(/gml:id="([^"]+)"/) ?? [])[1] ?? null,
      // Centimetres are the resolution of the source and of every other height
      // in this service; more decimal places would be decoration.
      ring: ring.map(([e, n]) => [+e.toFixed(2), +n.toFixed(2)]),
      base: +base.toFixed(2),
      top: +top.toFixed(2),
      roof: (b.match(/<bldg:roofType>([^<]+)</) ?? [])[1] ?? null,
    });
  }
  return out;
}

// Which sheets of a package can hold anything in the box.
//
// A package is one zip of ~69 sheets and several hundred megabytes inflated,
// so it is never inflated whole for a query: two sheets cover a 500 m tile.
// The sheet names are standard map-sheet codes and could be decoded to
// extents, but each sheet also carries its own gml:Envelope, which is the
// authority rather than a second implementation of the sheet grid.
//
// Reading those envelopes is the expensive part, because inflate has no way to
// stop after the first 4 KB: it costs one full inflate per sheet, measured at
// 560 ms and a 477 MB resident spike for Wroclaw. So the answer is written
// beside the zip and never computed twice. It is keyed on the same URL hash
// the zip is, so a package that changes its name gets a new file and a new
// index, and a stale one is not reachable.
async function sheetIndex(zipBytes) {
  const names = [];
  // The predicate is how unzip decides what to inflate, and returning false
  // for everything is how you get the names without paying for the data.
  await unzip(zipBytes, { only: (n) => { if (n.endsWith('.gml')) names.push(n); return false; } });

  const index = {};
  const dec = new TextDecoder();
  for (const name of names) {
    const one = await unzip(zipBytes, { only: (n) => n === name });
    const head = dec.decode(one.get(name).subarray(0, 4096));
    const m = head.match(/<gml:lowerCorner>([^<]+)<\/gml:lowerCorner>\s*<gml:upperCorner>([^<]+)</);
    if (!m) continue;
    const lo = m[1].trim().split(/\s+/).map(Number);
    const hi = m[2].trim().split(/\s+/).map(Number);
    index[name] = { e0: lo[0], n0: lo[1], e1: hi[0], n1: hi[1] };
  }
  return index;
}

export function createBuildingStore({ dir, fetchImpl = fetch }) {
  const cache = createDownloadCache({ dir, ext: '.zip', fetchImpl, what: 'Budynki3D' });
  // One powiat is one zip and one envelope index, and a session works in one
  // powiat. Kept in memory rather than on disk: rebuilding it is one inflate
  // per sheet of a file already on disk, and a stale index on disk is a bug
  // that outlives the process that wrote it.
  const indexes = new Map();
  const indexFile = (url) => `${cache.fileFor(url)}.sheets.json`;

  async function loadIndex(url, zipBytes) {
    try {
      return JSON.parse(await readFile(indexFile(url), 'utf8'));
    } catch { /* not built yet */ }
    const index = await sheetIndex(zipBytes);
    await writeFile(indexFile(url), JSON.stringify(index));
    return index;
  }

  // Every building standing over one scene tile, in tile-local metres, with
  // heights left in the datum they arrived in -- see the note on parseBuildings.
  async function buildingsFor(tn, te, { signal } = {}) {
    const e0 = te * TILE_M;
    const n0 = tn * TILE_M;
    const pkg = await findPackage(e0 + TILE_M / 2, n0 + TILE_M / 2, { fetchImpl, signal });
    if (!pkg) return { buildings: [], reason: 'no 3D building package covers this tile' };

    const { file, bytes } = await cache.get(pkg.url, { signal });
    const zipBytes = await readFile(file);
    if (!indexes.has(pkg.url)) indexes.set(pkg.url, await loadIndex(pkg.url, zipBytes));
    const index = indexes.get(pkg.url);

    const box = { e0, n0, e1: e0 + TILE_M, n1: n0 + TILE_M };
    const want = Object.keys(index).filter((name) => {
      const s = index[name];
      return !(s.e1 < box.e0 || s.e0 > box.e1 || s.n1 < box.n0 || s.n0 > box.n1);
    });
    if (!want.length) {
      return { buildings: [], powiat: pkg.teryt, unit: pkg.unit, bytes,
               reason: 'the package has no sheet over this tile' };
    }

    const sheets = await unzip(zipBytes, { only: (n) => want.includes(n) });
    const dec = new TextDecoder();
    const buildings = [];
    for (const [, buf] of sheets) {
      for (const b of parseBuildings(dec.decode(buf), box)) {
        buildings.push({
          ...b,
          ring: b.ring.map(([e, n]) => [+(e - e0).toFixed(2), +(n - n0).toFixed(2)]),
        });
      }
    }
    return { buildings, powiat: pkg.teryt, unit: pkg.unit, lod: pkg.lod,
             sheets: want.length, bytes };
  }

  return { buildingsFor };
}
