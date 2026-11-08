// The ground outside Poland: Italy's TINITALY terrain model.
//
// Every altitude in this app is above the takeoff point, because that is what
// a DJI mission means by altitude -- one barometric height, held, with no idea
// what the hill is doing. In Poland the survey answers that (js/scene3d.js
// builds the ground from GUGiK's LiDAR and checks every leg against it).
// Everywhere else nothing did, and the first place anyone asked about was a
// 530 m limestone headland above San Vito lo Capo, where a mission planned
// from the takeoff point flies into the rock the moment it crosses the slope.
//
// TINITALY 1.1 (INGV, CC BY 4.0, https://doi.org/10.13127/tinitaly/1.1) is a
// 10 m bare-earth model of the whole of Italy, served over WCS with CORS open,
// so the browser asks it directly the way it once asked GUGiK, with no proxy
// and no key. Asked in its NATIVE grid -- UTM 32 on WGS84, EPSG:32632 -- and
// not in lat/lon, because the server will happily reproject for you and
// resample on the way: a peak cell averaged with its neighbours is a summit
// reported lower than it is, which is the dangerous direction. Native cells
// are the model's own numbers, and the plain-text answer is an ESRI ASCII grid
// that needs no TIFF reader.
//
// Measured at Pizzo Monaco, 2026-11-03: the summit cell reads 530.8 m at
// 38.16718 N 12.75680 E, and the steepest step between two neighbouring cells
// on its east face is 62.3 m -- over ten metres of ground. That is a cliff, and
// it is the case this exists for.
//
// WHAT THIS DOES NOT KNOW, so it never paints a leg clear:
//   - trees and buildings. Bare earth. A leg that misses the ground can still
//     go through a pine, so only strikes are reported; everything else is
//     "not judged", never green.
//   - the model's own error. INGV publish a vertical accuracy for TINITALY,
//     but it has not been measured here against anything, and on a cliff a
//     10 m cell is a smear by construction. The clearance you set has to
//     carry it.
//   - where you actually take off. Like the survey, heights are measured from
//     the ground under the FIRST waypoint of the flight. Take off somewhere
//     else on a mountain and every number moves by the difference.

import { tmFromWgs84, tmToWgs84, WGS84_F, GRS80_F } from './tm.js';
import { inPoland } from './puwg92.js';

export const WCS = 'https://tinitaly.pi.ingv.it/TINItaly_1_1/wcs';
const COVERAGE_ID = 'TINItaly_1_1__tinitaly_dem';
const CELL = 10;

// EPSG:32632. Italy spans zones 32 and 33 and TINITALY is stored entirely in
// 32 -- Sicily's east coast is 6.6 degrees off its meridian, which is past
// where a zone is meant to be used. Only the forward direction is needed, and
// that one is within 11 mm of PROJ out there (see js/tm.js for the table).
const UTM32 = { lon0: (9 * Math.PI) / 180, k0: 0.9996, fe: 500000, fn: 0, f: WGS84_F };
export const toUtm32 = (lat, lon) => tmFromWgs84(lat, lon, UTM32);

// The coverage's own envelope, from DescribeCoverage. A rectangle around
// Italy, so most of it is sea and neighbours that come back as NODATA -- that
// is handled cell by cell. This is only to avoid asking about Poland, which
// zone 32's rectangle also contains.
const ENVELOPE = { e0: 312500, n0: 3930000, e1: 1320000, n1: 5222500 };

// Far enough to fetch: 4 km on a side is 160,000 cells and about 3 MB of
// text. A site is a few hundred metres; anything past this is not a mission
// this app plans.
const MAX_SIDE_M = 4000;

export function covers(lat, lon) {
  if (inPoland(lat, lon)) return false;
  const { east, north } = toUtm32(lat, lon);
  return east > ENVELOPE.e0 && east < ENVELOPE.e1 && north > ENVELOPE.n0 && north < ENVELOPE.n1;
}

