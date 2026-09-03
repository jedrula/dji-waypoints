import { toPuwg92, inPoland } from './puwg92.js';
// How the ground itself moves under a site.
//
// Every height in this app is above the TAKEOFF POINT, because that is what a
// DJI mission means by altitude -- the aircraft holds one barometric height for
// the whole flight and knows nothing about the hill it is crossing. On flat
// ground that is the same as height above the ground. On a slope it is not, and
// the app has never been able to say so.
//
// It is not a small effect. Measured over 200 m sites: a Wroclaw block rises
// 3.4 m, a river bluff at Kazimierz 29.8 m, a Zakopane hillside 129.7 m. Take
// off at the bottom of that last one, fly at "40 m", and you are ninety metres
// BELOW the top of your own site.
//
// Poland's mapping agency answers this for free, point by point, with CORS open
// -- so the browser can ask directly. Outside Poland it cannot, which the
// caller has to cope with rather than pretend otherwise.

const NMT = 'https://services.gugik.gov.pl/nmt/';

// EPSG:2180, "PUWG 1992": transverse Mercator on GRS80, central meridian 19E,
// scale 0.9993, false easting 500000, false northing -5300000. The service
// takes x as NORTHING and y as EASTING -- the Polish convention, and the
// opposite of the guess. Checked against Kasprowy Wierch, which comes back at
// 1980.7 m one way round and 0 the other.
// Roughly the bounding box of Poland. Asking outside it wastes a round trip and
// gets an answer that looks like sea level rather than like "I do not know".
export { toPuwg92, inPoland };

async function heightAt(lat, lon, fetchImpl) {
  const p = toPuwg92(lat, lon);
  const res = await fetchImpl(`${NMT}?request=GetHByXY&x=${p.north.toFixed(2)}&y=${p.east.toFixed(2)}`);
  if (!res.ok) return null;
  const v = Number((await res.text()).trim());
  // The service answers 0 for "off the edge of the data" as readily as for sea
  // level, and a false zero on a hillside is the dangerous direction.
  return Number.isFinite(v) && v !== 0 ? v : null;
}

// A grid over the site. `n` is per side, so 5 is 25 requests -- which came back
// in well under half a second when measured, and is plenty to catch a slope.
export async function sampleTerrain(bounds, { n = 5, fetchImpl = globalThis.fetch } = {}) {
  const mid = { lat: (bounds.north + bounds.south) / 2, lon: (bounds.east + bounds.west) / 2 };
  if (!inPoland(mid.lat, mid.lon)) return null;

  const pts = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      pts.push({
        lat: bounds.south + ((bounds.north - bounds.south) * i) / (n - 1),
        lon: bounds.west + ((bounds.east - bounds.west) * j) / (n - 1),
      });
    }
  }
  const heights = await Promise.all(pts.map((q) => heightAt(q.lat, q.lon, fetchImpl).catch(() => null)));
  const got = heights.map((h, k) => (h === null ? null : { ...pts[k], h })).filter(Boolean);
  // A handful of holes is fine; mostly holes means this is not Poland after all.
  if (got.length < pts.length * 0.6) return null;

  const hs = got.map((q) => q.h);
  const low = Math.min(...hs);
  const high = Math.max(...hs);
  return {
    low,
    high,
    relief: high - low,
    samples: got,
    highest: got.find((q) => q.h === high),
  };
}

// What the terrain does to a flight that holds one height above its takeoff
// point. Positive `shortfall` means the aircraft is BELOW ground somewhere.
export function verdict(terrain, { takeoffAt, altitude, clearance = 5 }) {
  if (!terrain) return null;
  const base = Number.isFinite(takeoffAt) ? takeoffAt : terrain.low;
  const flying = base + altitude;
  const shortfall = terrain.high + clearance - flying;
  return {
    relief: terrain.relief,
    base,
    aboveHighestGround: flying - terrain.high,
    shortfall: shortfall > 0 ? shortfall : 0,
    // The altitude that would clear the highest ground by the clearance.
    needed: Math.ceil(terrain.high + clearance - base),
  };
}
