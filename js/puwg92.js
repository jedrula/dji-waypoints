// EPSG:2180, the projection every GUGiK service speaks.
//
// The one thing to keep straight: this returns {east, north}, and the services
// want them the other way round -- BBOX is north,east and so are the GML
// corners that come back. At Wroclaw both are about 362000, so getting it
// backwards returns plausible neighbouring tiles that contain everything
// except your point, and nothing anywhere says you got it wrong.

import { tmFromWgs84, tmToWgs84 } from './tm.js';

// GRS80, which tm.js defaults to.
const PUWG92 = { lon0: (19 * Math.PI) / 180, k0: 0.9993, fe: 500000, fn: -5300000 };

export const toPuwg92 = (lat, lon) => tmFromWgs84(lat, lon, PUWG92);

// Only the inverse the API needs: a tile's corner back to lat/lon, so a
// response can say where it actually is without the client redoing the maths.
//
// Poland uses TWO grids and this app now meets both. EPSG:2180 is one zone over
// the whole country, which is why every GUGiK service speaks it; PL-2000 is
// four narrow zones and is what the photogrammetric mesh models arrive in. Same
// projection on the same ellipsoid, different constants -- the series are in
// js/tm.js, written once for every grid the app reads.
export const toWgs84 = (east, north) => tmToWgs84(east, north, PUWG92);

// PL-2000, the grid the 3D mesh models come in -- EPSG:2176 to 2179 for zones
// 5 to 8. Four belts three degrees wide, each with its own central meridian at
// 15, 18, 21 and 24 east, a scale factor of 0.999923, and a false easting that
// CARRIES THE ZONE NUMBER: 5500000, 6500000, 7500000, 8500000. That prefix is
// the only thing saying which belt a coordinate belongs to, so it is read back
// out of the easting rather than passed in.
//
// Wroclaw is zone 6. A mesh vertex at x 6432022 is 6432022 - 6500000 = 68 km
// west of the 18th meridian, which lands on 17.03 east -- Cybulskiego.
export function pl2000ToWgs84(x, y) {
  const zone = Math.floor(x / 1000000);
  if (zone < 5 || zone > 8) throw new Error(`not a PL-2000 easting: ${x}`);
  return tmToWgs84(x, y, {
    lon0: (zone * 3 * Math.PI) / 180,
    k0: 0.999923,
    fe: zone * 1000000 + 500000,
    fn: 0,
  });
}

// Poland's PUWG92 envelope, give or take. Cheap way to answer "we have nothing
// for you" without asking GUGiK.
export const inPoland = (lat, lon) => lat > 48.9 && lat < 55.0 && lon > 13.9 && lon < 24.2;