// ESRI ASCII grid -> { cols, rows, e0, n0, cell, z }. Row 0 is the NORTH edge,
// as the format writes it; e0/n0 are the south-west CORNER, not a cell centre.
// NODATA becomes NaN, which nothing downstream reads as ground.
export function parseAsciiGrid(text) {
  const head = {};
  let at = 0;
  const lines = text.split('\n');
  for (; at < lines.length; at++) {
    const m = /^\s*([A-Za-z_]+)\s+(\S+)\s*$/.exec(lines[at]);
    if (!m) break;
    head[m[1].toLowerCase()] = Number(m[2]);
  }
  const cols = head.ncols;
  const rows = head.nrows;
  const cell = head.cellsize;
  if (!(cols > 0 && rows > 0 && cell > 0)) throw new Error('not an ASCII grid');
  // Corner or centre registration; TINITALY sends corners, but a centre header
  // is half a cell off and that is enough to move a cliff edge.
  const e0 = head.xllcorner ?? head.xllcenter - cell / 2;
  const n0 = head.yllcorner ?? head.yllcenter - cell / 2;
  const nodata = head.nodata_value;
  const z = new Float32Array(cols * rows);
  let k = 0;
  for (; at < lines.length && k < z.length; at++) {
    for (const tok of lines[at].trim().split(/\s+/)) {
      if (!tok) continue;
      const v = Number(tok);
      z[k++] = v === nodata || !Number.isFinite(v) ? NaN : v;
    }
  }
  if (k !== z.length) throw new Error(`ASCII grid short: ${k} of ${z.length} cells`);
  return { cols, rows, e0, n0, cell, z, toGrid: toUtm32 };
}

// Where a point falls in a grid's own coordinates. Each grid carries its
// projection, because Sicily's is in zone 33 and TINITALY's in zone 32, and a
// grid read in the other one's metres is 500 km out. A grid built by hand
// without one is TINITALY's, which is what every such grid in the tests is.
const gridXY = (g, lat, lon) => (g.toGrid ?? toUtm32)(lat, lon);

// A lat/lon box, widened by `margin` metres, as a native-grid request snapped
// OUTWARD to whole cells, so the box asked for is never smaller than the box
// wanted.
export function requestFor(bounds, margin) {
  const corners = [
    toUtm32(bounds.south, bounds.west), toUtm32(bounds.south, bounds.east),
    toUtm32(bounds.north, bounds.west), toUtm32(bounds.north, bounds.east),
  ];
  const e = corners.map((c) => c.east);
  const n = corners.map((c) => c.north);
  const box = {
    e0: Math.floor((Math.min(...e) - margin) / CELL) * CELL,
    n0: Math.floor((Math.min(...n) - margin) / CELL) * CELL,
    e1: Math.ceil((Math.max(...e) + margin) / CELL) * CELL,
    n1: Math.ceil((Math.max(...n) + margin) / CELL) * CELL,
  };
  if (box.e1 - box.e0 > MAX_SIDE_M || box.n1 - box.n0 > MAX_SIDE_M) return null;
  const url = `${WCS}?service=WCS&version=2.0.1&request=GetCoverage&coverageId=${COVERAGE_ID}`
    + `&subset=E(${box.e0},${box.e1})&subset=N(${box.n0},${box.n1})&format=text/plain`;
  return { box, url };
}

