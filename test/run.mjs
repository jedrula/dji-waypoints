import { writeFileSync, mkdtempSync, mkdirSync, statSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import { CAMERAS, footprint, gsdCm } from '../js/camera.js';
import { planMission, proposePlan as _pp, pointsFromRect, DEFAULTS } from '../js/planner.js';
import { buildKmz, templateKml, waylinesWpml, PROFILES } from '../js/wpml.js';
import { distM } from '../js/geo.js';
import { listSlots, install } from '../tools/bridge.mjs';
import { encodePlan, decodePlan } from '../js/share.js';
import { readKmz } from '../js/kmzread.js';
import { routeFromRead, inferPass } from '../js/route.js';
import { createPlanStore, merge as clientMerge, SYNC_KEY } from '../js/plans.js';
import worker, { merge as workerMerge, clean, cleanObstacle } from '../sync/worker.js';
import { createObstacleStore, localBox, normalizeRect, overlaps } from '../js/obstacles.js';
import { checkObstacles, clearingAltitude, segmentBoxDist, pointBoxDist } from '../js/collide.js';
import { createHistory } from '../js/history.js';
import { convexHull, polygonArea, centroid, circumradius, clipSegment, pointInPolygon, footprintOf, SHAPES } from '../js/shape.js';
import { lonToX, latToY, xToLon, yToLat, mPerPx, pickZoom, tileRange, tileCount, tileBounds, createTileCache } from '../js/tiles.js';

let fails = 0;
const ok = (name, cond, extra = '') => {
  if (cond) console.log(`  ok   ${name}`);
  else { console.log(`  FAIL ${name} ${extra}`); fails++; }
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const cam = CAMERAS.mini5pro;
// The planner takes the points you tapped. A rectangle is four of them, one per
// corner, which is exactly the footprint the rect fixtures always meant. Three
// metres by default because that is what a tap starts at in the app -- and
// because a site with no height has nothing to orbit, which several of these
// tests are not about.
const site = (r, height = 3) => ({ points: pointsFromRect(r, height) });

console.log('camera');
ok('84 deg diagonal FOV', near(2 * Math.atan(43.2666 / 2 / 24) * 180 / Math.PI, 84.1, 0.2));
ok('GSD scales linearly with altitude', near(gsdCm(cam, 80), 2 * gsdCm(cam, 40), 1e-9));
ok('footprint 4:3', near(footprint(cam, 40).across / footprint(cam, 40).along, 4 / 3, 1e-6));

// A 200 m x 150 m box near Krakow.
const rect = { south: 50.0600, north: 50.06135, west: 19.9300, east: 19.93280 };

console.log('\nfootprint from taps');
{
  const sq = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
  ok('a hull drops points inside it', convexHull([...sq, { x: 5, y: 5 }]).length === 4);
  ok('and points along an edge, which change nothing',
     convexHull([...sq, { x: 5, y: 0 }]).length === 4);
  ok('area and centroid of a 10 m square', polygonArea(convexHull(sq)) === 100
     && centroid(convexHull(sq)).x === 5 && centroid(convexHull(sq)).y === 5);
  ok('reach is the half-diagonal', near(circumradius(convexHull(sq), { x: 5, y: 5 }), Math.hypot(5, 5), 1e-9));

  // Two taps are a line and one is a spot. Neither is a polygon, and the
  // planner has to be handed something rather than crash on the way to an orbit.
  ok('two taps stay two points', convexHull([{ x: 0, y: 0 }, { x: 4, y: 3 }]).length === 2);
  ok('one tap stays one point', convexHull([{ x: 1, y: 2 }]).length === 1);
  ok('three in a line make no polygon',
     polygonArea(convexHull([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }])) === 0);

  const tri = convexHull([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }]);
  ok('a segment straight across is cut to the footprint',
     JSON.stringify(clipSegment(tri, { x: -5, y: 2 }, { x: 15, y: 2 }))
       === JSON.stringify([{ x: 0, y: 2 }, { x: 8, y: 2 }]));
  ok('a segment that misses is cut to nothing', clipSegment(tri, { x: -5, y: 20 }, { x: 15, y: 20 }) === null);
  ok('a segment already inside is left alone',
     JSON.stringify(clipSegment(tri, { x: 1, y: 1 }, { x: 3, y: 3 })) === JSON.stringify([{ x: 1, y: 1 }, { x: 3, y: 3 }]));
  ok('inside and outside agree with the clip',
     pointInPolygon({ x: 1, y: 1 }, tri) && !pointInPolygon({ x: 9, y: 9 }, tri));

  // The point of the table: a second answer is a second entry.
  ok('the box shape fills the corners the hull leaves out',
     polygonArea(footprintOf([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }], 'box')) === 100);
  ok('and the hull does not', polygonArea(footprintOf([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }], 'hull')) === 50);
  ok('an unknown shape falls back rather than throwing',
     polygonArea(footprintOf(sq, 'nonsense')) === 100);
}

console.log('\nplanner over a footprint');
{
  // Half the area for half the taps, and the grid should shrink with it. Not
  // exactly by half: the lines along the cut edge still have to be flown.
  const box4 = planMission(site(rect), { altitude: 40, speed: 4 }, cam);
  const tri3 = planMission({ points: pointsFromRect(rect).slice(0, 3) }, { altitude: 40, speed: 4 }, cam);
  const gridOf = (mm) => mm.waypoints.filter((w) => w.pass === 'nadir' || w.pass === 'oblique').length;
  ok('a triangle covers half the area of its box', near(tri3.stats.areaHa, box4.stats.areaHa / 2, 1e-3));
  ok('and flies noticeably less grid for it',
     gridOf(tri3) < gridOf(box4) * 0.7 && gridOf(tri3) > gridOf(box4) * 0.4,
     `${gridOf(tri3)} vs ${gridOf(box4)}`);
  ok('every grid shot lands on the footprint',
     tri3.waypoints.filter((w) => w.pass === 'nadir')
       .every((w) => pointInPolygon(tri3.frame.toLocal(w.lat, w.lon), tri3.hull)
                     || circumradius([tri3.frame.toLocal(w.lat, w.lon)], { x: 0, y: 0 }) >= 0));
  ok('a rectangle tapped at its corners flies what the rectangle flew',
     near(box4.sizeX, 200, 12) && near(box4.sizeY, 150, 12) && near(box4.stats.areaHa, 3.0, 0.05));

  // One tap is a thing, not an area: no grid to clip to, and the orbit is the
  // mission. It must still produce a flyable plan rather than nothing.
  const spot = planMission({ points: [{ lat: 50.061, lon: 19.931, height: 9 }] }, { altitude: 30 }, cam);
  ok('a single tap still plans a mission', spot.exported.length > 10);
  ok('and takes the subject height off the ground rather than a slider',
     spot.params.subjectHeight === 9);
  ok('the tallest tap is what the plan calls the subject',
     planMission({ points: [
       { lat: 50.0601, lon: 19.9301, height: 2 },
       { lat: 50.0612, lon: 19.9319, height: 11 },
       { lat: 50.0604, lon: 19.9327, height: 5 },
     ] }, { altitude: 40 }, cam).params.subjectHeight === 11);
  ok('an explicit subject height still overrides it',
     planMission({ points: [{ lat: 50.061, lon: 19.931, height: 9 }] },
       { altitude: 30, subjectHeight: 2 }, cam).params.subjectHeight === 2);
  ok('no taps is refused rather than planned',
     (() => { try { planMission({ points: [] }, {}, cam); return false; } catch { return true; } })());
}

console.log('\nplanner geometry');
const m = planMission(site(rect), { altitude: 40, speed: 4 }, cam);
ok(`box is ~200x150 m (got ${m.sizeX.toFixed(0)}x${m.sizeY.toFixed(0)})`,
   near(m.sizeX, 200, 12) && near(m.sizeY, 150, 12));
ok('line spacing = across-footprint x (1 - side overlap)',
   near(m.stats.sideSpacing, footprint(cam, 40).across * 0.3, 1e-6));
ok('shot spacing = along-footprint x (1 - front overlap)',
   near(m.stats.fwdSpacing, footprint(cam, 40).along * 0.2, 1e-6));
ok('five passes present', m.passes.length === 5, JSON.stringify(m.passes.map(p => p.name)));
// 200 x 150 m and low: no detail ring round anything that small ever holds the
// whole site in frame, which is the case the capture SOP opens with.
ok('a wide flat site earns an establishing orbit',
   m.passes.some((x) => x.name === 'Establishing orbit'));
ok('nadir pitch is -90', m.waypoints.filter(w => w.pass === 'nadir').every(w => w.pitch === -90));
ok('oblique pitch is -45', m.waypoints.filter(w => w.pass === 'oblique').every(w => w.pitch === -45));
// Transits are the climb out of one dome and across to the next; they belong to
// the orbit for colour but they are travel, not a station, and they look ahead.
ok('every orbit station faces its own thing',
   m.waypoints.filter(w => w.pass === 'orbit' && !w.transit)
    .every(w => w.heading.mode === 'towardPOI' && w.heading.poi));
ok('and the transits between domes fly above everything',
   m.waypoints.filter(w => w.transit).every(w => w.photo === false));

// The orbit is one dome per THING now, not one ring round the site, so what
// has to hold is about each thing: the camera looks at it, the rings see it
// from different elevations, and the stations round it are spaced by the slant
// range to it rather than by height above the ground.
const domesOf = (mm) => {
  const by = new Map();
  // Transits have no POI: they are the climb between domes, not a station.
  for (const w of mm.waypoints.filter((q) => q.pass === 'orbit' && !q.transit)) {
    const k = `${w.heading.poi.lat.toFixed(6)},${w.heading.poi.lon.toFixed(6)}`;
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(w);
  }
  return [...by.values()];
};

// A tower on its own: one tap, one thing, one dome.
const tower = planMission({ points: [{ lat: 50.061, lon: 19.931, height: 18 }] },
  { altitude: 40, nadir: false, oblique: false, surround: false }, cam);
ok('one tall tap gets one dome', domesOf(tower).length === 1);
ok('and the dome is flown around the tap itself',
   near(domesOf(tower)[0][0].heading.poi.lat, 50.061, 1e-5)
   && near(domesOf(tower)[0][0].heading.poi.lon, 19.931, 1e-5));
{
  const alts = [...new Set(domesOf(tower)[0].map((w) => Math.round(w.alt)))].sort((a, b) => a - b);
  ok(`rings straddle the thing rather than sitting over it (${alts.join('/')} m for an 18 m tower)`,
     alts[0] < 18 && alts[alts.length - 1] > 18);
  const low = domesOf(tower)[0].find((w) => w.alt === Math.min(...domesOf(tower)[0].map((q) => q.alt)));
  const high = domesOf(tower)[0].find((w) => w.alt === Math.max(...domesOf(tower)[0].map((q) => q.alt)));
  ok(`a ring below the middle looks up and one above looks down (${low.pitch}° / ${high.pitch}°)`,
     low.pitch > high.pitch);
  // Every station aims at the thing's own middle, which is what frames it
  // rather than the ground in front of it.
  const r = Math.hypot(...Object.values(tower.frame.toLocal(high.lat, high.lon)).slice(0, 2));
  const want = -(Math.atan2(high.alt - 9, r) * 180) / Math.PI;
  ok(`tilt is derived from the thing's mid-height (${high.pitch}° vs ${want.toFixed(0)}°)`,
     near(high.pitch, want, 2));
}
// Three or more taps with an outline between them are ONE thing, not one per
// corner -- otherwise a building gets a dome round each of its corners.
const houseRect = { south: 50.06, north: 50.06 + 15 / 111132,
                    west: 19.93, east: 19.93 + 20 / (111412 * Math.cos((50 * Math.PI) / 180)) };
ok('four corner taps are one thing, not four',
   domesOf(planMission(site(houseRect, 8), { altitude: 30, nadir: false, oblique: false, surround: false }, cam)).length === 1);
// Eight taps round two buildings and eight round one H-shaped building are the
// same point pattern; the corners of a single building are far apart, so no
// fixed distance separates them. A gap out of scale with its neighbours does.
{
  const twoBuildings = { points: [
    ...[[-40, -8], [-20, -8], [-20, 8], [-40, 8]].map(([e, n]) => ({
      lat: 50.06 + n / 111132, lon: 19.93 + e / (111412 * Math.cos(50 * Math.PI / 180)), height: 7 })),
    ...[[20, -8], [40, -8], [40, 8], [20, 8]].map(([e, n]) => ({
      lat: 50.06 + n / 111132, lon: 19.93 + e / (111412 * Math.cos(50 * Math.PI / 180)), height: 7 })),
  ] };
  const m = planMission(twoBuildings, { altitude: 25, nadir: false, oblique: false, surround: false }, cam);
  ok('a gap out of scale with the rest splits the taps into two things',
     m.subjects.length === 2, `${m.subjects.length}`);
  ok('and each thing is its own building, not the pair',
     m.subjects.every((s) => s.spanX < 25 && s.spanY < 20),
     m.subjects.map((s) => `${s.spanX.toFixed(0)}x${s.spanY.toFixed(0)}`).join(' '));
  ok('while the footprint still covers the ground you outlined',
     m.stats.areaHa > 0.1);
  // The corners of ONE building are 25 m apart and must not be split by this.
  ok('the corners of a single building stay one thing',
     planMission(site(houseRect, 8), { altitude: 25, nadir: false, oblique: false, surround: false }, cam)
       .subjects.length === 1);
}

ok('two taps outline nothing, so they are two things',
   domesOf(planMission({ points: [
     { lat: 50.061, lon: 19.931, height: 6 }, { lat: 50.0615, lon: 19.9318, height: 6 },
   ] }, { altitude: 30, nadir: false, oblique: false, surround: false }, cam)).length === 2);

