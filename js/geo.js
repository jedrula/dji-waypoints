// Local ENU (east/north, metres) frame around an origin. Good to a few cm over
// the few-hundred-metre areas a Mini-class drone actually surveys.

export function mPerDegLat(lat) {
  const p = (lat * Math.PI) / 180;
  return 111132.92 - 559.82 * Math.cos(2 * p) + 1.175 * Math.cos(4 * p) - 0.0023 * Math.cos(6 * p);
}

export function mPerDegLon(lat) {
  const p = (lat * Math.PI) / 180;
  return 111412.84 * Math.cos(p) - 93.5 * Math.cos(3 * p) + 0.118 * Math.cos(5 * p);
}

export function frame(lat0, lon0) {
  const kx = mPerDegLon(lat0);
  const ky = mPerDegLat(lat0);
  return {
    lat0,
    lon0,
    toLocal: (lat, lon) => ({ x: (lon - lon0) * kx, y: (lat - lat0) * ky }),
    toLatLon: (x, y) => ({ lat: lat0 + y / ky, lon: lon0 + x / kx }),
  };
}

const RAD = Math.PI / 180;

export function distM(a, b) {
  const R = 6371008.8;
  const dLat = (b.lat - a.lat) * RAD;
  const dLon = (b.lon - a.lon) * RAD;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

// Compass bearing a -> b, degrees in [-180, 180].
export function bearing(a, b) {
  const y = Math.sin((b.lon - a.lon) * RAD) * Math.cos(b.lat * RAD);
  const x =
    Math.cos(a.lat * RAD) * Math.sin(b.lat * RAD) -
    Math.sin(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.cos((b.lon - a.lon) * RAD);
  const d = Math.atan2(y, x) / RAD;
  return ((d + 540) % 360) - 180;
}