// Sicily's own terrain model, five times finer.
//
// TINITALY does not have Capo Calava. Measured 2026-11-08: at 38.19197 N
// 14.91550 E the headland is 118.8 m, and TINITALY's 10 m cells there climb
// as a smooth ramp from 0 to 60 m with no rock in it -- the planner read 18.5
// m, a hundred metres under the ground, which is the direction that flies a
// plan into a cliff. Over the whole headland, on slopes past 60 degrees, this
// model stands more than 10 m above TINITALY's reading on 54% of cells.
//
// mdt_2013 is the Region's 2 m bare earth from its 2012-13 flight (SITR,
// Regione Siciliana), an ArcGIS ImageServer with CORS open and no key, so the
// browser asks it directly like it asks INGV. Bare earth again: the Region
// publishes no surface model, so a building is still not here -- this is the
// ground under it, sharper.
//
// Asked in its NATIVE grid, EPSG:25833 on its own 2 m lattice (origin 224674,
// 3929228: both even), at its native size, nearest neighbour -- for the same
// reason TINITALY is: anything else resamples, and a resampled summit is a
// lower one. Asked any other way the server also pads the box to square
// pixels and hands back an extent you did not ask for.
//
// ETRS89, not WGS84. The two have drifted apart by about 2.5 cm a year since
// 1989, under a metre now -- half a cell, inside the sideways reach that every
// reading below already takes (nearMax over the clearance, and the corner max).
export const SITR = 'https://map.sitr.regione.sicilia.it/gis/rest/services/modelli_digitali/mdt_2013/ImageServer';
const SITR_CELL = 2;
const UTM33 = { lon0: (15 * Math.PI) / 180, k0: 0.9996, fe: 500000, fn: 0, f: GRS80_F };
export const toUtm33 = (lat, lon) => tmFromWgs84(lat, lon, UTM33);
// The service's own extent. It also takes in the toe of Calabria, where it
// answers all zeros and TINITALY is used instead (see sitrGrid).
const SITR_ENVELOPE = { e0: 224674, n0: 3929228, e1: 558320, n1: 4296652 };

export function sitrCovers(lat, lon) {
  const { east, north } = toUtm33(lat, lon);
  return east > SITR_ENVELOPE.e0 && east < SITR_ENVELOPE.e1
    && north > SITR_ENVELOPE.n0 && north < SITR_ENVELOPE.n1;
}

// The same contract as requestFor, on the 2 m lattice. 4 km is 2000 cells a
// side, inside the server's 15000 x 4100 limit, and 16 MB of floats.
export function sitrRequestFor(bounds, margin) {
  const corners = [
    toUtm33(bounds.south, bounds.west), toUtm33(bounds.south, bounds.east),
    toUtm33(bounds.north, bounds.west), toUtm33(bounds.north, bounds.east),
  ];
  const e = corners.map((c) => c.east);
  const n = corners.map((c) => c.north);
  const snap = (v, up) => (up ? Math.ceil : Math.floor)(v / SITR_CELL) * SITR_CELL;
  const box = {
    e0: snap(Math.min(...e) - margin, false), n0: snap(Math.min(...n) - margin, false),
    e1: snap(Math.max(...e) + margin, true), n1: snap(Math.max(...n) + margin, true),
  };
  if (box.e1 - box.e0 > MAX_SIDE_M || box.n1 - box.n0 > MAX_SIDE_M) return null;
  const cols = (box.e1 - box.e0) / SITR_CELL;
  const rows = (box.n1 - box.n0) / SITR_CELL;
  const q = new URLSearchParams({
    bbox: `${box.e0},${box.n0},${box.e1},${box.n1}`, bboxSR: '25833', imageSR: '25833',
    size: `${cols},${rows}`, format: 'bsq', pixelType: 'F32',
    interpolation: 'RSP_NearestNeighbor', f: 'image',
  });
  return { box, cols, rows, url: `${SITR}/exportImage?${q}` };
}