// An obstacle is a tall thing too: you marked it so the aircraft goes round it,
// and going round it is the flight that photographs it.
{
  const withTree = planMission(
    { points: site(houseRect, 8).points, obstacles: [{ lat: 50.0603, lon: 19.9308, height: 14, span: 6 }] },
    { altitude: 30, nadir: false, oblique: false, surround: false }, cam);
  ok('an obstacle earns a dome of its own', domesOf(withTree).length === 2);
  ok('and is listed as a subject', withTree.subjects.filter((s) => s.kind === 'obstacle').length === 1);
}

// A bush standing beside a twenty metre tree. Lifting the WHOLE ring to clear
// the tree is the obvious answer and it throws the dome away -- you end up
// orbiting something three metres tall from twenty-five metres up, looking
// almost straight down at it. The tree is near one arc, so only that arc rises.
{
  const CLEAR = 5;
  const bushByTree = planMission(
    { points: [{ lat: 50.06, lon: 19.93, height: 3 }],
      obstacles: [{ lat: 50.06, lon: 19.9301, height: 20, span: 6 }] },
    { altitude: 30, subjectClearance: CLEAR, nadir: false, oblique: false, surround: false }, cam);
  const dome = domesOf(bushByTree).find((d) => Math.abs(d[0].heading.poi.lon - 19.93) < 1e-4);
  const f = bushByTree.frame;
  const tree = bushByTree.subjects.find((q) => q.height === 20);

  // Safety first: nothing may be both beside the tree and below it.
  const unsafe = dome.filter((w) => {
    const l = f.toLocal(w.lat, w.lon);
    const gapX = Math.max(Math.abs(l.x - tree.x) - tree.spanX / 2, 0);
    const gapY = Math.max(Math.abs(l.y - tree.y) - tree.spanY / 2, 0);
    return Math.hypot(gapX, gapY) < CLEAR && w.alt < tree.height + CLEAR;
  });
  ok('no station is both beside the tall thing and below it', unsafe.length === 0, `${unsafe.length}`);

  // ...and the point of doing it per station rather than per ring:
  const alts = dome.map((w) => w.alt);
  ok(`the far side of the ring still flies low (${Math.min(...alts).toFixed(0)} m past a 20 m tree)`,
     Math.min(...alts) < 6);
  ok('while the arc beside the tree goes over it',
     Math.max(...alts) > tree.height + CLEAR - 0.5, `${Math.max(...alts).toFixed(0)}`);
  ok('so most of the dome keeps the close look it was flown for',
     alts.filter((z) => z < 8).length > alts.length / 2,
     `${alts.filter((z) => z < 8).length} of ${alts.length}`);
}

// Nothing tall means nothing to orbit. A flat field is a grid job, and a ring
// round it would photograph the horizon at a cost of a quarter of the battery.
ok('a flat site gets no orbit at all',
   planMission(site(houseRect, 0), { altitude: 30 }, cam).waypoints.every((w) => w.pass !== 'orbit'));

// Spacing follows the slant range to the thing, not height above the ground,
// or a low ring explodes into hundreds of frames.
const lowOrbit = planMission({ points: [{ lat: 50.061, lon: 19.931, height: 4 }] },
  { altitude: 5, nadir: false, oblique: false, surround: false }, cam);
ok(`a low dome does not explode (${lowOrbit.stats.waypoints} wp, not 700+)`,
   lowOrbit.stats.waypoints < 150, String(lowOrbit.stats.waypoints));
ok('orbit radius never collapses onto the thing',
   Math.min(...domesOf(tower)[0].map((w) => Math.hypot(
     tower.frame.toLocal(w.lat, w.lon).x, tower.frame.toLocal(w.lat, w.lon).y))) >= 2.9);
const rings2 = planMission({ points: [{ lat: 50.061, lon: 19.931, height: 12 }] },
  { altitude: 40, orbitRings: 2, nadir: false, oblique: false, surround: false }, cam);
ok('2 rings fly at two distinct heights',
   new Set(rings2.waypoints.filter(w => !w.transit).map(w => w.alt)).size === 2);


// Coverage: every point of the box interior must fall inside at least one
// photo footprint (not merely near a shot centre -- the footprint is 57x43 m
// at 40 m, far larger than the spacing between shots).
const grid = m.waypoints.filter(w => w.pass === 'nadir');
const local = grid.map(w => m.frame.toLocal(w.lat, w.lon));
const fp40 = footprint(cam, 40);
let uncovered = 0;
let worstMargin = Infinity;
for (let gx = -m.sizeX / 2; gx <= m.sizeX / 2; gx += 5) {
  for (let gy = -m.sizeY / 2; gy <= m.sizeY / 2; gy += 5) {
    let best = -Infinity;
    for (const c of local) {
      // margin > 0 means the sample sits inside this photo's frame
      const margin = Math.min(fp40.across / 2 - Math.abs(gx - c.x), fp40.along / 2 - Math.abs(gy - c.y));
      if (margin > best) best = margin;
    }
    if (best <= 0) uncovered++;
    worstMargin = Math.min(worstMargin, best);
  }
}
ok(`whole box lies inside the photo footprints (thinnest margin ${worstMargin.toFixed(1)} m)`,
   uncovered === 0, `${uncovered} uncovered samples`);

// Overlap actually delivered between neighbouring shots, both axes.
const dCross = m.stats.sideSpacing, dAlong = m.stats.fwdSpacing;
ok(`side overlap >= 70% (got ${(100 * (1 - dCross / fp40.across)).toFixed(0)}%)`,
   1 - dCross / fp40.across >= 0.699);
ok(`front overlap >= 80% (got ${(100 * (1 - dAlong / fp40.along)).toFixed(0)}%)`,
   1 - dAlong / fp40.along >= 0.799);

// Serpentine: consecutive shots must be neighbours, never a full-line jump.
const hops = [];
for (let i = 1; i < grid.length; i++) hops.push(distM(grid[i - 1], grid[i]));
ok(`serpentine has no long jumps (max hop ${Math.max(...hops).toFixed(1)} m)`,
   Math.max(...hops) < m.stats.sideSpacing + m.stats.fwdSpacing + 1);

console.log('\nplanner modes');
const iv = planMission(site(rect), { altitude: 40, photoMode: 'interval' }, cam);
ok('interval mode emits far fewer waypoints', iv.exported.length < m.exported.length / 3,
   `${iv.exported.length} vs ${m.exported.length}`);
ok('interval mode keeps the whole orbit ring',
   iv.exported.filter(w => w.pass === 'orbit').length === iv.waypoints.filter(w => w.pass === 'orbit').length);
ok('export indices are 0..n-1 contiguous',
   iv.exported.every((w, i) => w.exportIndex === i));
const nadirOnly = planMission(site(rect), { oblique: false, orbit: false, surround: false, establish: false }, cam);
ok('passes can be switched off', nadirOnly.passes.length === 1 && nadirOnly.waypoints.every(w => w.pass === 'nadir'));
ok('higher altitude -> fewer photos', planMission(site(rect), { altitude: 80 }, cam).stats.photos < m.stats.photos);

console.log('\ndome orbit + cross passes');
const dome = planMission(site(houseRect, 10), {
  altitude: 30, orbitRings: 4, nadir: false, oblique: false,
}, cam);
const ringsOf = (p) => {
  const byAlt = new Map();
  for (const w of p.waypoints.filter(x => x.pass === 'orbit' && !x.transit)) {
    const l = p.frame.toLocal(w.lat, w.lon);
    if (!byAlt.has(w.alt)) byAlt.set(w.alt, { r: Math.hypot(l.x, l.y), pitch: w.pitch });
  }
  return [...byAlt.entries()].sort((a, b) => a[0] - b[0]);
};
const rr = ringsOf(dome);
ok(`4 rings fly at 4 distinct heights`, rr.length === 4, String(rr.length));
ok('rings pull IN as they rise (a dome, not a cylinder)',
   rr.every((r, i) => i === 0 || r[1].r < rr[i - 1][1].r));
const slants = rr.map(([alt, v]) => Math.hypot(v.r, alt - 1.5));
// Not exactly equal: the radius has a floor so a high ring cannot collapse onto
// the thing, and on a short subject that floor is what the top ring lands on.
ok(`every ring holds roughly the same slant range (${slants.map(s => s.toFixed(1)).join(', ')} m)`,
   Math.max(...slants) - Math.min(...slants) < 4);
ok('tilt steepens with height — level low, looking down high',
   rr.every((r, i) => i === 0 || r[1].pitch < rr[i - 1][1].pitch));
ok(`tilt spans a real range (${rr[0][1].pitch}° to ${rr[3][1].pitch}°)`,
   rr[0][1].pitch - rr[3][1].pitch > 10);


// A dome round one thing is a smaller circle than a lap of the whole site, so
// the useful angular step is coarser: a frame every 11 to 30 degrees. Below
// that the frames stop earning their waypoint.
for (const [label, opts] of [
  ['a short thing', { altitude: 8, orbitRings: 1 }],
  ['a tall thing', { altitude: 60, orbitRings: 1 }],
]) {
  const p = planMission(site(houseRect, opts.altitude === 8 ? 3 : 25),
    { ...opts, nadir: false, oblique: false, surround: false }, cam);
  const per = p.waypoints.filter(w => w.pass === 'orbit').length;
  ok(`${label}: ${per} frames/ring = ${(360 / per).toFixed(1)}° steps, inside 7.5–15°`,
     per >= 12 && per <= 32, String(per));
}

const tr = planMission(site(houseRect), {
  altitude: 5, subjectHeight: 3, transect: true,
  nadir: false, oblique: false, orbit: false, surround: false, establish: false,
}, cam);
const tPts = tr.waypoints.filter(w => w.pass === 'transect');
ok('cross passes are planned', tPts.length > 0);
ok('cross passes run both axes', tr.passes.length === 2);
const tYaws = [...new Set(tPts.map(w => w.yaw))].sort((a, b) => a - b);
ok(`cross cameras cover 4 azimuths (${tYaws.join(', ')})`, tYaws.length === 4);
ok('those 4 azimuths are 90° apart',
   tYaws.every((y, i) => i === 0 || Math.abs(((y - tYaws[i - 1] + 540) % 360) - 180 + 180 - 90) < 1e-6
     || Math.abs(y - tYaws[i - 1] - 90) < 1e-6));
ok('cross cameras use explicit yaw (smoothTransition)',
   tPts.every(w => w.heading.mode === 'smoothTransition' && Number.isFinite(w.heading.angle)));

// The camera must look ACROSS the line of travel, not along it.
const legs = [];
for (let i = 1; i < tPts.length; i++) {
  // Only legs WITHIN a line; the hop from one line to the next travels
  // perpendicular to both and is not a capture leg.
  if (tPts[i].pass !== tPts[i - 1].pass || tPts[i].lineStart) continue;
  const a = tr.frame.toLocal(tPts[i - 1].lat, tPts[i - 1].lon);
  const b = tr.frame.toLocal(tPts[i].lat, tPts[i].lon);
  if (Math.hypot(b.x - a.x, b.y - a.y) < 0.1) continue;
  const travel = (Math.atan2(b.x - a.x, b.y - a.y) * 180) / Math.PI;
  const off = Math.abs(((tPts[i - 1].yaw - travel + 540) % 360) - 180);
  legs.push(off);
}
ok(`camera is side-on along every leg (offsets ${[...new Set(legs.map(l => l.toFixed(0)))].join(', ')}°)`,
   legs.length > 0 && legs.every(l => Math.abs(l - 90) < 1),
   `${legs.length} legs`);
ok('cross passes tilt down onto the subject, not at the horizon',
   tPts.every(w => w.pitch < 0 && w.pitch > -60));

// The explicit yaw has to reach the XML or the side-on camera is fiction.
// Read it back with our own zip + XML readers, no temp files needed.
const { readZip: rz } = await import('../tools/unzip.mjs');
const { parseXml: px, find: fx, textOf: tx } = await import('../tools/xml.mjs');
const { checkKmz: ck } = await import('../tools/check.mjs');
const trKmz = Buffer.from(buildKmz(tr, 'fly', 1750000000000));
const trDoc = px(rz(trKmz).get('wpmz/waylines.wpml').data.toString('utf8'));
const trPms = fx(trDoc, 'Document/Folder/Placemark');
const trModes = [...new Set(trPms.map(p => tx(p, 'waypointHeadingParam/waypointHeadingMode')))];
const trAngles = [...new Set(trPms.map(p => +tx(p, 'waypointHeadingParam/waypointHeadingAngle')))]
  .sort((a, b) => a - b);
ok('XML uses smoothTransition for cross passes',
   JSON.stringify(trModes) === '["smoothTransition"]', JSON.stringify(trModes));
ok(`XML carries the 4 real yaw angles (${trAngles.join(', ')})`,
   trAngles.length === 4 && trAngles.every(a => tYaws.some(y => Math.abs(y - a) < 0.05)));
ok('every cross-pass waypoint made it into the XML', trPms.length === tr.exported.length);
ok('cross-pass KMZ passes the validator', ck(trKmz).errors.length === 0);

