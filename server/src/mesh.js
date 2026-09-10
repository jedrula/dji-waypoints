// The photogrammetric mesh: a building with its own walls, and its own pixels
// on them.
//
// Everything else this service ships is 2.5D -- one height per cell, with a
// nadir photograph draped over it -- and a nadir photograph has no pixels for a
// vertical face. That is why both viewers mark walls as unknown, and why
// src/buildings.js exists to say where they are. This is the other thing
// entirely: GUGiK's mesh models are real 3D geometry matched from OBLIQUE
// aerial imagery, textured with the views that actually saw the facade.
//
// Measured over Cybulskiego 22, one tile:
//
//     100 x 101 m of ground        242,050 vertices, 480,764 faces
//     25.5 MB zipped               77 MB open (68 MB OBJ + 8.8 MB JPEG)
//     0.05 m source imagery        0.09 m in position, 0.28 m in height
//     flown 2025-03-20             newer than the LiDAR under it
//
// Two things make it awkward and both are handled here rather than in the
// browser. It arrives as Wavefront OBJ, which is 68 MB of ASCII for something
// that is 6 MB of numbers; and it is in PL-2000 zone 6, not the PUWG92 every
// other thing here speaks. So the service downloads once, keeps the zip, and
// serves a packed binary already in PUWG92 metres.
//
// Weight, for the record: 25.5 MB per hundred metres is ~638 MB per square
// kilometre, half again the LAZ's ~424. It is the heaviest thing here per unit
// ground, which is why nothing fetches it speculatively.

import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { unzip } from '../../js/kmzread.js';
import { createDownloadCache } from './download.js';
import { pl2000ToWgs84, toPuwg92 } from '../../js/puwg92.js';

const INDEX = 'https://mapy.geoportal.gov.pl/wss/service/PZGIK/NMT/WMS/ModeleSiatkowe3D';

// Which mesh tile covers a point, and where to get it.
//
// The same shape of answer as bdot.js and buildings.js, and the same reason:
// the only published way to resolve a coordinate to a package is a WMS whose
// GetFeatureInfo returns a page with the link in it. This one is worse than
// most -- the payload is a block of JavaScript that would build a table if a
// browser ran it -- so what is parsed is the object literal inside it rather
// than any markup.
export async function findMesh(east, north, { fetchImpl = fetch, signal } = {}) {
  const url = `${INDEX}?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetFeatureInfo`
    + '&LAYERS=SkorowidzeModeleSiatkowe3D&QUERY_LAYERS=SkorowidzeModeleSiatkowe3D'
    + `&CRS=EPSG:2180&BBOX=${north - 500},${east - 500},${north + 500},${east + 500}`
    + '&WIDTH=101&HEIGHT=101&I=50&J=50&INFO_FORMAT=text/html&FEATURE_COUNT=5';
  const res = await fetchImpl(url, { signal });
  if (!res.ok) throw new Error(`mesh index answered ${res.status}`);
  return pickMesh(await res.text());
}

// The index hands back several editions of the same ground when it has them;
// newest wins, the same rule src/gugik.js uses for the LiDAR.
export function pickMesh(html) {
  const found = [];
  for (const m of html.matchAll(/skor_modele_siatkowe_3D\.push\(\{([^}]*)\}\)/g)) {
    const field = (name) => (m[1].match(new RegExp(`${name}:"([^"]*)"`)) ?? [])[1] ?? null;
    const url = field('url');
    if (!url) continue;
    found.push({
      url,
      tile: field('modul'),
      flown: field('aktualnosc'),
      format: field('format'),
      gsd: field('charPrzestrzZrDanych'),
      errorXY: Number(field('bladSredniPolozenia')) || null,
      errorZ: Number(field('bladSredniWysokosci')) || null,
      crs: field('ukladWspolrzednychPoziomych'),
      vertical: field('ukladWspolrzednychPionowych'),
    });
  }
  if (!found.length) return null;
  found.sort((a, b) => String(b.flown).localeCompare(String(a.flown)));
  // Only OBJ is read here. The index has carried other formats in the past and
  // a mesh nobody can parse is worse than none, because it looks like coverage.
  return found.find((f) => (f.format ?? '').toUpperCase() === 'OBJ') ?? null;
}