// The raw answer -> a grid in the same shape parseAsciiGrid makes.
//
// `bsq` is bare little-endian float32, north row first, with a 1-bit mask band
// after it (240,926 floats came back for 525 x 445 -- the extra is 1/32 of the
// cells), so only the first cols * rows are read and a short answer is refused.
//
// The sea is EXACTLY 0 (and the coastline's edge -3.4e38, see below). Real
// low ground is not: over Capo Calava's 1.3 x 1.5
// km, 208,162 cells read 0.0 and 2,086 read between 0 and 0.5 m (beach). So a
// 0 is "no land here", and it takes TINITALY's reading instead when `under`
// has one -- 1 to 5 m along the shore, which errs high -- and 0 where both
// agree it is open water. With no TINITALY at all it stays unknown (NaN):
// a 0 the Region did not measure must not become flat ground nobody checked.
//
// And if nothing here is land at all -- the Calabrian corner of the envelope,
// or a box out at sea -- there is no point in a 2 m copy of TINITALY: null,
// and the caller uses TINITALY as it is.
export function sitrGrid(buf, req, under = null) {
  const { cols, rows, box } = req;
  if (buf.byteLength < cols * rows * 4) throw new Error(`SITR grid short: ${buf.byteLength} bytes for ${cols} x ${rows}`);
  const raw = new Float32Array(buf.slice(0, cols * rows * 4));
  const z = new Float32Array(cols * rows);
  let land = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const v = raw[i];
      // Not land: exactly 0 (the sea), and -3.4e38, float32's lowest, which
      // the server writes along the coastline mask when asked for nearest
      // neighbour -- 426 of the 5,168 cells of the Calava fixture. It is
      // finite, so the first version took it for ground: a takeoff on one put
      // the datum at -3.4e38 and the 3D view drew it as walls into the sea.
      // Nothing in Sicily is a hundred metres below sea level.
      if (v !== 0 && v > -100 && Number.isFinite(v)) { z[i] = v; land++; continue; }
      if (!under) { z[i] = NaN; continue; }
      // Cell centre -> lat/lon -> TINITALY. The inverse projection is the
      // less accurate direction (js/tm.js), but this is zone 33 inside its
      // own zone, and it only places a sea cell.
      const { lat, lon } = tmToWgs84(box.e0 + (c + 0.5) * SITR_CELL, box.n1 - (r + 0.5) * SITR_CELL, UTM33);
      const t = groundAt(under, lat, lon);
      z[i] = t === null ? 0 : Math.max(0, t);
    }
  }
  if (!land) return null;
  return { cols, rows, e0: box.e0, n0: box.n0, cell: SITR_CELL, z, toGrid: toUtm33, source: 'sitr' };
}

// The ground at a point, in metres above sea level: the HIGHEST of the four
// cell centres around it. A 10 m grid does not know the shape between its
// samples, and interpolating between them would put a ridge crest lower than
// either side of it -- so the reading errs high. Null if any of the four is
// off the grid or NODATA: the half you do not have is unknown, not flat.
function corners(g, e, n, pick) {
  const c = (e - g.e0) / g.cell - 0.5;
  const r = (g.n0 + g.rows * g.cell - n) / g.cell - 0.5;
  const c0 = Math.floor(c);
  const r0 = Math.floor(r);
  if (c0 < 0 || r0 < 0 || c0 + 1 >= g.cols || r0 + 1 >= g.rows) return null;
  let out = null;
  for (const [dr, dc] of [[0, 0], [0, 1], [1, 0], [1, 1]]) {
    const v = g.z[(r0 + dr) * g.cols + c0 + dc];
    if (Number.isNaN(v)) return null;
    out = out === null ? v : pick(out, v);
  }
  return out;
}
const cornerMax = (g, e, n) => corners(g, e, n, Math.max);

// The ground under the TAKEOFF errs the other way, and this is the line to
// get right. Every altitude is added to it to say where the aircraft is, so a
// takeoff ground read too high puts the aircraft too high -- the exact error
// that flies it into the slope. The first version used the max here as well
// and its own test caught it: at the foot of Pizzo Monaco's east face the four
// corners span 11.9 m (110.4 to 122.3), all of it on the wrong side.
const cornerMin = (g, e, n) => corners(g, e, n, Math.min);

export const groundAt = (g, lat, lon) => {
  const { east, north } = gridXY(g, lat, lon);
  return cornerMax(g, east, north);
};

// The tallest ground within `reach` metres of a point -- sideways clearance,
// the same neighbourhood the survey check uses. Sampled on the cell pitch out
// to the reach, and each sample is itself a four-cell max, so every cell
// centre within `reach` is inside one of them. Any sample off the grid or
// NODATA makes the whole answer null rather than letting the max quietly skip
// it.
function nearMax(g, e, n, reach) {
  const R = Math.ceil(reach / g.cell);
  let top = -Infinity;
  for (let dr = -R; dr <= R; dr++) {
    for (let dc = -R; dc <= R; dc++) {
      if (dr * dr + dc * dc > R * R) continue;
      const v = cornerMax(g, e + dc * g.cell, n + dr * g.cell);
      if (v === null) return null;
      if (v > top) top = v;
    }
  }
  return top;
}