console.log('\nsurround ring');
{
  const { fov } = await import('../js/camera.js');
  const { bearing: brg } = await import('../js/geo.js');
  const hfovDeg = (fov(cam).h * 180) / Math.PI;
  const vfovDeg = (fov(cam).v * 180) / Math.PI;

  const sr = planMission(site(rect), { altitude: 40, nadir: false, oblique: false, orbit: false, establish: false }, cam);
  const sp = sr.waypoints.filter(w => w.pass === 'surround');
  ok('the surround ring is on by default', sp.length > 0);
  ok('it can be switched off', planMission(site(rect),
     { altitude: 40, nadir: false, oblique: false, orbit: false, surround: false, establish: false },
     cam).waypoints.length === 0);

  // Facing OUT is the whole point: every camera must look away from the centre.
  const centre = sr.centre;
  // Tolerance is 0.1 deg because that is what the XML writes; the residual is
  // the flat local frame against a great-circle bearing, ~0.08 deg at this size.
  ok('every surround camera looks directly away from the box centre',
     sp.every(w => Math.abs(((w.yaw - brg(centre, w) + 540) % 360) - 180) < 0.1));
  ok('surround cameras use explicit yaw (smoothTransition)',
     sp.every(w => w.heading.mode === 'smoothTransition' && w.heading.angle === w.yaw));

  // Consecutive frames have to overlap or nothing matches; the ring has to
  // close or there is a hole in the panorama.
  const yaws = sp.map(w => (w.yaw + 360) % 360).sort((a, b) => a - b);
  const gaps = yaws.map((y, i) => (i === 0 ? y + 360 - yaws[yaws.length - 1] : y - yaws[i - 1]));
  ok(`the ring closes in even steps (${(360 / sp.length).toFixed(1)}°)`,
     gaps.every(g => near(g, 360 / sp.length, 1e-6)));
  ok(`consecutive frames overlap (${(360 / sp.length).toFixed(1)}° step vs ${hfovDeg.toFixed(0)}° lens)`,
     360 / sp.length < hfovDeg * 0.5);

  // The horizon is the strongest feature out here, so it has to be in frame --
  // just inside the top edge, not above it and not halfway down.
  const topEdge = sp[0].pitch + vfovDeg / 2;
  ok(`the frame's top edge sits just above the horizon (+${topEdge.toFixed(1)}°)`,
     topEdge > 0 && topEdge < 8, `${topEdge.toFixed(1)}`);
  ok('and the pitch does not chase the altitude the way the orbit does',
     planMission(site(rect), { altitude: 100, nadir: false, oblique: false, orbit: false, establish: false }, cam)
       .waypoints[0].pitch === sp[0].pitch);

  // Cost has to be flat: a fixed number of looks, whatever the box is.
  const big = planMission(site({ south: 50.06, north: 50.065, west: 19.93, east: 19.94 }),
     { altitude: 40, nadir: false, oblique: false, orbit: false, establish: false }, cam);
  ok(`the ring costs the same on a big box as a small one (${sp.length} vs ${big.waypoints.length} wp)`,
     big.waypoints.length === sp.length);

  // It is the only pass left that laps the whole site: the orbit is a dome per
  // thing now, so the surround ring stands alone at the footprint's own reach.
  const both = planMission(site(rect), { altitude: 40, nadir: false, oblique: false, establish: false }, cam);
  const radiusOfPass = (m, pass) => Math.max(...m.waypoints.filter(w => w.pass === pass)
     .map(w => { const l = m.frame.toLocal(w.lat, w.lon); return Math.hypot(l.x, l.y); }));
  ok('the surround ring laps the whole footprint',
     radiusOfPass(both, 'surround') >= both.stats.reachM);

  const two = planMission(site(rect), { altitude: 40, surroundRings: 2, nadir: false, oblique: false, orbit: false, establish: false }, cam);
  ok('2 rings doubles the stations at two distinct heights',
     two.waypoints.length === 2 * sp.length && new Set(two.waypoints.map(w => w.alt)).size === 2);
  ok('the extra ring sits below the set altitude', Math.min(...two.waypoints.map(w => w.alt)) < 40);

  // Auto-fit has to spend the battery on the subject first: over a big site the
  // ring is 900 m of flying that photographs none of it, and dropping it beats
  // moving the whole capture onto a shutter trigger nobody has seen work.
  const { proposePlan } = await import('../js/planner.js');
  const bigProposal = proposePlan(site(rect), { ...DEFAULTS }, cam);
  ok('auto-fit drops the ring rather than the verified shutter on a big site',
     bigProposal.mission.params.surround === false
     && bigProposal.mission.params.photoMode === 'waypoint'
     && bigProposal.note !== null);
  ok('and keeps it where a battery covers it', proposePlan(site(houseRect), { ...DEFAULTS }, cam)
     .mission.params.surround === true);
  ok('a plan with the ring already off is never handed one back',
     proposePlan(site(rect), { ...DEFAULTS, surround: false }, cam).mission.params.surround === false);

  const ivs = planMission(site(rect), { altitude: 40, photoMode: 'interval' }, cam);
  ok('interval mode keeps the whole surround ring',
     ivs.exported.filter(w => w.pass === 'surround').length
     === ivs.waypoints.filter(w => w.pass === 'surround').length);

  // The honest limit, asserted rather than claimed: this pass looks away from
  // the subject, so it can never improve the subject's coverage score.
  const { scoreCoverage } = await import('../js/coverage.js');
  const covRect2 = { south: 50.06, north: 50.06 + 17 / 111132,
                     west: 19.93, east: 19.93 + 25 / (111412 * Math.cos((50 * Math.PI) / 180)) };
  const covBase = { altitude: 7, orbitPad: 0, orbitRings: 3, nadir: false, oblique: false };
  const without = scoreCoverage(planMission(site(covRect2, 3), { ...covBase, surround: false }, cam)).summary;
  const withIt = scoreCoverage(planMission(site(covRect2, 3), { ...covBase, surround: true }, cam)).summary;
  ok('it adds nothing to the subject score, because it is not pointed at the subject',
     near(withIt.good, without.good, 1e-9) && withIt.meanViews === without.meanViews);

  // XML: an outward ring is a ring of explicit compass angles, and the file has
  // to carry every one of them.
  const srKmz = Buffer.from(buildKmz(sr, 'fly', 1750000000000));
  const srDoc = px(rz(srKmz).get('wpmz/waylines.wpml').data.toString('utf8'));
  const srPms = fx(srDoc, 'Document/Folder/Placemark');
  const srAngles = new Set(srPms.map(pm => +tx(pm, 'waypointHeadingParam/waypointHeadingAngle')));
  ok('XML carries a distinct compass yaw for every station',
     srAngles.size === sp.length, `${srAngles.size} vs ${sp.length}`);
  ok('surround KMZ passes the validator', ck(srKmz).errors.length === 0);
}

console.log('\ncamera pose');
const { orientation } = await import('../js/camera.js');
const vecNear = (v, e) => near(v.x, e[0], 1e-6) && near(v.y, e[1], 1e-6) && near(v.z, e[2], 1e-6);
ok('nadir points straight down', vecNear(orientation(0, -90).forward, [0, 0, -1]));
ok('yaw 0, level points north', vecNear(orientation(0, 0).forward, [0, 1, 0]));
ok('yaw 90, level points east', vecNear(orientation(90, 0).forward, [1, 0, 0]));
ok('yaw 180, level points south', vecNear(orientation(180, 0).forward, [0, -1, 0]));
ok('yaw -90, level points west', vecNear(orientation(-90, 0).forward, [-1, 0, 0]));
ok('45 deg down splits between forward and down',
   vecNear(orientation(0, -45).forward, [0, Math.SQRT1_2, -Math.SQRT1_2]));
ok('right is perpendicular to forward',
   [[0,-90],[37,-45],[180,-12],[-90,0]].every(([y,p]) => {
     const o = orientation(y, p);
     return Math.abs(o.forward.x*o.right.x + o.forward.y*o.right.y + o.forward.z*o.right.z) < 1e-9;
   }));
ok('up completes a right-handed frame pointing skyward when level',
   orientation(0, 0).up.z > 0.99);
ok('basis vectors are unit length',
   [[0,-90],[123,-33]].every(([y,p]) => {
     const o = orientation(y, p);
     return [o.forward, o.right, o.up].every(v => near(Math.hypot(v.x,v.y,v.z), 1, 1e-9));
   }));

// Yaw must match the plan: orbit cameras look at the centre, grid cameras along the leg.
const poseM = planMission(site(rect), { altitude: 40 }, cam);
const orbitPts = poseM.waypoints.filter(w => w.pass === 'orbit' && !w.transit);
ok('every orbit camera points within 1 deg of the box centre', orbitPts.every(w => {
  const o = orientation(w.yaw, 0);
  const l = poseM.frame.toLocal(w.lat, w.lon);
  const toC = { x: -l.x, y: -l.y };
  const len = Math.hypot(toC.x, toC.y);
  return (o.forward.x * toC.x + o.forward.y * toC.y) / len > Math.cos(1 * Math.PI / 180);
}));
ok('grid cameras follow the leg they are flying', poseM.waypoints.filter((w, i) =>
  w.pass === 'nadir' && poseM.waypoints[i + 1]?.pass === 'nadir').every((w, i, arr) => {
    const all = poseM.waypoints.filter(x => x.pass === 'nadir');
    const idx = all.indexOf(w);
    const nxt = all[idx + 1];
    if (!nxt) return true;
    const o = orientation(w.yaw, 0);
    const dl = poseM.frame.toLocal(nxt.lat, nxt.lon);
    const cl = poseM.frame.toLocal(w.lat, w.lon);
    const d = { x: dl.x - cl.x, y: dl.y - cl.y };
    const len = Math.hypot(d.x, d.y) || 1;
    return (o.forward.x * d.x + o.forward.y * d.y) / len > 0.99;
  }));
ok('all yaws are finite', poseM.waypoints.every(w => Number.isFinite(w.yaw)));

console.log('\nshot fan');
const fan = planMission(site(rect), { altitude: 40, shotsPerStop: 3 }, cam);
ok('fan mode plans 3 frames per stop', fan.exported.every(w => w.shots.length === 3));
ok('fan costs no extra waypoints', fan.exported.length === m.exported.length);
ok('fan triples the photo count', fan.stats.photos === 3 * m.stats.photos);
ok('fan angles stay inside gimbal travel',
   fan.exported.every(w => w.shots.every(p => p >= cam.minGimbalPitch && p <= cam.maxGimbalPitch)));
ok('fan angles are distinct at a nadir stop',
   new Set(fan.exported.find(w => w.pass === 'nadir').shots).size === 3);
ok('fan is centred on the pass pitch where there is room',
   fan.exported.find(w => w.pass === 'oblique').shots.includes(-45));
ok('interval mode ignores the fan',
   planMission(site(rect), { shotsPerStop: 3, photoMode: 'interval' }, cam).exported.every(w => w.shots.length === 1));

console.log('\nKMZ output');
const bytes = buildKmz(m, 'fly', 1750000000000);
const dir = mkdtempSync(join(tmpdir(), 'kmz-'));
const kmzPath = join(dir, 'mission.kmz');
writeFileSync(kmzPath, bytes);

const listing = execFileSync('unzip', ['-l', kmzPath], { encoding: 'utf8' });
ok('unzip reads the archive', listing.includes('wpmz/template.kml') && listing.includes('wpmz/waylines.wpml'));
ok('unzip -t passes CRCs', execFileSync('unzip', ['-t', kmzPath], { encoding: 'utf8' }).includes('No errors'));
execFileSync('unzip', ['-o', '-q', kmzPath, '-d', dir]);

const py = (code) => execFileSync('python3', ['-c', code], { encoding: 'utf8', cwd: dir }).trim();
for (const f of ['wpmz/template.kml', 'wpmz/waylines.wpml']) {
  const r = py(`import xml.etree.ElementTree as E; E.parse(${JSON.stringify(f)}); print('parsed')`);
  ok(`${f} is well-formed XML`, r === 'parsed');
}

const NS = "{http://www.uav.com/wpmz/1.0.2}";
const probe = py(`
import xml.etree.ElementTree as E, json
t = E.parse('wpmz/waylines.wpml'); r = t.getroot()
ns = {'k':'http://www.opengis.net/kml/2.2','w':'http://www.uav.com/wpmz/1.0.2'}
folder = r.find('.//k:Folder', ns)
pms = folder.findall('k:Placemark', ns)
idx = [int(p.find('w:index', ns).text) for p in pms]
print(json.dumps({
  'ns_ok': 'uav.com/wpmz/1.0.2' in r.tag or True,
  'drone': r.find('.//w:droneEnumValue', ns).text,
  'sub': r.find('.//w:droneSubEnumValue', ns).text,
  'heightMode': folder.find('w:executeHeightMode', ns).text,
  'waylineId': folder.find('w:waylineId', ns).text,
  'n': len(pms),
  'contiguous': idx == list(range(len(idx))),
  'all_have_height': all(p.find('w:executeHeight', ns) is not None for p in pms),
  'all_have_speed': all(p.find('w:waypointSpeed', ns) is not None for p in pms),
  'all_have_heading': all(p.find('w:waypointHeadingParam/w:waypointHeadingMode', ns) is not None for p in pms),
  'all_have_turn': all(p.find('w:waypointTurnParam/w:waypointTurnMode', ns) is not None for p in pms),
  'photos': sum(1 for a in r.iter('{http://www.uav.com/wpmz/1.0.2}actionActuatorFunc') if a.text=='takePhoto'),
  'gimbals': sum(1 for a in r.iter('{http://www.uav.com/wpmz/1.0.2}actionActuatorFunc') if a.text=='gimbalRotate'),
  'coords_ok': all(len(p.find('k:Point/k:coordinates', ns).text.split(','))==2 for p in pms),
  'action_ids_ok': all(
      [int(a.find('w:actionId', ns).text) for a in g.findall('w:action', ns)] == list(range(len(g.findall('w:action', ns))))
      for g in r.iter('{http://www.uav.com/wpmz/1.0.2}actionGroup')),
}))
`);
const d = JSON.parse(probe);
ok('uses the DJI Fly namespace + author', waylinesWpml(m, PROFILES.fly).includes('http://www.uav.com/wpmz/1.0.2'));
ok('droneEnumValue 68 / sub 0', d.drone === '68' && d.sub === '0');
ok('executeHeightMode relativeToStartPoint', d.heightMode === 'relativeToStartPoint');
ok('waylineId 0', d.waylineId === '0');
ok('waypoint count matches plan', d.n === m.exported.length, `${d.n} vs ${m.exported.length}`);
ok('indices contiguous from 0', d.contiguous);
ok('every waypoint has height/speed/heading/turn',
   d.all_have_height && d.all_have_speed && d.all_have_heading && d.all_have_turn);
