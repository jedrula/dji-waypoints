// What is already standing here, from OpenStreetMap.
//
// Tapping every tree round a site is the sort of work a person gives up on
// halfway, and the things that actually kill a drone -- power lines -- are the
// ones you cannot see from above at all. OSM knows where they are.
//
// What it does NOT know is how tall they are. Measured over a chunk of Wroclaw:
// 83% of buildings carry a height or a storey count, 1.2% of trees do, and no
// tower or pole does. So this imports geometry with confidence and heights with
// a warning, and everything it invents is marked as invented -- see EST_PREFIX
// in js/site.js. A height guessed too low is not a bad photograph, it is a
// crash, and the app must never quietly claim to know one.

const OVERPASS = 'https://overpass-api.de/api/interpreter';

// Assumed heights, deliberately generous. Each is the top of the structure
// rather than the wire or the crown centre, because the number feeds a
// clearance check and the safe error is upward.
// The building figure was 9 m and it was invented. Measured against the LiDAR
// for a tile of Wroclaw -- 5.4 million classified points, 16 per square metre,
// heights taken above the local ground -- untagged buildings there run:
//
//     p50 16.2 m   p75 20.2 m   p90 24.3 m   p99 31.6 m   max 36.7 m
//
// and the building at Cybulskiego 22 is 29.3 m. Nine metres was wrong by
// fourteen in the median case and by twenty at the address, which is a plan
// flown into a wall with the check reporting it clear. It is p90 now: still a
// guess, but one on the safe side of most of what is actually there.
//
// The vegetation figure survived the same test almost exactly -- high veg came
// out at p50 17.6 m over the same site against an assumed 18 -- which is luck
// rather than judgement, and it is kept at p90 for the same reason.
export const ASSUMED = {
  tree: 20,             // measured p90 19.7 m over a Wroclaw tile
  building: 24,         // measured p90 24.3 m; the old 9 m was invented
  powerLow: 10,         // 400 V distribution on wooden poles
  powerMedium: 16,      // 15-30 kV
  powerHigh: 40,        // 110 kV lattice towers
  powerVeryHigh: 60,    // 220-400 kV
};

// A tree's crown, and how wide a box a power span gets. Neither is in OSM
// (0 of 9908 trees carried a crown diameter), so both are conventions.
const TREE_SPAN = 7;
const LINE_SPAN = 8;
// Spans are chopped into pieces so that a diagonal run does not become one
// enormous axis-aligned box: a 200 m diagonal would block a 200 m square.
const LINE_STEP = 25;

const M_PER_DEG_LAT = 111132;
const mPerDegLon = (lat) => 111320 * Math.cos((lat * Math.PI) / 180);

function boxAround(lat, lon, span) {
  const half = span / 2;
  return {
    north: lat + half / M_PER_DEG_LAT,
    south: lat - half / M_PER_DEG_LAT,
    east: lon + half / mPerDegLon(lat),
    west: lon - half / mPerDegLon(lat),
  };
}

// "12", "12 m", "12.5" -- and nothing else, because a height that cannot be
// read is worse than a height that is known to be missing.
function metres(v) {
  if (v === undefined || v === null) return null;
  const m = String(v).trim().match(/^(\d+(?:\.\d+)?)\s*m?$/i);
  return m ? Number(m[1]) : null;
}

function powerHeight(tags) {
  const v = Number(String(tags.voltage ?? '').split(/[;,]/)[0]) || 0;
  if (v >= 220000) return ASSUMED.powerVeryHigh;
  if (v >= 110000) return ASSUMED.powerHigh;
  if (v >= 1000) return ASSUMED.powerMedium;
  return tags.power === 'line' ? ASSUMED.powerHigh : ASSUMED.powerLow;
}

// A span cut into pieces of at most LINE_STEP, each becoming one box. Returns
// the boxes rather than the points, because the caller only wants obstacles.
function spanBoxes(geometry, span) {
  const out = [];
  for (let i = 1; i < geometry.length; i++) {
    const a = geometry[i - 1];
    const b = geometry[i];
    const dLat = (b.lat - a.lat) * M_PER_DEG_LAT;
    const dLon = (b.lon - a.lon) * mPerDegLon(a.lat);
    const len = Math.hypot(dLat, dLon);
    const steps = Math.max(1, Math.ceil(len / LINE_STEP));
    for (let k = 0; k < steps; k++) {
      const t = (k + 0.5) / steps;
      out.push(boxAround(a.lat + (b.lat - a.lat) * t, a.lon + (b.lon - a.lon) * t, span));
    }
  }
  return out;
}

function bboxOf(geometry, pad = 0) {
  const lats = geometry.map((g) => g.lat);
  const lons = geometry.map((g) => g.lon);
  const lat0 = (Math.min(...lats) + Math.max(...lats)) / 2;
  return {
    north: Math.max(...lats) + pad / M_PER_DEG_LAT,
    south: Math.min(...lats) - pad / M_PER_DEG_LAT,
    east: Math.max(...lons) + pad / mPerDegLon(lat0),
    west: Math.min(...lons) - pad / mPerDegLon(lat0),
  };
}

export function query(bounds) {
  const bbox = [bounds.south, bounds.west, bounds.north, bounds.east]
    .map((n) => n.toFixed(6)).join(',');
  return `[out:json][timeout:30];(`
    + `way["building"](${bbox});`
    + `node["natural"="tree"](${bbox});`
    + `way["power"~"^(line|minor_line)$"](${bbox});`
    + `);out tags geom;`;
}

// Elements to obstacle-shaped records: a rectangle, a height, a label, and
// whether the height was invented.
export function toObstacles(elements, { max = 400 } = {}) {
  const out = [];
  const push = (rect, height, label, assumed) => {
    if (out.length < max) out.push({ ...rect, height, label, assumed });
  };

  for (const e of elements) {
    const t = e.tags ?? {};
    if (t.building && e.geometry?.length) {
      const tagged = metres(t.height);
      const levels = Number(t['building:levels']);
      const h = tagged ?? (Number.isFinite(levels) && levels > 0 ? +(levels * 3.2).toFixed(1) : null);
      const label = [t['addr:street'], t['addr:housenumber']].filter(Boolean).join(' ')
        || (t.building === 'yes' ? 'Building' : t.building);
      push(bboxOf(e.geometry), h ?? ASSUMED.building, label, h === null);
    } else if (t.natural === 'tree' && Number.isFinite(e.lat)) {
      const h = metres(t.height);
      push(boxAround(e.lat, e.lon, TREE_SPAN), h ?? ASSUMED.tree,
        t.species || t.genus || 'Tree', h === null);
    } else if (/^(line|minor_line)$/.test(t.power ?? '') && e.geometry?.length > 1) {
      const h = powerHeight(t);
      const v = Number(String(t.voltage ?? '').split(/[;,]/)[0]) || 0;
      const label = v >= 1000 ? `${Math.round(v / 1000)} kV line` : 'Power line';
      // Every span is an assumed height: no tower or pole in the sample
      // carried one, and the sag between them is not in OSM at all.
      for (const rect of spanBoxes(e.geometry, LINE_SPAN)) push(rect, h, label, true);
    }
  }
  return out;
}

export async function fetchAround(bounds, { fetchImpl = globalThis.fetch, max } = {}) {
  const res = await fetchImpl(`${OVERPASS}?data=${encodeURIComponent(query(bounds))}`);
  if (!res.ok) throw new Error(`OpenStreetMap answered ${res.status}`);
  const body = await res.json();
  return toObstacles(body.elements ?? [], { max });
}