// Wavefront OBJ into flat arrays, reprojected on the way through.
//
// Written as a single pass over the text because the file is 68 MB and holding
// a parsed representation as JS objects costs more than the file does. Only
// three record types matter: `v` a vertex, `vt` a texture coordinate, and `f` a
// face. Normals are ignored -- they are recomputed from the geometry, which is
// smaller than shipping them.
//
// OBJ indices are ONE-BASED, and may be negative to mean "counting back from
// here". Both are handled; getting either wrong yields a mesh that is subtly
// scrambled rather than obviously broken.
//
// A face can have more than three corners, so each is fanned into triangles.
export function parseObj(text, { toLocal }) {
  const vx = [];
  const vy = [];
  const vz = [];
  const tu = [];
  const tv = [];
  const idx = [];
  // Vertices arrive interleaved with faces in some writers, so the mapping from
  // OBJ vertex to output vertex is built as they are read.
  let n = 0;

  for (let at = 0; at < text.length;) {
    let end = text.indexOf('\n', at);
    if (end < 0) end = text.length;
    const line = text.slice(at, end);
    at = end + 1;
    if (line.length < 2) continue;
    const c0 = line.charCodeAt(0);

    if (c0 === 118 /* v */) {
      const c1 = line.charCodeAt(1);
      if (c1 === 32) {
        const a = line.split(/\s+/);
        const p = toLocal(+a[1], +a[2]);
        vx.push(p.x);
        vy.push(p.y);
        vz.push(+a[3]);
        n++;
      } else if (c1 === 116 /* vt */) {
        const a = line.split(/\s+/);
        tu.push(+a[1]);
        tv.push(+a[2]);
      }
    } else if (c0 === 102 /* f */) {
      const a = line.split(/\s+/);
      const corner = [];
      for (let i = 1; i < a.length; i++) {
        if (!a[i]) continue;
        const bits = a[i].split('/');
        let vi = Number(bits[0]);
        let ti = bits[1] ? Number(bits[1]) : 0;
        if (vi < 0) vi = n + 1 + vi;
        if (ti < 0) ti = tu.length + 1 + ti;
        corner.push([vi - 1, ti - 1]);
      }
      for (let i = 2; i < corner.length; i++) {
        idx.push(corner[0], corner[i - 1], corner[i]);
      }
    }
  }

  // One output vertex per (position, texture coordinate) pair, because a corner
  // of a building carries one position and several UVs and a GPU cannot share
  // that. Keyed on the pair, so a vertex used with one UV is not duplicated.
  const seen = new Map();
  const pos = [];
  const uv = [];
  const tri = new Uint32Array(idx.length);
  for (let i = 0; i < idx.length; i++) {
    const [vi, ti] = idx[i];
    const key = `${vi}|${ti}`;
    let out = seen.get(key);
    if (out === undefined) {
      out = pos.length / 3;
      seen.set(key, out);
      pos.push(vx[vi], vz[vi], -vy[vi]);      // three.js is y-up, z south
      uv.push(ti >= 0 ? tu[ti] : 0, ti >= 0 ? tv[ti] : 0);
    }
    tri[i] = out;
  }
  return {
    position: Float32Array.from(pos),
    uv: Float32Array.from(uv),
    index: tri,
    vertices: pos.length / 3,
    triangles: tri.length / 3,
  };
}