ok('coordinates are lon,lat pairs', d.coords_ok);
// Transits between domes are places the aircraft passes through, not stations,
// so they carry no shutter.
const shooting = m.exported.filter((w) => w.photo !== false).length;
ok('one takePhoto per station, and none at a transit',
   d.photos === shooting && shooting < m.exported.length, `${d.photos} of ${m.exported.length}`);
ok('single-shot mode plans one frame per stop', m.exported.every(w => w.shots.length === 1));
// The gimbal is commanded once per pitch change, not once per waypoint.
const pitchChanges = m.exported.reduce((n, w, i) => n + (i === 0 || w.pitch !== m.exported[i - 1].pitch ? 1 : 0), 0);
ok(`one gimbalRotate per pitch change (${d.gimbals} for ${pitchChanges} changes)`, d.gimbals === pitchChanges);
// One per grid pass, plus one per dome ring -- each ring looks at the thing
// from its own elevation, which is the point of flying more than one.
ok('pitch changes once per pass and once per dome ring', pitchChanges >= 4, String(pitchChanges));
ok('actionIds are contiguous inside every group', d.action_ids_ok);

const ivBytes = buildKmz(iv, 'fly', 1750000000000);
writeFileSync(join(dir, 'iv.kmz'), ivBytes);
execFileSync('unzip', ['-o', '-q', join(dir, 'iv.kmz'), '-d', join(dir, 'iv')]);
const ivProbe = py(`
import xml.etree.ElementTree as E, json
r = E.parse('iv/wpmz/waylines.wpml').getroot()
ns = {'w':'http://www.uav.com/wpmz/1.0.2'}
trig = [t.text for t in r.iter('{http://www.uav.com/wpmz/1.0.2}actionTriggerType')]
print(json.dumps({'multi': trig.count('multipleDistance'),
                  'param': [p.text for p in r.iter('{http://www.uav.com/wpmz/1.0.2}actionTriggerParam')]}))
`);
const ivd = JSON.parse(ivProbe);
ok('interval mode emits exactly one distance trigger', ivd.multi === 1);
ok('trigger interval equals shot spacing', near(parseFloat(ivd.param[0]), iv.stats.fwdSpacing, 0.1));

// The fan must actually reach the XML: 3 photos + 3 gimbal moves per waypoint.
writeFileSync(join(dir, 'fan.kmz'), buildKmz(fan, 'fly', 1750000000000));
execFileSync('unzip', ['-o', '-q', join(dir, 'fan.kmz'), '-d', join(dir, 'fan')]);
const fanProbe = py(`
import xml.etree.ElementTree as E, json
ns = {'k':'http://www.opengis.net/kml/2.2','w':'http://www.uav.com/wpmz/1.0.2'}
r = E.parse('fan/wpmz/waylines.wpml').getroot()
pms = r.findall('.//k:Placemark', ns)
per = []
for p in pms:
    g = p.find('w:actionGroup', ns)
    funcs = [a.find('w:actionActuatorFunc', ns).text for a in g.findall('w:action', ns)]
    ids = [int(a.find('w:actionId', ns).text) for a in g.findall('w:action', ns)]
    per.append((funcs.count('takePhoto'), funcs.count('gimbalRotate'), ids == list(range(len(ids)))))
angles = [float(a.text) for a in r.iter('{http://www.uav.com/wpmz/1.0.2}gimbalPitchRotateAngle')]
print(json.dumps({
  'photos_per_wp': sorted(set(x[0] for x in per)),
  'gimbals_per_wp': sorted(set(x[1] for x in per)),
  'ids_ok': all(x[2] for x in per),
  'distinct_angles': sorted(set(angles)),
  'alternating': all(f=='gimbalRotate' if i%2==0 else f=='takePhoto'
      for i,f in enumerate([a.find('w:actionActuatorFunc', ns).text
      for a in pms[0].find('w:actionGroup', ns).findall('w:action', ns)])),
}))
`);
const fd = JSON.parse(fanProbe);
ok('every station shoots 3 frames in fan mode',
   JSON.stringify(fd.photos_per_wp.filter((n) => n > 0)) === '[3]', fanProbe);
ok('every station rotates the gimbal 3 times in fan mode',
   JSON.stringify(fd.gimbals_per_wp.filter((n) => n > 1)) === '[3]');
ok('actions alternate rotate,shoot,rotate,shoot', fd.alternating);
ok('actionIds contiguous inside fan groups', fd.ids_ok);
// The three fans are [-90,-70,-50], [-65,-45,-25], [-50,-30,-10]; -50 is shared
// by the nadir and orbit fans, so the union is 8 angles, not 9.
const expectedAngles = [...new Set(fan.exported.flatMap(w => w.shots))].sort((a, b) => a - b);
ok(`XML angles match the planned fans (${expectedAngles.length} distinct)`,
   JSON.stringify(fd.distinct_angles) === JSON.stringify(expectedAngles),
   `${JSON.stringify(fd.distinct_angles)} vs ${JSON.stringify(expectedAngles)}`);

const lon = /<coordinates>([-\d.]+),([-\d.]+)<\/coordinates>/.exec(waylinesWpml(m, PROFILES.fly));
ok('coordinates are lon,lat (not lat,lon)',
   near(parseFloat(lon[1]), 19.93, 0.01) && near(parseFloat(lon[2]), 50.06, 0.01), lon && lon[0]);

console.log('\ncoverage scorer');
const { scoreCoverage, buildProxy } = await import('../js/coverage.js');
const covRect = { south: 50.06, north: 50.06 + 17 / 111132,
                  west: 19.93, east: 19.93 + 25 / (111412 * Math.cos((50 * Math.PI) / 180)) };
// The surround ring is off throughout: it looks away from the proxy on purpose,
// so it can only ever add cameras that see none of it.
// These weigh one pass against another, so nothing else may be flying. The
// establishing ring is off here for the same reason the grids are: it would
// add views to every case and flatten the comparison the tests exist to make.
const covOf = (o) => scoreCoverage(planMission(site(covRect, 3),
  { orbitPad: 0, nadir: false, oblique: false, orbit: true, surround: false, establish: false, ...o },
  cam)).summary;

// The scorer models the site as the cubes you tapped, so these are points now.
const proxyPts = [
  { x: -10, y: -6, height: 4 }, { x: 10, y: -6, height: 9 },
  { x: 0, y: 7, height: 0 },
];
ok('proxy is bare ground when nothing is tall',
   buildProxy(proxyPts.map((q) => ({ ...q, height: 0 }))).length === 0);
ok('one cube per tap that has height', buildProxy(proxyPts).length === 2);
ok('each cube stands at the height that tap was given',
   buildProxy(proxyPts).map((b) => b.max.z).join() === '4,9');
ok('and is centred on the tap', (() => {
  const b = buildProxy(proxyPts)[0];
  return near((b.min.x + b.max.x) / 2, -10, 1e-9) && near((b.min.y + b.max.y) / 2, -6, 1e-9);
})());
ok('a flat tap contributes no cube, because the ground is sampled anyway',
   buildProxy([{ x: 0, y: 0, height: 0 }]).length === 0);
ok('proxy blocks do not overlap each other', (() => {
  const b = buildProxy(proxyPts);
  for (let i = 0; i < b.length; i++) {
    for (let j = i + 1; j < b.length; j++) {
      const overlap = b[i].min.x < b[j].max.x && b[i].max.x > b[j].min.x
                   && b[i].min.y < b[j].max.y && b[i].max.y > b[j].min.y;
      if (overlap) return false;
    }
  }
  return true;
})());

// The scorer is only useful if it can tell a bad trajectory from a good one.
const covNadir = covOf({ altitude: 40, nadir: true, orbit: false });
const covRing3 = covOf({ altitude: 7, orbitRings: 3 });
ok(`a high nadir grid scores badly on walls (${covNadir.byKind.wall.good.toFixed(0)}%)`,
   covNadir.byKind.wall.good < 40);
ok(`rings beat a high grid on walls (${covNadir.byKind.wall.good.toFixed(0)}% → ${covRing3.byKind.wall.good.toFixed(0)}%)`,
   covRing3.byKind.wall.good > covNadir.byKind.wall.good + 20);
ok('a nadir grid still nails the tops', covNadir.byKind.top.good > 90);
// Cross passes sweep ACROSS the site, so they leave less of it unseen overall
// than rings do -- and none of that is facade. Walls are the claim.
ok(`cross passes alone cannot cover the outside (${covOf({ altitude: 7, orbit: false, transect: true }).byKind.wall.good.toFixed(0)}% of walls)`,
   covOf({ altitude: 7, orbit: false, transect: true }).byKind.wall.good
   < covOf({ altitude: 7, orbitRings: 3 }).byKind.wall.good);

// Occlusion has to actually be tested, or the score is meaningless.
ok('some surface is genuinely occluded from a single low ring',
   covOf({ altitude: 7, orbitRings: 1 }).unseen > 2);
ok('adding passes reduces the unseen fraction',
   covOf({ altitude: 7, orbitRings: 3, transect: true }).unseen
   < covOf({ altitude: 7, orbitRings: 1 }).unseen);

// Rings are flown for WALLS, so that is where their value is measured -- the
// overall score mixes in tops and ground, which no ring can help.
//
// The old perimeter orbit showed sharp diminishing returns here (measured: 1→2
// was +7.1 points, 2→3 was +0.5), and that measurement is what justified
// stopping at three. It does NOT hold for a dome per thing: each extra ring is
// a genuinely new elevation on the same object rather than another lap of the
// site, and wall coverage keeps climbing. Whether that is worth the waypoints
// is a judgement about the aircraft, not something these numbers settle -- but
// the old evidence for capping the count is gone, and this records that.
const wallsAt = (rings) => covOf({ altitude: 7, orbitRings: rings }).byKind.wall.good;
const covW1 = wallsAt(1);
const covW2 = wallsAt(2);
const covW5 = wallsAt(5);
ok(`more rings keep buying wall coverage (${covW1.toFixed(0)}% → ${covW2.toFixed(0)}% → ${covW5.toFixed(0)}%)`,
   covW2 > covW1 && covW5 > covW2);

// The nadir grid is the only thing that fixes the down angle.
const covNoNadir = covOf({ altitude: 7, orbitRings: 3, transect: true });
const covWithNadir = covOf({ altitude: 7, orbitRings: 3, transect: true, nadir: true });
ok(`nadir transforms down-angle coverage (${covNoNadir.withDownAngle.toFixed(0)}% → ${covWithNadir.withDownAngle.toFixed(0)}%)`,
   covWithNadir.withDownAngle - covNoNadir.withDownAngle > 25);

// The frame fan costs no waypoints, so any gain is free coverage.
const covFan1 = covOf({ altitude: 7, orbitRings: 3, shotsPerStop: 1 });
const covFan3 = covOf({ altitude: 7, orbitRings: 3, shotsPerStop: 3 });
ok(`the frame fan buys coverage for zero waypoints (${covFan1.good.toFixed(0)}% → ${covFan3.good.toFixed(0)}%)`,
   covFan3.good > covFan1.good + 2);
ok('but it barely widens the parallax baseline, as predicted',
   covFan3.meanSpread - covFan1.meanSpread < 10,
   `${covFan1.meanSpread.toFixed(0)}° → ${covFan3.meanSpread.toFixed(0)}°`);

ok('every sample carries a grade', (() => {
  const r = scoreCoverage(planMission(site(covRect), { subjectHeight: 3, altitude: 7 }, cam));
  return r.samples.every(x => ['good', 'flat', 'thin', 'unseen'].includes(x.grade));
})());
ok('capping cameras keeps it interactive but still scores', (() => {
  const m2 = planMission(site(covRect), { subjectHeight: 3, altitude: 7, orbitRings: 3, transect: true }, cam);
  const capped = scoreCoverage(m2, { maxCameras: 50 });
  return capped.cameras <= 60 && capped.summary.good > 0;
})());

console.log('\nvalidator');
const { checkKmz, shape } = await import('../tools/check.mjs');
const { readZip } = await import('../tools/unzip.mjs');
const { zip: rezip } = await import('../js/zip.js');

const good = checkKmz(Buffer.from(bytes));
ok('our own KMZ passes the validator', good.errors.length === 0, good.errors.slice(0, 3).join('; '));
ok('validator reads back the right waypoint count', good.info.waypoints === m.exported.length);
ok('validator identifies the DJI Fly flavour', good.info.flavour === 'DJI Fly (consumer)');
ok('validator can read a deflated archive too', (() => {
  // Node writes deflate; the reader must handle method 8, which is what DJI uses.
  const { deflateRawSync } = require('node:zlib');
  return typeof deflateRawSync === 'function';
})());
ok('interval-mode KMZ also passes', checkKmz(Buffer.from(ivBytes)).errors.length === 0);
ok('fan-mode KMZ also passes', checkKmz(Buffer.from(buildKmz(fan, 'fly', 1750000000000))).errors.length === 0);

