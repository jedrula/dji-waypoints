// EPSG:2180, the projection every GUGiK service speaks.
//
// The one thing to keep straight: this returns {east, north}, and the services
// want them the other way round -- BBOX is north,east and so are the GML
// corners that come back. At Wroclaw both are about 362000, so getting it
// backwards returns plausible neighbouring tiles that contain everything
// except your point, and nothing anywhere says you got it wrong.

const A = 6378137.0;
const F = 1 / 298.257222101;
const E2 = F * (2 - F);
const K0 = 0.9993;
const LON0 = (19 * Math.PI) / 180;

export function toPuwg92(lat, lon) {
  const p = (lat * Math.PI) / 180;
  const l = (lon * Math.PI) / 180;
  const ep2 = E2 / (1 - E2);
  const N = A / Math.sqrt(1 - E2 * Math.sin(p) ** 2);
  const T = Math.tan(p) ** 2;
  const C = ep2 * Math.cos(p) ** 2;
  const a = (l - LON0) * Math.cos(p);
  const M = A * (
    (1 - E2 / 4 - (3 * E2 ** 2) / 64 - (5 * E2 ** 3) / 256) * p
    - ((3 * E2) / 8 + (3 * E2 ** 2) / 32 + (45 * E2 ** 3) / 1024) * Math.sin(2 * p)
    + ((15 * E2 ** 2) / 256 + (45 * E2 ** 3) / 1024) * Math.sin(4 * p)
    - ((35 * E2 ** 3) / 3072) * Math.sin(6 * p)
  );
  const east = 500000 + K0 * N * (
    a + ((1 - T + C) * a ** 3) / 6
    + ((5 - 18 * T + T * T + 72 * C - 58 * ep2) * a ** 5) / 120
  );
  const north = -5300000 + K0 * (M + N * Math.tan(p) * (
    (a * a) / 2
    + ((5 - T + 9 * C + 4 * C * C) * a ** 4) / 24
    + ((61 - 58 * T + T * T + 600 * C - 330 * ep2) * a ** 6) / 720
  ));
  return { east, north };
}

// Only the inverse the API needs: a tile's corner back to lat/lon, so a
// response can say where it actually is without the client redoing the maths.
export const toWgs84 = (east, north) =>
  tmToWgs84(east, north, { lon0: LON0, k0: K0, fe: 500000, fn: -5300000 });

// Poland uses TWO grids and this app now meets both. EPSG:2180 is one zone over
// the whole country, which is why every GUGiK service speaks it; PL-2000 is
// four narrow zones and is what the photogrammetric mesh models arrive in. Same
// projection on the same ellipsoid, different constants -- so the maths is
// written once and parameterised, rather than pasted with three numbers changed.
function tmToWgs84(east, north, { lon0, k0, fe, fn }) {
  const ep2 = E2 / (1 - E2);
  const m = (north - fn) / k0;
  const mu = m / (A * (1 - E2 / 4 - (3 * E2 ** 2) / 64 - (5 * E2 ** 3) / 256));
  const e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
  const p1 = mu
    + ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu)
    + ((21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu)
    + ((151 * e1 ** 3) / 96) * Math.sin(6 * mu);
  const C1 = ep2 * Math.cos(p1) ** 2;
  const T1 = Math.tan(p1) ** 2;
  const N1 = A / Math.sqrt(1 - E2 * Math.sin(p1) ** 2);
  const R1 = (A * (1 - E2)) / (1 - E2 * Math.sin(p1) ** 2) ** 1.5;
  const d = (east - fe) / (N1 * k0);
  const lat = p1 - ((N1 * Math.tan(p1)) / R1) * (
    (d * d) / 2
    - ((5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * d ** 4) / 24
    + ((61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * d ** 6) / 720
  );
  const lon = lon0 + (
    d - ((1 + 2 * T1 + C1) * d ** 3) / 6
    + ((5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * d ** 5) / 120
  ) / Math.cos(p1);
  return { lat: (lat * 180) / Math.PI, lon: (lon * 180) / Math.PI };
}

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
