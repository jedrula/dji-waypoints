// Where the wires are.
//
// This is the one thing the LiDAR could not tell us. ASPRS reserves classes for
// conductors and no Polish tile uses them; a detector built on the geometry of
// the returns finds roof ridges and bare branches instead (tools/wire-spike.mjs).
// GESUT, the register that ought to have them, is partial by powiat and carries
// no heights.
//
// BDOT10k does. It is the national topographic database, free, downloadable as
// GML per powiat, and OT_SULN_L is overhead utility lines as plain polylines
// with a voltage class -- 2,208 of them in one rural powiat. It still has no
// heights, so a span gets the assumed height its voltage implies, the same way
// the OpenStreetMap importer already does it. But where they run is the half
// that was missing, and it is the half you cannot guess.

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, stat, rename, readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { unzip } from '../../js/kmzread.js';
import { ASSUMED } from '../../js/osm.js';
import { TILE_M } from './ndsm.js';
import { clipSegment } from '../../js/shape.js';

const INDEX = 'https://mapy.geoportal.gov.pl/wss/service/PZGIK/BDOT/WMS/PobieranieBDOT10k';

// The BDOT10k voltage classes, and what each one stands on. `rodzaj` is the
// readable one; x_kod agrees with it and is kept for the label.
export const LINE_KIND = {
  WN:    { label: 'high voltage line',   height: ASSUMED.powerHigh },
  SN:    { label: 'medium voltage line', height: ASSUMED.powerMedium },
  'n/n': { label: 'low voltage line',    height: ASSUMED.powerLow },
  LTK:   { label: 'telecom line',        height: ASSUMED.powerLow },
};
const UNKNOWN = { label: 'overhead line', height: ASSUMED.powerMedium };

// A little beyond the tile, so a span reads as arriving from somewhere rather
// than starting at the edge. Counter-clockwise, which is what clipSegment wants.
const MARGIN = 25;
const BOX = [
  { x: -MARGIN, y: -MARGIN },
  { x: TILE_M + MARGIN, y: -MARGIN },
  { x: TILE_M + MARGIN, y: TILE_M + MARGIN },
  { x: -MARGIN, y: TILE_M + MARGIN },
];

// Which powiat package covers a point. The index is a WMS whose GetFeatureInfo
// returns an HTML fragment with the download links in it -- not elegant, and
// the only published way to resolve a coordinate to a package.
export async function findPackage(east, north, { fetchImpl = fetch } = {}) {
  const url = `${INDEX}?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetFeatureInfo`
    + `&LAYERS=Powiaty&QUERY_LAYERS=Powiaty&CRS=EPSG:2180`
    + `&BBOX=${north - 500},${east - 500},${north + 500},${east + 500}`
    + `&WIDTH=101&HEIGHT=101&I=50&J=50&INFO_FORMAT=text/html&FEATURE_COUNT=5`;
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`BDOT10k index answered ${res.status}`);
  const html = await res.text();
  // Prefer the plain GML package; the schema2021 variants are the same data.
  const links = [...html.matchAll(/https?:\/\/[^"'<>\s]+_GML\.zip/g)].map((m) => m[0]);
  const plain = links.find((u) => !u.includes('schemat')) ?? links[0];
  if (!plain) return null;
  return { url: plain, powiat: (plain.match(/(\d{4})_GML\.zip$/) ?? [])[1] ?? '?' };
}

const inFlight = new Map();

export function createBdotStore({ dir, fetchImpl = fetch }) {
  const fileFor = (url) => path.join(dir, `${createHash('sha1').update(url).digest('hex')}.zip`);

  async function fetchPackage(url) {
    const file = fileFor(url);
    try {
      const s = await stat(file);
      if (s.size > 0) return { file, bytes: s.size, cached: true };
    } catch { /* not cached */ }
    if (inFlight.has(file)) return inFlight.get(file);
    const job = (async () => {
      await mkdir(dir, { recursive: true });
      const res = await fetchImpl(url);
      if (!res.ok) throw new Error(`BDOT10k download answered ${res.status}`);
      const tmp = `${file}.part`;
      await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
      await rename(tmp, file);
      return { file, bytes: (await stat(file)).size, cached: false };
    })().finally(() => inFlight.delete(file));
    inFlight.set(file, job);
    return job;
  }

  // Every overhead line crossing one scene tile, in tile-local metres.
  async function linesFor(tn, te) {
    const e0 = te * TILE_M;
    const n0 = tn * TILE_M;
    const pkg = await findPackage(e0 + TILE_M / 2, n0 + TILE_M / 2, { fetchImpl });
    if (!pkg) return { lines: [], reason: 'no BDOT10k package covers this tile' };

    const { file, bytes } = await fetchPackage(pkg.url);
    const entries = await unzip(await readFile(file), { only: (n) => n.endsWith('OT_SULN_L.xml') });
    const xml = [...entries.values()].map((b) => new TextDecoder().decode(b)).join('');
    if (!xml) return { lines: [], reason: 'the package has no overhead-line layer', powiat: pkg.powiat };

    const lines = [];
    for (const f of xml.match(/<ot:OT_SULN_L\b[\s\S]*?<\/ot:OT_SULN_L>/g) ?? []) {
      const rodzaj = (f.match(/<ot:rodzaj>([^<]+)</) ?? [])[1] ?? '?';
      const kod = (f.match(/<ot:x_kod>([^<]+)</) ?? [])[1] ?? '?';
      // One feature can carry several segments; each is its own run of wire.
      for (const seg of f.match(/<gml:posList>[^<]+<\/gml:posList>/g) ?? []) {
        const v = seg.replace(/<[^>]+>/g, '').trim().split(/\s+/).map(Number);
        const pts = [];
        for (let i = 0; i + 1 < v.length; i += 2) pts.push([v[i] - e0, v[i + 1] - n0]);
        // A SULN feature is a whole run of line, often kilometres of it. Kept
        // whole it draws off to the horizon and out of the model it belongs to,
        // so each segment is clipped to the tile and the surviving pieces
        // become their own runs. MARGIN lets a span enter from outside, which
        // is how you can tell which way it is going.
        const kind = LINE_KIND[rodzaj] ?? UNKNOWN;
        let run = [];
        const flush = () => {
          if (run.length > 1) {
            lines.push({ kind: rodzaj, kod, label: kind.label, height: kind.height,
              points: run.map(([x, y]) => [+x.toFixed(1), +y.toFixed(1)]) });
          }
          run = [];
        };
        for (let i = 1; i < pts.length; i++) {
          const a = { x: pts[i - 1][0], y: pts[i - 1][1] };
          const b = { x: pts[i][0], y: pts[i][1] };
          const seg = clipSegment(BOX, a, b);
          if (!seg) { flush(); continue; }
          const [c, d] = seg;
          // Continue the run when this piece starts where the last one ended.
          const last = run[run.length - 1];
          if (!last || Math.hypot(last[0] - c.x, last[1] - c.y) > 0.5) { flush(); run.push([c.x, c.y]); }
          run.push([d.x, d.y]);
        }
        flush();
      }
    }
    return { lines, powiat: pkg.powiat, packageBytes: bytes, source: 'BDOT10k OT_SULN_L' };
  }

  return { fetchPackage, linesFor };
}
