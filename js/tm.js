// Transverse Mercator, once.
//
// Every grid this app reads is one: EPSG:2180 and PL-2000 in Poland, and since
// 2026-11-03 UTM zone 32, which is what Italy's TINITALY terrain model is
// stored in (see js/terrain.js). Same projection, different constants -- so the
// series are written here and each grid is a parameter set, rather than a copy
// of these thirty lines with four numbers changed. They used to live in
// js/puwg92.js, which is where Poland's two grids still get their constants.
//
// Accuracy: these are the usual Snyder series, which are why zones are narrow.
// Measured 2026-11-03 against PROJ 9 (pyproj 3.7.2), EPSG:4326 -> EPSG:32632,
// on a half-degree lattice over Italy:
//
//   off the meridian   forward, worst     forward then inverse, worst
//   up to 4 deg        0.33 mm            1.3 mm
//   up to 6.6 deg      11 mm              94 mm      (Sicily's east coast)
//   up to 9.6 deg      0.16 m             1.3 m      (the heel of Italy)
//
// So the FORWARD direction holds to centimetres across the whole of Italy and
// the inverse does not; anything that has to be right goes lat/lon -> grid.

export const GRS80_F = 1 / 298.257222101;
export const WGS84_F = 1 / 298.257223563;
const A = 6378137.0;

// `{ lon0 (radians), k0, fe, fn, f }` -> { east, north } in metres.
export function tmFromWgs84(lat, lon, { lon0, k0, fe, fn, f = GRS80_F }) {
  const E2 = f * (2 - f);
  const p = (lat * Math.PI) / 180;
  const l = (lon * Math.PI) / 180;
  const ep2 = E2 / (1 - E2);
  const N = A / Math.sqrt(1 - E2 * Math.sin(p) ** 2);
  const T = Math.tan(p) ** 2;
  const C = ep2 * Math.cos(p) ** 2;
  const a = (l - lon0) * Math.cos(p);
  const M = A * (
    (1 - E2 / 4 - (3 * E2 ** 2) / 64 - (5 * E2 ** 3) / 256) * p
    - ((3 * E2) / 8 + (3 * E2 ** 2) / 32 + (45 * E2 ** 3) / 1024) * Math.sin(2 * p)
    + ((15 * E2 ** 2) / 256 + (45 * E2 ** 3) / 1024) * Math.sin(4 * p)
    - ((35 * E2 ** 3) / 3072) * Math.sin(6 * p)
  );
  const east = fe + k0 * N * (
    a + ((1 - T + C) * a ** 3) / 6
    + ((5 - 18 * T + T * T + 72 * C - 58 * ep2) * a ** 5) / 120
  );
  const north = fn + k0 * (M + N * Math.tan(p) * (
    (a * a) / 2
    + ((5 - T + 9 * C + 4 * C * C) * a ** 4) / 24
    + ((61 - 58 * T + T * T + 600 * C - 330 * ep2) * a ** 6) / 720
  ));
  return { east, north };
}

export function tmToWgs84(east, north, { lon0, k0, fe, fn, f = GRS80_F }) {
  const E2 = f * (2 - f);
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