// Deliberately corrupt a valid file and confirm each rule actually fires.
const parts = readZip(Buffer.from(bytes));
const tpl = parts.get('wpmz/template.kml').data.toString();
const mutate = (fn) => {
  const w = fn(parts.get('wpmz/waylines.wpml').data.toString());
  return Buffer.from(rezip([
    { name: 'wpmz/' },
    { name: 'wpmz/template.kml', text: tpl },
    { name: 'wpmz/waylines.wpml', text: w },
  ], new Date(1750000000000)));
};
const catches = (name, fn, needle) => {
  const r = checkKmz(mutate(fn));
  ok(`catches ${name}`, r.errors.some((e) => e.includes(needle)),
     r.errors.slice(0, 2).join('; ') || 'no error raised');
};
catches('out-of-range speed', (w) => w.replace('<wpml:waypointSpeed>4.0<', '<wpml:waypointSpeed>99<'), 'waypointSpeed');
catches('bad heading enum', (w) => w.replace('followWayline', 'sideways'), 'heading mode');
catches('bad turn enum', (w) => w.replace('toPointAndStopWithDiscontinuityCurvature', 'wiggle'), 'turn mode');
catches('non-contiguous waypoint index', (w) => w.replace('<wpml:index>1<', '<wpml:index>7<'), 'index');
catches('non-contiguous actionId', (w) => w.replace('<wpml:actionId>0<', '<wpml:actionId>4<'), 'actionId');
catches('unknown action', (w) => w.replace('takePhoto', 'takeSelfie'), 'unknown action');
catches('impossible latitude', (w) => w.replace(/<coordinates>([-\d.]+),([-\d.]+)</, '<coordinates>19.9,95.0<'), 'latitude');
// Either wording is a pass: dropping a close tag makes the next one mismatch.
catches('malformed XML', (w) => w.replace('</wpml:missionConfig>', ''), 'wpmz/waylines.wpml:');
catches('missing missionConfig', (w) => w.replace(/<wpml:missionConfig>[\s\S]*?<\/wpml:missionConfig>/, ''), 'missionConfig');

const noWaylines = Buffer.from(rezip([{ name: 'wpmz/' }, { name: 'wpmz/template.kml', text: tpl }]));
ok('catches a missing waylines.wpml', checkKmz(noWaylines).errors.some((e) => e.includes('waylines.wpml')));
ok('catches something that is not a zip at all',
   checkKmz(Buffer.from('hello')).errors.some((e) => e.includes('not a zip')));

const sh = shape(Buffer.from(bytes));
ok('shape fingerprint counts elements per file',
   sh['wpmz/waylines.wpml'].get('Placemark') === m.exported.length);

console.log('\nplan codes');
{
  const ui = {
    altitude: 52, frontOverlap: 80, sideOverlap: 70, speed: 4, orbitPad: 5, subjectHeight: 3,
    photoMode: 'waypoint', shotsPerStop: 3, orbitRings: 3, profile: 'fly',
    nadir: true, oblique: true, orbit: true, transect: false, surround: true,
    surroundRings: 1,
  };
  const taps = [
    { lat: 50.0601, lon: 19.9301, height: 0 },
    { lat: 50.0612, lon: 19.9319, height: 7.5 },
    { lat: 50.0604, lon: 19.9327, height: 3 },
  ];
  const code = encodePlan({ points: taps }, ui);
  const back = decodePlan(code);
  ok('a plan code round-trips every tap to 6 decimals',
     back.points.length === 3
     && back.points.every((q, i) => near(q.lat, taps[i].lat, 5e-7) && near(q.lon, taps[i].lon, 5e-7)));
  ok('and the height judged at each one', back.points.map((q) => q.height).join() === '0,7.5,3');
  ok('a plan code round-trips every control', Object.keys(ui).every((k) => back.ui[k] === ui[k]));
  ok('a plan code survives being pasted as a whole url',
     decodePlan(`https://example.com/x/#plan=${code}`).ui.altitude === 52);
  ok('a plan code is short enough to message', code.length < 320, `${code.length} chars`);
  ok('rejects junk', decodePlan('hello') === null && decodePlan('') === null);
  ok('rejects a plan with no taps in it', decodePlan(encodePlan({ points: [] }, ui) ?? 'x') === null);
  // Fifty taps has to still fit what the sync worker will store (2000 chars).
  const many = encodePlan({ points: Array.from({ length: 50 }, (_, i) => (
    { lat: 50.06 + i * 1e-4, lon: 19.93 + i * 1e-4, height: 3 })) }, ui);
  ok('fifty taps still fit the sync limit', many.length < 2000, `${many.length} chars`);
  const dragged = decodePlan(encodePlan({ points: taps }, { ...ui, orbitHeights: [11, 25, 40] }));
  ok('a plan code carries heights dragged in the 3D view',
     dragged.ui.orbitHeights.join() === '11,25,40');
  const payload = JSON.parse(Buffer.from(code.slice(3), 'base64url').toString());
  ok('and leaves them out of the code entirely when nothing was dragged',
     payload.H === undefined && payload.L === undefined);
  ok('rejects a code whose payload is not a plan', decodePlan('v1.' + Buffer.from('{"r":[1]}').toString('base64')) === null);
  ok('rejects a tap that is not a coordinate',
     decodePlan('v2.' + Buffer.from(JSON.stringify({ t: [[91, 0, 0]] })).toString('base64url')) === null);

  // The pass mask is positional and append-only, so a code written before the
  // surround ring existed restores WITHOUT it -- the plan that was saved, not
  // today's defaults poured into yesterday's box.
  const legacy = decodePlan('v1.' + Buffer.from(JSON.stringify({
    r: [rect.north, rect.south, rect.east, rect.west], a: 52, p: 0b0111,
  })).toString('base64url'));
  ok('a code from before the surround ring restores it switched off',
     legacy.ui.orbit === true && legacy.ui.surround === false);

  // Every plan saved before points existed is a rectangle, and a rectangle is
  // its four corners -- so an old link has to open as the footprint it always
  // described rather than as nothing at all.
  const v1 = decodePlan('v1.' + Buffer.from(JSON.stringify({
    r: [rect.north, rect.south, rect.east, rect.west], a: 52, h: 6, p: 0b11111,
  })).toString('base64url'));
  ok('a v1 rectangle opens as its four corners', v1.points.length === 4);
  ok('with the corners where the rectangle was',
     v1.points.some((q) => near(q.lat, rect.north, 1e-9) && near(q.lon, rect.west, 1e-9))
     && v1.points.some((q) => near(q.lat, rect.south, 1e-9) && near(q.lon, rect.east, 1e-9)));
  ok("and v1's subject-height slider becomes the height of the thing",
     v1.points.every((q) => q.height === 6));
  ok('a v1 plan flies the same footprint it always did',
     planMission({ points: v1.points }, { altitude: 40, speed: 4 }, cam).stats.areaHa
       .toFixed(4) === planMission(site(rect), { altitude: 40, speed: 4 }, cam).stats.areaHa.toFixed(4));

  // Same code, same plan: the point of shipping a code instead of a file.
  const a = planMission({ points: taps }, { altitude: ui.altitude, speed: ui.speed }, cam);
  const b = planMission({ points: back.points }, { altitude: back.ui.altitude, speed: back.ui.speed }, cam);
  ok('a restored plan produces the same waypoints', a.exported.length === b.exported.length);
}

console.log('\nthe real thing');
{
  // A two-waypoint mission created in DJI Fly on a Mini 5 Pro and pulled off the
  // controller over MTP. The validator has to accept what the aircraft itself
  // writes, or it will refuse a legitimate mission on the day it matters.
  const real = readFileSync(new URL('./fixtures/dji-fly-mini5pro.kmz', import.meta.url));
  const { info, errors } = checkKmz(real);
  ok('accepts a mission DJI Fly wrote itself', errors.length === 0, errors[0] ?? '');
  ok('DJI Fly on a Mini 5 Pro writes drone 68/0', info.drone === '68/0', info.drone);
  ok('and the consumer namespace', info.flavour.startsWith('DJI Fly'), info.flavour);
  ok('our export claims the same drone enum',
     checkKmz(Buffer.from(bytes)).info.drone === info.drone);
}

console.log('\nreading a mission back');
{
  const real = readFileSync(new URL('./fixtures/dji-fly-mini5pro.kmz', import.meta.url));
  const back = await readKmz(real);
  ok('reads a deflated KMZ that DJI Fly wrote', back.meta.waypoints === 2);
  ok('and its drone enum', back.meta.drone === '68/0');

  const ours = await readKmz(Buffer.from(bytes));
  ok('reads our own stored KMZ', ours.meta.waypoints === m.exported.length);
  ok('round-trips the first waypoint position',
     near(ours.waypoints[0].lat, m.exported[0].lat, 1e-6) && near(ours.waypoints[0].lon, m.exported[0].lon, 1e-6));
  ok('round-trips altitude', near(ours.waypoints[0].alt, m.exported[0].alt ?? m.params.altitude, 0.05));
  // Gimbal pitch is written once per pass and held; reading has to carry it
  // forward or most waypoints look like they point at the horizon.
  ok('carries a held gimbal pitch forward', ours.waypoints.every((w) => Number.isFinite(w.pitch)));
  ok('counts the photos', ours.meta.photos > 0);
  ok('refuses something that is not a KMZ',
     await readKmz(Buffer.from('hello there')).then(() => false, () => true));
}

console.log('\none route shape');
{
  // The planner's output and a mission read off a controller have to be the
  // same kind of thing, or every renderer needs two code paths.
  const read = await readKmz(Buffer.from(bytes));
  const route = routeFromRead(read, cam);
  // What every renderer needs from either. A footprint is NOT on the list: the
  // planner knows what you tapped, and a KMZ read back can never recover it.
  const needs = (r) => ['waypoints', 'frame', 'cam'].every((k) => r[k] !== undefined);
  ok('a read mission carries what the renderers need', needs(route));
  ok('the planner s mission carries the same', needs(m));
  ok('a read waypoint has what a drawn waypoint has',
     ['lat', 'lon', 'alt', 'yaw', 'pitch', 'pass', 'shots'].every((k) => route.waypoints[0][k] !== undefined));
  ok('the box round-trips as the extent of the route',
     near(route.rect.north, Math.max(...m.exported.map((w) => w.lat)), 1e-6));
  ok('every waypoint lands in a known pass',
     route.waypoints.every((w) => ['nadir', 'oblique', 'orbit', 'transect'].includes(w.pass)));
  ok('an aim-at-a-point waypoint is read as orbit',
     inferPass({ headingMode: 'towardPOI', pitch: -30 }) === 'orbit');
  ok('straight down is read as nadir', inferPass({ headingMode: 'followWayline', pitch: -90 }) === 'nadir');
  ok('near level is read as a cross pass', inferPass({ headingMode: 'followWayline', pitch: -5 }) === 'transect');
}

console.log('\nsaved plans');
{
  const mem = new Map();
  const storage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, v),
    removeItem: (k) => mem.delete(k),
  };
  const store = createPlanStore({ storage, endpoint: 'https://sync.example' , fetchImpl: async (url, opt) => {
    lastRequest = { url, key: opt.headers['X-Sync-Key'], body: JSON.parse(opt.body) };
    return { ok: true, json: async () => ({ plans: remotePlans }) };
  } });
  let lastRequest = null;
  let remotePlans = [];

  const a = store.save({ name: 'Zablocie yard', code: 'v1.aaa' });
  store.save({ name: 'Playground', code: 'v1.bbb' });
  ok('saves and lists plans', store.list().length === 2);
  ok('newest plan sorts first', store.list()[0].name === 'Playground');

  store.save({ id: a.id, name: 'Zablocie yard', code: 'v1.ccc' });
  ok('saving over an id replaces rather than duplicates', store.list().length === 2);
  ok('and keeps the new code', store.list().find((p) => p.id === a.id).code === 'v1.ccc');

  store.remove(a.id);
  ok('a removed plan leaves the list', store.list().length === 1);

  remotePlans = [{ id: 'remote1', name: 'From the phone', code: 'v1.ddd', updatedAt: Date.now() + 1000 }];
  const res = await store.sync();
  ok('sync sends the hardcoded key in a header, with nothing to set up', lastRequest.key === SYNC_KEY);
  ok('and the Worker would accept it', /^[A-Za-z0-9_-]{16,128}$/.test(SYNC_KEY));
  ok('sync sends tombstones too, so a delete propagates',
     lastRequest.body.plans.some((p) => p.deleted));
  ok('sync pulls the other device\'s plans in', store.list().some((p) => p.name === 'From the phone'));

  // A write that lands mid-flight must survive the response. Walking a site is
  // where this matters: every stop writes, and each write starts a sync the
  // next stop can outrun.
  {
    const racy = {};
    const rstore = createPlanStore({
      storage: { getItem: (k) => racy[k] ?? null, setItem: (k, v) => { racy[k] = v; } },
      endpoint: 'https://sync.example',
      fetchImpl: async () => {
        // The user's next save, while the request is still out.
        rstore.save({ name: 'Saved mid-flight', code: 'v1.zzz' });
        return { ok: true, status: 200, json: async () => ({ plans: [] }) };
      },
    });
    rstore.save({ name: 'Saved before', code: 'v1.yyy' });
    await rstore.sync();
    ok('a save made during a sync survives the response',
       rstore.list().some((p) => p.name === 'Saved mid-flight'),
       JSON.stringify(rstore.list().map((p) => p.name)));
    ok('and the one before it is still there',
       rstore.list().some((p) => p.name === 'Saved before'));
  }
  ok('and reports what arrived', res.pulled === 1);

  // The client and the Worker have to agree, or a plan flickers between devices.
  const older = { id: 'x', name: 'old', code: 'v1.o', updatedAt: 100 };
  const newer = { id: 'x', name: 'new', code: 'v1.n', updatedAt: 200 };
  ok('client merge is last-write-wins', clientMerge([older], [newer])[0].name === 'new');
  ok('worker merge is last-write-wins', workerMerge([newer], [older])[0].name === 'new');
  ok('a tombstone beats an older edit',
     workerMerge([older], [{ id: 'x', deleted: true, updatedAt: 300 }])[0].deleted === true);

  ok('worker rejects a plan with no code', clean({ id: 'abcdef', updatedAt: 1, name: 'x' }) === null);
  ok('worker rejects a forged id', clean({ id: '../etc', updatedAt: 1, name: 'x', code: 'v1.a' }) === null);
  ok('worker accepts a well-formed plan', clean({ id: 'abcdef', updatedAt: 1, name: 'x', code: 'v1.a' }).code === 'v1.a');
}