export function createMeshStore({ dir, fetchImpl = fetch }) {
  const cache = createDownloadCache({ dir, ext: '.zip', fetchImpl, what: 'Mesh3D' });

  // One mesh tile, in metres from the PUWG92 point given, ready to draw.
  //
  // The origin is passed in rather than baked so the numbers stay small: raw
  // PL-2000 eastings are seven digits, and a float32 holding 6432022.5 has
  // about half a metre of precision left, which would quantise a facade
  // measured to nine centimetres. It travels in the response, so a cached
  // pack can be served to a request from somewhere else in the same tile --
  // see packedAt, and the client honours it rather than assuming its own
  // request point.
  async function meshAt(lat, lon, { signal, found: already = null } = {}) {
    const { east, north } = toPuwg92(lat, lon);
    const found = already ?? await findMesh(east, north, { fetchImpl, signal });
    if (!found) return null;

    const { file, bytes } = await cache.get(found.url, { signal });
    const entries = await unzip(await readFile(file), {
      only: (nm) => nm.toLowerCase().endsWith('.obj') || nm.toLowerCase().endsWith('.jpg'),
    });
    const objName = [...entries.keys()].find((nm) => nm.toLowerCase().endsWith('.obj'));
    const jpgName = [...entries.keys()].find((nm) => nm.toLowerCase().endsWith('.jpg'));
    if (!objName) throw new Error('the package holds no OBJ');

    const toLocal = (x, y) => {
      const g = pl2000ToWgs84(x, y);
      const p = toPuwg92(g.lat, g.lon);
      return { x: p.east - east, y: p.north - north };
    };
    const geom = parseObj(new TextDecoder().decode(entries.get(objName)), { toLocal });

    return {
      geom,
      texture: jpgName ? entries.get(jpgName) : null,
      info: { ...found, bytes, origin: { east, north } },
    };
  }

  // The same tile, packed the way the browser wants it, kept on disk.
  //
  // This is the difference between a click that works and one that looks
  // broken. Measured against the local service over Cybulskiego 22:
  //
  //     first request     9.38 s to the first byte   unzip 25 MB, parse 68 MB OBJ
  //     same tile again   0.24 s                     but only while it was the
  //                                                  ONE tile held in memory
  //     from this cache   0.27 s                     a file read, plus the WMS
  //                                                  index lookup that is most
  //                                                  of what is left
  //
  // Anything that asked for a second tile evicted the first, so revisiting a
  // site paid the ten seconds again for every square -- and the client, which
  // now restores the tiles you had last time, paid it per tile in a row. The
  // pack is what the route sends: gzipped body, texture, and the meta that
  // goes in the headers, keyed by the package URL because that is what the
  // national index calls this tile.
  //
  // Weight on disk: 7.6 MB of gzipped geometry plus 8.8 of JPEG per tile, on
  // top of the 25.5 MB zip we already keep. No eviction here either -- see the
  // note on var/ in docs/2026-09-08-hosting-the-service.md.
  async function packedAt(lat, lon, { signal } = {}) {
    const { east, north } = toPuwg92(lat, lon);
    const found = await findMesh(east, north, { fetchImpl, signal });
    if (!found) return null;
    const stem = path.join(dir, `pack-${createHash('sha1').update(found.url).digest('hex')}`);

    try {
      const [body, meta] = await Promise.all([
        readFile(`${stem}.bin`),
        readFile(`${stem}.json`, 'utf8').then(JSON.parse),
      ]);
      const texture = meta.texture ? await readFile(`${stem}.jpg`).catch(() => null) : null;
      return { body, texture, meta, cached: true };
    } catch { /* not packed yet */ }

    const got = await meshAt(lat, lon, { signal, found });
    if (!got) return null;
    const { geom, texture, info } = got;
    // Two counts, then position, then uv, then index -- a buffer that
    // describes itself, so nothing about it lives only in a header.
    const head = new Uint32Array([geom.vertices, geom.triangles]);
    const body = gzipSync(Buffer.concat([
      Buffer.from(head.buffer),
      Buffer.from(geom.position.buffer, geom.position.byteOffset, geom.position.byteLength),
      Buffer.from(geom.uv.buffer, geom.uv.byteOffset, geom.uv.byteLength),
      Buffer.from(geom.index.buffer, geom.index.byteOffset, geom.index.byteLength),
    ]), { level: 6 });
    const meta = {
      vertices: geom.vertices, triangles: geom.triangles, texture: Boolean(texture), ...info,
    };

    // Written through a .part and renamed, the same rule src/download.js
    // follows: a half-written pack that looks complete is a cache poisoned
    // until somebody deletes it by hand.
    await mkdir(dir, { recursive: true });
    await writeFile(`${stem}.bin.part`, body);
    await rename(`${stem}.bin.part`, `${stem}.bin`);
    if (texture) {
      await writeFile(`${stem}.jpg.part`, Buffer.from(texture));
      await rename(`${stem}.jpg.part`, `${stem}.jpg`);
    }
    await writeFile(`${stem}.json.part`, JSON.stringify(meta));
    await rename(`${stem}.json.part`, `${stem}.json`);

    return { body, texture: texture ? Buffer.from(texture) : null, meta, cached: false };
  }

  return { meshAt, packedAt };
}