// Would this flight come within `clr` metres of the ground?
//
// Same report shape as checkMesh in js/scene3d.js, because the app's adjuster
// (liftToClear) reads one and must be able to read either: `hits`, a per-leg
// `verdict` (1 strike, 0 not judged), `needs` (the level altitude above the
// takeoff that would clear the leg) and the struck `legs` for the map.
//
// Never verdict 2. The survey can say a leg is clear of what it measured; this
// measured only the ground, so a leg that misses it may still be in a tree.
//
// Cheap enough to run on every replan: 0.77 ms for 218 waypoints at a 3 m
// clearance, measured in node over the Pizzo Monaco fixture.
export function checkTerrain(g, m, clr) {
  const path = m?.exported ?? m?.waypoints ?? [];
  if (!g || !path.length) return null;
  const home = gridXY(g, path[0].lat, path[0].lon);
  const datum = cornerMin(g, home.east, home.north);
  // No ground under the first waypoint is no zero to measure from at all.
  if (datum === null) return null;
  const pts = path.map((w) => ({ ...gridXY(g, w.lat, w.lon), z: w.alt + datum }));
  const verdict = new Uint8Array(path.length);
  const needs = new Array(path.length).fill(null);
  const legs = [];
  let hits = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const len = Math.hypot(b.east - a.east, b.north - a.north);
    // Half a cell per step, so no cell centre falls between two steps'
    // neighbourhoods.
    const steps = Math.max(1, Math.ceil(len / (g.cell / 2)));
    let top = -Infinity;
    let through = false;
    let blind = false;
    for (let k = 0; k <= steps; k++) {
      const f = k / steps;
      const q = nearMax(g, a.east + (b.east - a.east) * f, a.north + (b.north - a.north) * f, clr);
      if (q === null) { blind = true; continue; }
      if (q > top) top = q;
      if (a.z + (b.z - a.z) * f < q + clr) through = true;
    }
    // A leg partly off the model is not judged on the part that is on it --
    // except that a strike on the part we do have is still a strike.
    // Rounded UP to the centimetre: rounded to nearest, flying exactly the
    // altitude this says could still be a strike by half a centimetre.
    needs[i] = Number.isFinite(top) && !blind ? Math.ceil((top + clr - datum) * 100) / 100 : null;
    if (through) {
      verdict[i] = 1;
      hits++;
      legs.push({ a: path[i - 1], b: path[i], grade: 'strike' });
    }
  }
  return { hits, legs, verdict, needs, datum, source: 'terrain' };
}

