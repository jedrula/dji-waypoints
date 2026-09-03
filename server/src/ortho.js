// The colour half of the model.
//
// GUGiK's orthophoto is open, national, and at 25 cm a pixel over Wroclaw --
// sharp enough to read individual cars. One 500 m tile is a megabyte of JPEG,
// which is nothing next to the 192 MB of point cloud underneath it.
//
// It is a NADIR photograph, which is the same limitation the LiDAR has and for
// the same reason: it sees roofs and ground, and it does not see walls. The
// two datasets are blind in exactly the same direction, which is why the model
// they make together is an init and not an answer.

import { mkdir, stat, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { TILE_M } from './ndsm.js';

const WMS = 'https://mapy.geoportal.gov.pl/wss/service/PZGIK/ORTO/WMS/HighResolution';
export const ORTHO_PX = 2048;               // ~24 cm per pixel over a 500 m tile
// Below this the response carries no detail and is not a photograph of
// anything. See the note in fetchOrtho.
const BLANK_BYTES_PER_PX = 0.06;

const inFlight = new Map();

export function createOrthoStore({ dir, fetchImpl = fetch }) {
  const fileFor = (tn, te) => path.join(dir, `${tn}_${te}.jpg`);

  return {
    fileFor,
    async fetchOrtho(tn, te, { signal } = {}) {
      const file = fileFor(tn, te);
      try {
        const s = await stat(file);
        if (s.size > 0) return { file, bytes: s.size, cached: true };
      } catch { /* not cached */ }
      if (inFlight.has(file)) return inFlight.get(file);

      const job = (async () => {
        await mkdir(dir, { recursive: true });
        const e0 = te * TILE_M;
        const n0 = tn * TILE_M;
        // WMS 1.3.0 with EPSG:2180 takes BBOX as north,east -- the same axis
        // order as everything else GUGiK serves, and the same trap.
        const url = `${WMS}?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=Raster&STYLES=`
          + `&CRS=EPSG:2180&BBOX=${n0},${e0},${n0 + TILE_M},${e0 + TILE_M}`
          + `&WIDTH=${ORTHO_PX}&HEIGHT=${ORTHO_PX}&FORMAT=image/jpeg`;
        const res = await fetchImpl(url, { signal });
        if (!res.ok) throw new Error(`orthophoto service answered ${res.status}`);
        const type = res.headers.get('content-type') ?? '';
        const body = Buffer.from(await res.arrayBuffer());
        // A WMS reports failure as a perfectly valid XML document with a 200,
        // and an XML file written to ortho.jpg is a grey tile nobody can
        // explain later.
        if (!type.startsWith('image/')) {
          throw new Error(`orthophoto service returned ${type || 'no content type'}`);
        }
        // "HighResolution" advertises the whole country and covers the towns.
        // Ask it for a forest in Zachodniopomorskie and it returns a perfectly
        // valid JPEG that is blank white -- JPEG has no alpha, so no-data is
        // indistinguishable from snow. Stored, that becomes a tile whose photo
        // silently washes the entire model out.
        //
        // A blank JPEG compresses to almost nothing. Over Wroclaw this is
        // 0.24 bytes per pixel; the blank one from Dominikowo is 0.027. It is
        // a heuristic, and it only has to be right about the difference
        // between a photograph and an empty rectangle.
        const perPixel = body.length / (ORTHO_PX * ORTHO_PX);
        if (perPixel < BLANK_BYTES_PER_PX) {
          const err = new Error('no orthophoto coverage here');
          err.blank = true;
          throw err;
        }
        const tmp = `${file}.part`;
        await writeFile(tmp, body);
        await rename(tmp, file);
        return { file, bytes: body.length, cached: false };
      })().finally(() => inFlight.delete(file));
      inFlight.set(file, job);
      return job;
    },
  };
}