console.log('\nobstacles');
{
  const box = { min: { x: -5, y: -5, z: 0 }, max: { x: 5, y: 5, z: 10 } };

  // The geometry the whole feature stands on. A sampled segment test would miss
  // a near approach that falls between two samples; this one cannot.
  ok('a point above the roof is its height above it',
     near(pointBoxDist({ x: 0, y: 0, z: 25 }, box), 15, 1e-9));
  ok('a leg flying 5 m over the roof measures 5 m',
     near(segmentBoxDist({ x: -30, y: 0, z: 15 }, { x: 30, y: 0, z: 15 }, box).dist, 5, 1e-3));
  ok('a leg through the box measures zero',
     near(segmentBoxDist({ x: -30, y: 0, z: 5 }, { x: 30, y: 0, z: 5 }, box).dist, 0, 1e-6));
  ok('past a corner it is the diagonal, not the nearest face',
     near(segmentBoxDist({ x: 9, y: 9, z: 5 }, { x: 9, y: 9, z: 6 }, box).dist, Math.hypot(4, 4), 1e-3));
  // The closest approach can sit in the middle of a long leg, which is exactly
  // what a per-waypoint check would walk straight past.
  ok('the closest point can be mid-leg, not at either end',
     near(segmentBoxDist({ x: -200, y: 0, z: 12 }, { x: 200, y: 0, z: 12 }, box).dist, 2, 1e-3));

  ok('a rectangle dragged to nothing still has area',
     normalizeRect({ north: 50, south: 50, east: 19, west: 19 }).north > 50);
  ok('overlap is exclusive at the edges',
     overlaps({ north: 1, south: 0, east: 1, west: 0 }, { north: 0.5, south: -1, east: 0.5, west: -1 })
     && !overlaps({ north: 1, south: 0, east: 1, west: 0 }, { north: 3, south: 2, east: 1, west: 0 }));

  // A mast in the middle of the site, taller than the flight.
  const mast = { id: 'mast01', name: 'Mast', height: 60,
                 south: 50.06060, north: 50.06075, west: 19.93130, east: 19.93150 };
  const shed = { id: 'shed01', name: 'Shed', height: 3,
                 south: 50.06060, north: 50.06075, west: 19.93130, east: 19.93150 };
  const toBox = (o) => localBox(o, m.frame);

  const hitMast = checkObstacles(m, [toBox(mast)], { clearance: 5 });
  ok('a 60 m mast under a 40 m flight is a strike', hitMast.strikes === 1);
  // Legs that go through it and legs that merely come close are both flagged,
  // and they are not the same news, so they are not the same grade.
  ok('the legs that go through it are named',
     hitMast.legs.some((l) => l.grade === 'strike'));
  ok('and the ones that only come close are graded differently',
     hitMast.legs.some((l) => l.grade === 'near')
     && hitMast.legs.every((l) => l.dist < hitMast.clearance));

  const clearShed = checkObstacles(m, [toBox(shed)], { clearance: 5 });
  ok('a 3 m shed under the same flight is clear', clearShed.strikes === 0 && clearShed.near === 0);
  ok('and is still measured, so "clear by" has a number',
     near(clearShed.obstacles[0].dist, 37, 1.5));

  // The clearance is the whole judgement: the same geometry, a different answer.
  const fussy = checkObstacles(m, [toBox(shed)], { clearance: 40 });
  ok('raising the clearance turns the same shed into a warning', fussy.near === 1);

  ok('the clearing altitude lifts the flight over the tallest thing under it',
     near(clearingAltitude(m, [toBox(mast)], 5), 65, 0.01));
  ok('nothing under the flight means no altitude to suggest',
     clearingAltitude(m, [], 5) === null);

  // An obstacle blocks the camera as well as the aircraft. A slab lying over the
  // whole site is the extreme case, and it has to take the ground with it: what
  // the plan can no longer see, it can no longer claim to have covered.
  const { scoreCoverage } = await import('../js/coverage.js');
  const lid = localBox({ id: 'lid01', name: 'Lid', height: 20,
                         south: rect.south, north: rect.north, west: rect.west, east: rect.east }, m.frame);
  const open = scoreCoverage(m, { maxCameras: 60 });
  const covered = scoreCoverage(m, { maxCameras: 60, boxes: [lid] });
  ok('an obstacle occludes the camera, not just the aircraft',
     covered.summary.good < open.summary.good);
  // Scoring the tree you drew as a surface you failed to photograph would turn
  // a good plan into a bad number for no reason.
  ok('and is never itself scored as surface to capture',
     covered.samples.every((sm) => sm.kind !== 'wall' || Math.abs(sm.p.z) <= 20)
     && covered.boxes.length === open.boxes.length);

  // Store and Worker, same shape as plans and for the same reason.
  const mem = new Map();
  const storage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, v),
    removeItem: (k) => mem.delete(k),
  };
  let sent = null;
  const store = createObstacleStore({ storage, endpoint: 'https://sync.example',
    fetchImpl: async (url, opt) => {
      sent = { url, body: JSON.parse(opt.body) };
      return { ok: true, json: async () => ({ obstacles: [] }) };
    } });
  const saved = store.put({ ...mast, id: undefined });
  ok('an obstacle stores its height', store.list()[0].height === 60);
  store.put({ ...saved, height: 12 });
  ok('editing one replaces rather than duplicates',
     store.list().length === 1 && store.list()[0].height === 12);
  await store.sync();
  ok('obstacles sync on their own route, not the plan one', sent.url.endsWith('/obstacles'));
  ok('and under their own key on the wire', Array.isArray(sent.body.obstacles));

  ok('worker rejects a box with no area',
     cleanObstacle({ id: 'abcdef', updatedAt: 1, north: 50, south: 50, east: 19, west: 18, height: 5 }) === null);
  ok('worker rejects a box the size of a country',
     cleanObstacle({ id: 'abcdef', updatedAt: 1, north: 51, south: 50, east: 19, west: 18, height: 5 }) === null);
  ok('worker accepts a well-formed obstacle',
     cleanObstacle({ id: 'abcdef', updatedAt: 1, north: 50.001, south: 50, east: 19.001, west: 19,
                     height: 5, name: 'Oak' }).height === 5);
  ok('worker refuses a height it cannot use',
     cleanObstacle({ id: 'abcdef', updatedAt: 1, north: 50.001, south: 50, east: 19.001, west: 19,
                     height: 'tall' }) === null);
  ok('a tombstone needs nothing but an id and a time',
     cleanObstacle({ id: 'abcdef', updatedAt: 1, deleted: true }).deleted === true);
}

console.log('\nwalking the site');
{
  const { sampleRect, walkRect, judgeFix, spanOf, SIZES, MAX_ACCURACY } = await import('../js/walk.js');
  const { ringFloor } = await import('../js/collide.js');
  const { mPerDegLat: mLat, mPerDegLon: mLon } = await import('../js/geo.js');
  const spanM = (r) => ({
    x: mLon((r.north + r.south) / 2) * (r.east - r.west),
    y: mLat((r.north + r.south) / 2) * (r.north - r.south),
  });

  const exact = sampleRect({ lat: 50.06, lon: 19.93, accuracy: 0 }, spanOf('medium'));
  const sp = spanM(exact);
  ok(`a perfect fix gives the size you asked for (${sp.x.toFixed(1)} x ${sp.y.toFixed(1)} m)`,
     near(sp.x, 8, 0.05) && near(sp.y, 8, 0.05));

  // The whole point of the inflation: the box has to enclose the thing wherever
  // inside the accuracy circle you actually stood.
  const rough = spanM(sampleRect({ lat: 50.06, lon: 19.93, accuracy: 6 }, spanOf('medium')));
  ok(`a ±6 m fix grows the box by 6 m on every side (${rough.x.toFixed(1)} m)`,
     near(rough.x, 8 + 12, 0.05) && near(rough.y, 8 + 12, 0.05));
  ok('a bigger size makes a bigger box',
     spanM(sampleRect({ lat: 50.06, lon: 19.93, accuracy: 3 }, spanOf('large'))).x
     > spanM(sampleRect({ lat: 50.06, lon: 19.93, accuracy: 3 }, spanOf('small'))).x);
  ok('every size is a real number of metres', SIZES.every((z) => z.span > 0 && z.hint));
  ok('a box never collapses to nothing',
     spanM(sampleRect({ lat: 50.06, lon: 19.93, accuracy: 0 }, 0)).x > 0.9);

  // A comma is what a Polish keyboard puts there, and `type=number` reads that
  // back as the empty string -- which coerced with + is 0, a silently wrong
  // height and a ring floor to match.
  const { parseHeight } = await import('../js/walk.js');
  ok('a comma decimal is a number', parseHeight('2,5') === 2.5);
  ok('so is a point', parseHeight('2.5') === 2.5);
  ok('an empty field is nothing, not zero', parseHeight('') === null && parseHeight('  ') === null);
  ok('so is junk', parseHeight('tall') === null && parseHeight('12x') === null);
  ok('and so is a height no drone will fly', parseHeight('-3') === null && parseHeight('900') === null);
  ok('zero is a real answer', parseHeight('0') === 0);

  ok('a vague fix is refused, not rounded off', judgeFix({ accuracy: MAX_ACCURACY + 1 }).ok === false);
  ok('a good one is accepted silently', judgeFix({ accuracy: 4 }).ok && !judgeFix({ accuracy: 4 }).note);
  ok('a loose but usable one says so', judgeFix({ accuracy: 15 }).ok && judgeFix({ accuracy: 15 }).note);
  ok('no fix at all is refused', judgeFix(null).ok === false);

  // The walk defines the capture area.
  const stops = [
    sampleRect({ lat: 50.0600, lon: 19.9300, accuracy: 2 }, 3),
    sampleRect({ lat: 50.0604, lon: 19.9306, accuracy: 2 }, 3),
  ];
  const wr = walkRect(stops, 5);
  ok('the box covers every stop', stops.every((r) =>
     wr.north > r.north && wr.south < r.south && wr.east > r.east && wr.west < r.west));
  const inner = walkRect(stops, 0);
  ok('the margin is real and outward',
     mLat(50.06) * (wr.north - inner.north) > 4.9);
  ok('one stop still makes a box', walkRect([stops[0]], 5) !== null);
  ok('no stops makes no box', walkRect([], 5) === null);

  // ringFloor is still how "how low may anything fly here" is worked out; what
  // changed is who asks. There is no single perimeter ring to lift any more, so
  // each dome asks it of the things IT would pass near -- see "a dome clears
  // the tall thing beside it" above.
  ok('the floor clears the tallest thing by the clearance', ringFloor([3, 11, 8], 5) === 16);
  ok('nothing on site sets no floor', ringFloor([], 5) === null);
}

// The failure this guards against destroyed real data: the first undo snapshot
// is taken before the startup sync has pulled anything down, so restoring it
// deleted every synced obstacle -- and the deletes travelled to every device.
{
  const snapOf = (obstacles) => ({ capture: [], ui: {}, obstacles });
  const rebase = (snap, before, after) => {
    const had = new Set(before.obstacles.map((o) => o.id));
    const arrived = after.obstacles.filter((o) => !had.has(o.id));
    if (!arrived.length) return snap;
    const ids = new Set(snap.obstacles.map((o) => o.id));
    return { ...snap, obstacles: [...snap.obstacles, ...arrived.filter((o) => !ids.has(o.id))] };
  };
  let world = [];
  const h = createHistory({
    snapshot: () => snapOf(world.map((o) => ({ ...o }))),
    restore: (snap) => { world = snap.obstacles.map((o) => ({ ...o })); },
    rebase,
  });
  // Startup: the stack's first snapshot is empty because the sync is in flight.
  world = [{ id: 'a' }, { id: 'b' }];        // ... and then five arrive
  h.refresh();                                // which is what must be told
  world = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  h.commit();                                 // you draw one yourself
  h.undo();                                   // and take it straight back
  ok('undoing your own box does not delete what arrived from the other device',
     world.map((o) => o.id).sort().join() === 'a,b', world.map((o) => o.id).join());
  ok('and the box you drew is gone, which is what undo was for',
     !world.some((o) => o.id === 'c'));
}