// One grid at a time, fetched for the flight on screen and kept while flights
// stay inside it.
//
// `fetch` is passed in so test/run.mjs can answer from a fixture instead of
// asking Pisa.
export function createTerrain({ fetch = globalThis.fetch?.bind(globalThis) } = {}) {
  let grid = null;
  let datum = null;      // floorAt's zero: the ground under the flight that loaded the grid
  let pending = null;    // the request in flight, by URL, so a replan does not start another
  let version = 0;

  // Metres the grid is widened past the flight, so the adjuster's sideways
  // nudges (up to 8 m of standoff, see safePlan) and a clearance's reach stay
  // on it without a refetch.
  const MARGIN = 150;

  const inside = (b) => {
    if (!grid) return false;
    const want = grid.source === 'sitr' ? sitrRequestFor(b, 30) : requestFor(b, 30);
    return want && want.box.e0 >= grid.e0 && want.box.n0 >= grid.n0
      && want.box.e1 <= grid.e0 + grid.cols * grid.cell
      && want.box.n1 <= grid.n0 + grid.rows * grid.cell;
  };

  return {
    covers,
    ready: () => grid !== null,
    // Which model the ground came from, for the credit and the warning.
    source: () => (grid ? grid.source ?? 'tinitaly' : null),
    version: () => version,
    // Make sure the ground under `m` is loaded. Resolves true when a NEW grid
    // arrived (the caller replans), false when nothing changed or nothing can
    // be had -- in which case the app goes on exactly as it did before this
    // existed, with nothing checked and nothing claimed.
    async ensure(m) {
      const path = m?.exported ?? m?.waypoints ?? [];
      if (!path.length || !fetch || !covers(path[0].lat, path[0].lon)) return false;
      const lats = path.map((w) => w.lat);
      const lons = path.map((w) => w.lon);
      const b = { south: Math.min(...lats), north: Math.max(...lats), west: Math.min(...lons), east: Math.max(...lons) };
      if (inside(b)) return false;
      const req = requestFor(b, MARGIN);
      if (!req) return false;
      if (pending?.url === req.url) return pending.job;
      // In Sicily both are asked at once: the Region's 2 m model is the
      // ground, TINITALY fills its sea cells, and if the Region's server is
      // down TINITALY is the ground on its own -- what the app had before.
      // Measured 2026-11-08 over the 3D view's 1.2 km square at Calava: 752 x
      // 750 cells, 2.3 MB, 6.1 s from the Region and 118 ms to build, half of
      // it filling sea cells. The plan waits unchecked meanwhile, as before.
      const sreq = sitrCovers(path[0].lat, path[0].lon) ? sitrRequestFor(b, MARGIN) : null;
      const job = (async () => {
        try {
          const [t, sbuf] = await Promise.all([
            fetch(req.url).then(async (r) => (r.ok ? parseAsciiGrid(await r.text()) : null)).catch(() => null),
            sreq ? fetch(sreq.url).then((r) => (r.ok ? r.arrayBuffer() : null)).catch(() => null) : null,
          ]);
          let g = t;
          if (sbuf) {
            try { g = sitrGrid(sbuf, sreq, t) ?? t; } catch { g = t; }
          }
          if (!g) return false;
          const home = gridXY(g, path[0].lat, path[0].lon);
          const d = cornerMin(g, home.east, home.north);
          if (d === null) return false;
          grid = g;
          datum = d;
          version++;
          return true;
        } catch {
          return false;
        } finally {
          pending = null;
        }
      })();
      pending = { url: req.url, job };
      return job;
    },
    // The lowest a station may fly at a spot, above the takeoff datum, for the
    // planner's surfaceFloor -- the same contract as the survey's floorAt: 0
    // where there is nothing to say, and the flight check has the last word
    // (it re-measures from each candidate's own first waypoint).
    floorAt(lat, lon, clr, reach = clr + 2) {
      if (!grid) return 0;
      const { east, north } = gridXY(grid, lat, lon);
      const top = nearMax(grid, east, north, reach);
      return top === null ? 0 : Math.max(0, top + clr - datum);
    },
    checkFlight(m, clr) {
      return grid ? checkTerrain(grid, m, clr) : null;
    },
    // The ground for the 3D view to draw: (lat, lon) -> metres above the
    // takeoff, or null off the grid. Same zero as checkFlight -- the min of the
    // corners under `m`'s first waypoint -- recomputed from `m` rather than
    // reusing `datum`, which belongs to whichever plan loaded the grid and goes
    // stale the moment the takeoff moves without a refetch.
    //
    // Bilinear, not the conservative corner max: this is a picture, and the
    // max turns every slope into ten-metre terraces. Nothing judges a flight
    // by it -- the red legs come from checkFlight.
    relief(m) {
      const path = m?.exported ?? m?.waypoints ?? [];
      if (!grid || !path.length) return null;
      const home = gridXY(grid, path[0].lat, path[0].lon);
      const zero = cornerMin(grid, home.east, home.north);
      if (zero === null) return null;
      const g = grid;
      return (lat, lon) => {
        const { east, north } = gridXY(g, lat, lon);
        const c = (east - g.e0) / g.cell - 0.5;
        const r = (g.n0 + g.rows * g.cell - north) / g.cell - 0.5;
        const c0 = Math.floor(c);
        const r0 = Math.floor(r);
        if (c0 < 0 || r0 < 0 || c0 + 1 >= g.cols || r0 + 1 >= g.rows) return null;
        const u = c - c0;
        const v = r - r0;
        const at = (dr, dc) => g.z[(r0 + dr) * g.cols + c0 + dc];
        const z = (at(0, 0) * (1 - u) + at(0, 1) * u) * (1 - v) + (at(1, 0) * (1 - u) + at(1, 1) * u) * v;
        return Number.isNaN(z) ? null : z - zero;
      };
    },
  };
}
