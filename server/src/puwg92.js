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
export function toWgs84(east, north) {
  const ep2 = E2 / (1 - E2);
  const m = (north + 5300000) / K0;
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
  const d = (east - 500000) / (N1 * K0);
  const lat = p1 - ((N1 * Math.tan(p1)) / R1) * (
    (d * d) / 2
    - ((5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * d ** 4) / 24
    + ((61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * d ** 6) / 720
  );
  const lon = LON0 + (
    d - ((1 + 2 * T1 + C1) * d ** 3) / 6
    + ((5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * d ** 5) / 120
  ) / Math.cos(p1);
  return { lat: (lat * 180) / Math.PI, lon: (lon * 180) / Math.PI };
}

// Poland's PUWG92 envelope, give or take. Cheap way to answer "we have nothing
// for you" without asking GUGiK.
export const inPoland = (lat, lon) => lat > 48.9 && lat < 55.0 && lon > 14.0 && lon < 24.2;