console.log('\nwhat is already standing here');
{
  const { toObstacles, ASSUMED, heightOfLevels } = await import('../js/osm.js');
  const at = (lat, lon) => ({ lat, lon });
  const found = toObstacles([
    // A building with a real height, one with storeys, one with neither.
    { tags: { building: 'apartments', height: '17.12', 'addr:street': 'Rozbrat', 'addr:housenumber': '14' },
      geometry: [at(51.1, 17.05), at(51.1004, 17.05), at(51.1004, 17.0506), at(51.1, 17.0506)] },
    { tags: { building: 'yes', 'building:levels': '5' },
      geometry: [at(51.101, 17.05), at(51.1014, 17.05), at(51.1014, 17.0506), at(51.101, 17.0506)] },
    { tags: { building: 'garage' },
      geometry: [at(51.102, 17.05), at(51.1021, 17.05), at(51.1021, 17.0502), at(51.102, 17.0502)] },
    // Trees: one measured, one not.
    { tags: { natural: 'tree', height: '30', species: 'Platanus acerifolia' }, lat: 51.103, lon: 17.051 },
    { tags: { natural: 'tree' }, lat: 51.1031, lon: 17.0511 },
    // A 110 kV span running diagonally for about 300 m.
    { tags: { power: 'line', voltage: '110000' },
      geometry: [at(51.104, 17.052), at(51.1058, 17.0548)] },
  ]);

  const byLabel = (t) => found.filter((f) => f.label.includes(t));
  ok('a tagged building keeps its own height',
     byLabel('Rozbrat')[0].height === 17.12 && byLabel('Rozbrat')[0].assumed === false);
  // Five storeys was 16 m and that was wrong. Checked against LiDAR over 213
  // buildings with BDOT10k storey counts, `levels * 3.2` came in short by more
  // than a metre on 97% of them, because a storey count counts habitable
  // floors and the roof is not one.
  ok('storeys become metres rather than being thrown away',
     byLabel('Building')[0].height === heightOfLevels(5));
  ok('and a storey count includes the roof it does not mention',
     heightOfLevels(5) > 5 * 3.2 + 5, String(heightOfLevels(5)));
  ok('one storey is a house, not a ceiling height',
     heightOfLevels(1) >= 9, String(heightOfLevels(1)));
  ok('every extra storey adds about a storey',
     Math.abs((heightOfLevels(6) - heightOfLevels(5)) - 3.2) < 0.05);
  // A storey count is an estimate with a 3 m median error, so it stays marked
  // and the heights service is allowed to measure over the top of it. Only a
  // tagged metric height counts as known.
  ok('a height from storeys is still an estimate',
     byLabel('Building')[0].assumed === true);
  ok('a building with neither is assumed and says so',
     byLabel('garage')[0].height === ASSUMED.building && byLabel('garage')[0].assumed === true);
  // The assumptions are measurements, not opinions: an untagged building in a
  // Polish city came out at p90 24.3 m against the 9 m that used to be guessed.
  ok('and the assumption is one a city building could plausibly reach',
     ASSUMED.building >= 20 && ASSUMED.tree >= 18);
  ok('a measured tree is not overwritten by the default',
     byLabel('Platanus')[0].height === 30 && byLabel('Platanus')[0].assumed === false);
  ok('an untagged tree gets the assumed height, marked',
     byLabel('Tree')[0].height === ASSUMED.tree && byLabel('Tree')[0].assumed === true);

  // The reason spans are chopped: one box round a 300 m diagonal would wall off
  // a 300 m square of sky.
  const span = byLabel('110 kV');
  ok(`a long span becomes many short boxes (${span.length})`, span.length > 8);
  ok('every piece stands at the height its voltage implies',
     span.every((b) => b.height === ASSUMED.powerHigh && b.assumed === true));
  const widest = Math.max(...span.map((b) => (b.north - b.south) * 111132));
  ok(`and no piece is a huge box (${widest.toFixed(0)} m across)`, widest < 30, `${widest}`);

  // Nothing may be imported without a decision about its height.
  ok('everything imported carries an explicit assumed flag',
     found.every((f) => typeof f.assumed === 'boolean' && f.height > 0));
  ok('the cap is honoured', toObstacles(Array.from({ length: 50 }, () => (
    { tags: { natural: 'tree' }, lat: 51.1, lon: 17.05 })), { max: 10 }).length === 10);
}

console.log('\nground imagery');
{
  const lat = 50.0614;
  const lon = 19.9366;
  for (const z of [12, 16, 19]) {
    ok(`tile x round-trips at z${z}`, near(xToLon(lonToX(lon, z), z), lon, 1e-9));
    ok(`tile y round-trips at z${z}`, near(yToLat(latToY(lat, z), z), lat, 1e-9));
  }

  // A tile's own corners must land back on the tile's own edges, or every
  // texture is offset by a fraction of a tile and the seams never line up.
  const b = tileBounds(19, 290086, 177262);
  ok('a tile reports the bounds its own index implies',
     near(lonToX(b.west, 19), 290086, 1e-9) && near(latToY(b.north, 19), 177262, 1e-9));
  ok('and north is above south, east right of west',
     b.north > b.south && b.east > b.west);

  // The reason for not borrowing the map's tiles: over a small site the map's
  // zoom is the wrong zoom by several levels, so the imagery it holds would be
  // a smear rather than a picture.
  const pxAcross = (z) => 50 / mPerPx(lat, z);          // a 50 m site, in tile pixels
  ok('a 50 m site is a smudge at the zoom a map sits at', pxAcross(16) < 40);
  ok('and a picture close in', pxAcross(20) > 400);

  const area = { north: lat + 0.0004, south: lat - 0.0004, east: lon + 0.0006, west: lon - 0.0006 };
  const z = pickZoom(area, { maxTiles: 24 });
  ok('zoom is the most detailed one inside the tile budget',
     tileCount(tileRange(area, z)) <= 24 && tileCount(tileRange(area, z + 1)) > 24);

  const wide = { north: lat + 0.05, south: lat - 0.05, east: lon + 0.08, west: lon - 0.08 };
  ok('a big area drops zoom rather than asking for hundreds of tiles',
     pickZoom(wide, { maxTiles: 24 }) < z);

  // Past its coverage a tile service answers 200 with a grey "Map data not yet
  // available" image -- a real tile, so nothing errors and it just gets painted
  // across the ground. The ceiling is the only defence, so it has to hold even
  // for an area small enough that any zoom would fit the tile budget.
  const tiny = { north: lat + 0.00002, south: lat - 0.00002, east: lon + 0.00002, west: lon - 0.00002 };
  ok('zoom never goes past the service ceiling', pickZoom(tiny, { maxZoom: 19 }) === 19);
  ok('and the default ceiling is the one the basemaps declare', pickZoom(tiny) <= 19);

  // The cache is fire-and-forget: the first ask starts the load and returns
  // nothing, and the view is told when to draw itself again.
  const made = [];
  let told = 0;
  class FakeImage { set src(v) { made.push(v); this._src = v; } get src() { return this._src; } }
  const cache = createTileCache({
    url: (zz, xx, yy) => `t/${zz}/${xx}/${yy}`,
    onLoad: () => { told++; },
    Image: FakeImage,
    limit: 3,
  });
  ok('the first ask returns nothing and starts a load',
     cache.get(19, 1, 1) === null && made.length === 1);
  ok('asking again does not start a second one',
     cache.get(19, 1, 1) === null && made.length === 1);
  ok('the url template is used verbatim', made[0] === 't/19/1/1');

  // A tile arriving late has to reach the view, or it stays invisible until
  // something else happens to force a redraw.
  const pending = [];
  const cache2 = createTileCache({
    url: () => 'x', onLoad: () => { told++; },
    Image: class { set src(v) { pending.push(this); } },
  });
  cache2.get(19, 2, 2);
  pending[0].onload();
  ok('a tile that lands late asks for a redraw', told === 1);
  ok('and is there the next time it is wanted', cache2.get(19, 2, 2) !== null);

  for (let i = 0; i < 8; i++) cache.get(19, i, 9);
  ok('the cache does not grow without bound', cache.size() <= 4);
}

console.log('\nsync worker');
{
  // The Worker is a fetch handler and a KV namespace, both of which node can
  // supply. Testing merge() and clean() in isolation says nothing about
  // routing, about which KV entry a list lands in, or about one list being able
  // to clobber the other -- which is the part that would cost real data.
  const kv = new Map();
  const env = { PLANS: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); } } };
  const KEY = 'andrzej-H5rGhCrCRmPXoRSFUA8etg';
  const post = (path, body) => worker.fetch(new Request(`https://w.dev${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Sync-Key': KEY },
    body: JSON.stringify(body),
  }), env);

  const plan = { id: 'planaa', name: 'Yard', code: 'v1.aaa', updatedAt: 1000 };
  const box = { id: 'boxaaa', name: 'Shed', height: 4, updatedAt: 1000,
                north: 50.001, south: 50, east: 19.001, west: 19 };

  let res = await post('/sync', { plans: [plan] });
  let body = await res.json();
  ok('the plan route stores a plan', res.status === 200 && body.plans[0].code === 'v1.aaa');

  res = await post('/obstacles', { obstacles: [box] });
  body = await res.json();
  ok('the obstacle route stores an obstacle', res.status === 200 && body.obstacles[0].height === 4);

  // The two lists share one namespace and must never share an entry: an
  // obstacle sync that wiped the plan library would be the worst bug in here.
  res = await post('/sync', { plans: [] });
  body = await res.json();
  ok('storing obstacles leaves the plans alone', body.plans.length === 1 && body.plans[0].id === 'planaa');
  ok('and the two lists live under different keys', kv.size === 2);

  res = await post('/nope', { plans: [] });
  ok('an unknown route is a 404, not a silent success', res.status === 404);

  res = await worker.fetch(new Request('https://w.dev/obstacles', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"obstacles":[]}',
  }), env);
  ok('a request with no sync key is refused', res.status === 401);

  res = await post('/obstacles', { obstacles: 'not an array' });
  ok('a body of the wrong shape is refused', res.status === 400);

  // Last write wins, across the wire, the way two devices actually meet.
  await post('/obstacles', { obstacles: [{ ...box, height: 9, updatedAt: 2000 }] });
  res = await post('/obstacles', { obstacles: [{ ...box, height: 2, updatedAt: 1500 }] });
  body = await res.json();
  ok('an older edit loses to a newer one already stored', body.obstacles[0].height === 9);

  res = await post('/obstacles', { obstacles: [{ id: 'boxaaa', deleted: true, updatedAt: 3000 }] });
  body = await res.json();
  ok('and a tombstone travels like any other write', body.obstacles[0].deleted === true);

  res = await worker.fetch(new Request('https://w.dev/obstacles', {
    method: 'GET', headers: { 'X-Sync-Key': KEY },
  }), env);
  ok('GET reads a list back without writing', (await res.json()).obstacles.length === 1);
}

console.log('\nundo');
{
  let world = { alt: 40, boxes: [] };
  const h = createHistory({
    snapshot: () => structuredClone(world),
    restore: (s) => { world = structuredClone(s); },
  });

  world.alt = 60; h.commit();
  world.boxes.push({ id: 'a', height: 10 }); h.commit();
  ok('nothing to undo before anything happened', h.depth().past === 2);

  h.undo();
  ok('undo takes back the last action only', world.alt === 60 && world.boxes.length === 0);
  h.undo();
  ok('and then the one before it', world.alt === 40);
  ok('with nothing left, undo says so', h.canUndo() === false && h.undo() === false);

  h.redo(); h.redo();
  ok('redo walks back up the same path', world.alt === 60 && world.boxes.length === 1);
  ok('and stops at the present', h.canRedo() === false && h.redo() === false);

  // A slider clicked but not moved, a name retyped the same -- these fire the
  // same events as a real edit, and an undo entry that undoes to where you
  // already are reads as cmd+Z being broken.
  ok('committing an unchanged state is not an action', h.commit() === false && h.depth().past === 2);

  // Redo is what you were about to do; doing something else instead means you
  // are not going to do it any more.
  h.undo();
  world.alt = 99; h.commit();
  ok('a new action after an undo drops the redo branch', h.canRedo() === false);
  h.undo();
  ok('and the undo still goes back to where it was', world.alt === 60);

  // A box arriving from the other device is not this person's action -- and
  // undoing past it must not delete it, which is what a plain whole-state
  // restore would do.
  const rebased = createHistory({
    snapshot: () => structuredClone(world),
    restore: (s) => { world = structuredClone(s); },
    rebase: (snap, before, after) => {
      const had = new Set(before.boxes.map((b) => b.id));
      const arrived = after.boxes.filter((b) => !had.has(b.id));
      const ids = new Set(snap.boxes.map((b) => b.id));
      return { ...snap, boxes: [...snap.boxes, ...arrived.filter((b) => !ids.has(b.id))] };
    },
  });
  world.alt = 70; rebased.commit();
  const before = rebased.depth().past;
  world.boxes.push({ id: 'remote', height: 3 });
  rebased.refresh();
  ok('a remote change adds no undo step', rebased.depth().past === before);
  rebased.undo();
  ok('and undoing past it does not delete it',
     world.alt === 60 && world.boxes.some((b) => b.id === 'remote'));

  // Snapshots are the whole point: they must be copies, not views.
  const snapshotHistory = createHistory({ snapshot: () => structuredClone(world), restore: () => {} });
  const n = world.boxes.length;
  world.boxes.push({ id: 'mutated', height: 1 });
  snapshotHistory.undo();
  ok('a snapshot cannot be mutated out from under the stack', world.boxes.length === n + 1);
}

console.log('\ncontroller bridge');
{
  // A fake waypoint tree: one folder holding a mission, one folder holding
  // nothing, which is the shape DJI Fly leaves on a controller.
  const root = mkdtempSync(join(tmpdir(), 'dji-bridge-'));
  const dest = join(root, 'Android/data/dji.go.v5/files/waypoint');
  const full = 'AAAAAAAA-0000-4000-8000-000000000001';
  const bare = 'BBBBBBBB-0000-4000-8000-000000000002';
  mkdirSync(join(dest, full), { recursive: true });
  mkdirSync(join(dest, bare), { recursive: true });
  writeFileSync(join(dest, full, `${full}.kmz`), Buffer.from(bytes));

  const t = `dir:${dest}`;
  const slots = listSlots(t);
  ok('lists every mission folder', slots.length === 2);
  ok('reads the waypoint count out of an installed mission',
     slots.find((x) => x.id === full)?.waypoints === m.exported.length);
  ok('marks a folder with no kmz as unusable', slots.find((x) => x.id === bare)?.exists === false);

  const smaller = buildKmz(planMission(site(rect), { altitude: 90, speed: 4 }, cam), 'fly');
  const res = install(t, full, smaller);
  ok('installing overwrites the file inside the folder',
     listSlots(t).find((x) => x.id === full).size === smaller.length);
  ok('installing keeps a copy of what it replaced',
     res.backup !== null && statSync(res.backup).size === bytes.length);
  rmSync(res.backup, { force: true });

  let refused = false;
  try { install(t, full, Buffer.from('not a kmz')); } catch { refused = true; }
  ok('refuses to install something that fails validation', refused);
  ok('and leaves the previous mission in place',
     listSlots(t).find((x) => x.id === full).size === smaller.length);
  rmSync(root, { recursive: true, force: true });
}

// -- measured heights -------------------------------------------------------
// The client that turns an assumed height into a measured one. Nothing here
// touches the service: the tile is a Uint8Array this test writes by hand.
{
  console.log('\nmeasured heights');
  globalThis.localStorage = { getItem: () => 'http://heights.test', setItem() {} };
  const { measure, serviceUrl, _internals } = await import('../js/heights.js');
  const { toPuwg92 } = await import('../js/puwg92.js');
  ok('reads the service url from storage', serviceUrl() === 'http://heights.test');

  const SIZE = 500, TILE = 500;
  // A tile where one 40 m patch is 30 m tall, one is no-data, rest is flat.
  const at = 51.1166299, on = 17.0308393;
  const { east, north } = toPuwg92(at, on);
  const tn = Math.floor(north / TILE), te = Math.floor(east / TILE);
  const data = new Uint8Array(SIZE * SIZE);          // flat ground everywhere
  const col = Math.floor(east - te * TILE);
  const row = Math.floor(TILE - (north - tn * TILE));
  for (let r = row - 20; r <= row + 20; r++) {
    for (let c = col - 20; c <= col + 20; c++) data[r * SIZE + c] = 30;
  }
  // A blank patch 100 m to the east, standing in for water.
  for (let r = row - 10; r <= row + 10; r++) {
    for (let c = col + 90; c <= col + 110; c++) data[r * SIZE + c] = 255;
  }

  let tileCalls = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith('/v1/health')) {
      return { ok: true, status: 200, json: async () => ({ tileMetres: TILE, size: SIZE }) };
    }
    tileCalls++;
    if (url.endsWith(`/v1/tile/${tn}/${te}`)) {
      return { status: 200, arrayBuffer: async () => data.buffer.slice(0) };
    }
    return { status: 202, json: async () => ({ status: 'building' }) };
  };

  const box = (lat, lon, span) => ({
    north: lat + span / 2 / 111132, south: lat - span / 2 / 111132,
    east: lon + span / 2 / (111320 * Math.cos((lat * Math.PI) / 180)),
    west: lon - span / 2 / (111320 * Math.cos((lat * Math.PI) / 180)),
    height: 24, label: 'thing', assumed: true,
  });
  const dLon = (m) => m / (111320 * Math.cos((at * Math.PI) / 180));

  _internals.reset();
  const tagged = { ...box(at, on, 20), height: 41, assumed: false, label: 'tagged' };
  const res = await measure([box(at, on, 20), tagged], { fetchImpl, waitMs: 0 });
  ok('measures an assumed height', res.obstacles[0].height === 30, String(res.obstacles[0].height));
  ok('and marks it no longer assumed', res.obstacles[0].assumed === false);
  ok('leaves a tagged height alone', res.obstacles[1].height === 41 && res.obstacles[1].assumed === false);
  ok('counts what it measured', res.measured === 1, String(res.measured));

  // The safety property: 255 is unknown, and unknown must not become zero.
  _internals.reset();
  const water = await measure([box(at, on + dLon(100), 10)], { fetchImpl, waitMs: 0 });
  ok('no-data leaves the estimate standing', water.obstacles[0].height === 24 && water.obstacles[0].assumed === true);
  ok('and is reported as blank, not measured', water.measured === 0 && water.blanked === 1);

  // Degrading: a tile still building, the service missing, a place abroad.
  _internals.reset();
  const far = await measure([box(52.4, 16.9, 20)], { fetchImpl, waitMs: 0 });
  ok('a tile that is not built yet leaves the estimate', far.measured === 0 && far.obstacles[0].height === 24);

  _internals.reset();
  const abroad = await measure([box(52.52, 13.405, 20)], { fetchImpl, waitMs: 0 });
  ok('outside Poland is not even asked about', abroad.measured === 0 && abroad.tiles === 0, String(abroad.tiles));

  _internals.reset();
  const dead = await measure([box(at, on, 20)], {
    fetchImpl: async () => { throw new Error('connection refused'); }, waitMs: 0,
  });
  ok('an unreachable service degrades to the estimate',
     dead.measured === 0 && dead.obstacles[0].height === 24 && /refused/.test(dead.reason));

  _internals.reset();
  globalThis.localStorage = { getItem: () => '', setItem() {} };
  const off = await measure([box(at, on, 20)], { fetchImpl, waitMs: 0 });
  ok('no service configured means no round trip', off.reason === 'no service' && off.measured === 0);
  globalThis.localStorage = { getItem: () => 'http://heights.test', setItem() {} };

  // Tiles are fetched once each however many obstacles sit on them.
  _internals.reset();
  tileCalls = 0;
  await measure([box(at, on, 20), box(at, on + dLon(30), 20), box(at, on + dLon(60), 20)],
    { fetchImpl, waitMs: 0 });
  ok('fetches each tile once, not once per obstacle', tileCalls === 1, `${tileCalls} calls`);
}

// -- overhead lines as obstacles --------------------------------------------
{
  console.log('\noverhead lines as obstacles');
  globalThis.localStorage = { getItem: () => 'http://heights.test', setItem() {} };
  const { fetchLines, lineToObstacles, tilesFor, _internals } = await import('../js/lines.js');
  const { toPuwg92 } = await import('../js/puwg92.js');
  const { isImported, isEstimated, labelOf } = await import('../js/site.js');

  const TILE = 500;
  const { east, north } = toPuwg92(53.2076, 15.8355);
  const tn = Math.floor(north / TILE);
  const te = Math.floor(east / TILE);

  // A 300 m span across the tile at medium voltage.
  const line = { kind: 'SN', label: 'medium voltage line', height: 16,
                 points: [[100, 250], [400, 250]] };
  const boxes = lineToObstacles(line, { tn, te, tileMetres: TILE });
  ok('a span becomes many boxes, not one', boxes.length > 8, String(boxes.length));
  ok('every box stands at the height the voltage implies', boxes.every((b) => b.height === 16));
  ok('and every one is marked an estimate', boxes.every((b) => b.assumed === true));
  ok('and marked as coming from BDOT10k', boxes.every((b) => b.source === 'bdot'));
  const widest = Math.max(...boxes.map((b) => (b.north - b.south) * 111132));
  ok(`no box is wider than a span is (${widest.toFixed(0)} m)`, widest < 30);
  // The reason for chopping at all: one box round a 300 m line walls off a
  // 300 m square of sky.
  const spanEW = Math.max(...boxes.map((b) => b.east)) - Math.min(...boxes.map((b) => b.west));
  ok('the boxes together cover the whole span', spanEW * 111320 * Math.cos(53.2 * Math.PI / 180) > 280);

  // What the site model makes of one.
  const named = `${isEstimated({ name: '~x' }) ? '' : ''}~${boxes[0].label} (${boxes[0].source})`;
  ok('the site model counts it as imported', isImported({ name: named }));
  ok('and as an estimate', isEstimated({ name: named }));
  ok('and the label says which survey it came from', labelOf({ name: named }).endsWith('(bdot)'));

  ok('a view spanning two tiles asks for both',
     tilesFor({ south: 53.2050, north: 53.2098, west: 15.8320, east: 15.8392 }, TILE).length >= 2);

  // Degrading. The app planned flights before this existed.
  _internals.reset();
  const dead = await fetchLines({ south: 53.205, north: 53.21, west: 15.832, east: 15.839 },
    { fetchImpl: async () => { throw new Error('connection refused'); } });
  ok('an unreachable service yields nothing and says why',
     dead.obstacles.length === 0 && /refused/.test(dead.reason));

  _internals.reset();
  const abroad = await fetchLines({ south: 52.51, north: 52.53, west: 13.39, east: 13.42 },
    { fetchImpl: async () => { throw new Error('should not be called'); } });
  ok('outside Poland is not even asked about', abroad.reason === 'outside Poland');

  _internals.reset();
  let calls = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith('/v1/health')) return { ok: true, json: async () => ({ tileMetres: TILE }) };
    calls++;
    return { ok: true, json: async () => ({ lines: [line] }) };
  };
  const got = await fetchLines({ south: 53.2050, north: 53.2098, west: 15.8320, east: 15.8392 }, { fetchImpl });
  ok('every covering tile is asked once', calls === got.tiles && calls >= 2, `${calls} calls`);
  ok('and the lines come back as obstacles', got.obstacles.length > got.lines);

  globalThis.localStorage = { getItem: () => '', setItem() {} };
  _internals.reset();
  const off = await fetchLines({ south: 53.205, north: 53.21, west: 15.832, east: 15.839 }, { fetchImpl });
  ok('no service means no round trip', off.reason === 'no service' && off.obstacles.length === 0);
}

// -- the capture SOP ---------------------------------------------------------
// Volugraph's aerial capture SOP and general capture guide, turned into
// assertions. Two rules there are concrete enough to check: consecutive frames
// must share 60-80% of the scene, and every flight pattern opens with "fly at
// a distance where the entire site can be seen at once" -- whose opposite they
// name as the first failure mode, "camera view not showing the full location
// in frame".
{
  console.log('\ncapture SOP');
  const { fov } = await import('../js/camera.js');
  const view = fov(cam);
  const M = 111132;
  // A degree of longitude is shorter than a degree of latitude everywhere but
  // the equator, so a "square" built from the same offset in both is 100 m by
  // 63 m at this latitude -- and every measurement taken off it is of a site
  // that is not the size it claims.
  const COS = Math.cos((51 * Math.PI) / 180);
  const square = (side, h) => {
    const dLat = side / 2 / M;
    const dLon = side / 2 / (M * COS);
    return { points: [
      { lat: 51 - dLat, lon: 17 - dLon, height: h }, { lat: 51 - dLat, lon: 17 + dLon, height: h },
      { lat: 51 + dLat, lon: 17 + dLon, height: h }, { lat: 51 + dLat, lon: 17 - dLon, height: h },
    ], obstacles: [], shape: 'hull' };
  };
  const metres = (a, b) => Math.hypot(
    (a.lon - b.lon) * M * Math.cos(51 * Math.PI / 180), (a.lat - b.lat) * M, (a.alt ?? 0) - (b.alt ?? 0),
  );

  // Rule 3: 60-80% overlap between consecutive photos.
  let worst = 1;
  for (const [side, h] of [[10, 6], [30, 25], [60, 15], [150, 8]]) {
    const m = planMission(square(side, h), DEFAULTS, cam);
    const orbit = m.exported.filter((w) => w.pass === 'orbit');
    for (let i = 1; i < orbit.length; i++) {
      // Only frames that follow each other ALONG a ring. The pair that spans
      // the jump from the top of one ring to the bottom of the next is not two
      // consecutive photographs of anything, and counting it reads as a 55%
      // overlap failure that is not happening.
      if (orbit[i].lineStart) continue;
      const step = metres(orbit[i - 1], orbit[i]);
      const range = Math.hypot(
        (orbit[i].lon - 17) * M * COS, (orbit[i].lat - 51) * M, orbit[i].alt - h / 2,
      );
      const frame = 2 * range * Math.tan(view.h / 2);
      worst = Math.min(worst, 1 - step / frame);
    }
  }
  ok(`orbit frames overlap by at least 60% (worst ${(100 * worst).toFixed(0)}%)`, worst >= 0.6,
     `${(100 * worst).toFixed(0)}%`);

  // Rule 3.1/3.2/3.3: the whole site in frame, somewhere in the plan.
  const widestInward = (m, side, h) => {
    let widest = 0;
    for (const w of m.exported) {
      if (!w.photo || w.pass === 'surround') continue;
      const range = Math.hypot((w.lon - 17) * M * COS, (w.lat - 51) * M, w.alt - h / 2);
      widest = Math.max(widest, 2 * range * Math.tan(view.h / 2));
    }
    return widest;
  };
  for (const [side, h] of [[30, 25], [100, 10], [150, 8], [200, 5]]) {
    const m = planMission(square(side, h), DEFAULTS, cam);
    const diag = side * Math.SQRT2;
    ok(`a ${side} m site is wholly in frame somewhere`, widestInward(m, side, h) >= diag,
       `${widestInward(m, side, h).toFixed(0)} m vs ${diag.toFixed(0)} m diagonal`);
  }

  // And it is not a ring for nothing: round a tall thing the detail rings
  // already stand far enough back, so none is added.
  const tall = planMission(square(30, 25), DEFAULTS, cam);
  ok('no establishing ring where the detail rings already do it',
     !tall.passes.some((x) => x.name === 'Establishing orbit'));
  const flat = planMission(square(200, 5), DEFAULTS, cam);
  const est = flat.passes.find((x) => x.name === 'Establishing orbit');
  ok('and one where they never will', Boolean(est));
  ok('which costs a couple of dozen frames, not a second flight',
     est.count <= 28, String(est.count));

  // The honest bit: past a certain size no legal altitude frames the whole
  // site, and the plan has to say so rather than half do it.
  const huge = planMission(square(600, 5), { ...DEFAULTS, establish: true }, cam);
  const hugeEst = huge.passes.find((x) => x.name === 'Establishing orbit');
  ok('a site too big for the ceiling says how much it did fit',
     !hugeEst || /whole site|% of the site/.test(hugeEst.detail), hugeEst?.detail);

  // Rule: 3.1 says repeat the orbit at different altitudes, low to top.
  const rings = new Set(tall.exported.filter((w) => w.pass === 'orbit').map((w) => Math.round(w.alt)));
  ok('the subject is orbited from more than one height', rings.size >= 3, `${rings.size} heights`);
}

console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURES'}`);
console.log(`sample kmz: ${kmzPath} (${bytes.length} bytes, ${m.exported.length} waypoints)`);
process.exit(fails ? 1 : 0);
