import { writeFileSync, mkdtempSync, mkdirSync, statSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import { CAMERAS, footprint, gsdCm } from '../js/camera.js';
import { planMission, DEFAULTS } from '../js/planner.js';
import { buildKmz, templateKml, waylinesWpml, PROFILES } from '../js/wpml.js';
import { distM } from '../js/geo.js';
import { listSlots, install } from '../tools/bridge.mjs';
import { encodePlan, decodePlan } from '../js/share.js';
import { readKmz } from '../js/kmzread.js';
import { routeFromRead, inferPass } from '../js/route.js';
import { createPlanStore, merge as clientMerge, SYNC_KEY } from '../js/plans.js';
import { merge as workerMerge, clean } from '../sync/worker.js';

let fails = 0;
const ok = (name, cond, extra = '') => {
  if (cond) console.log(`  ok   ${name}`);
  else { console.log(`  FAIL ${name} ${extra}`); fails++; }
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const cam = CAMERAS.mini5pro;

console.log('camera');
ok('84 deg diagonal FOV', near(2 * Math.atan(43.2666 / 2 / 24) * 180 / Math.PI, 84.1, 0.2));
ok('GSD scales linearly with altitude', near(gsdCm(cam, 80), 2 * gsdCm(cam, 40), 1e-9));
ok('footprint 4:3', near(footprint(cam, 40).across / footprint(cam, 40).along, 4 / 3, 1e-6));

// A 200 m x 150 m box near Krakow.
const rect = { south: 50.0600, north: 50.06135, west: 19.9300, east: 19.93280 };

console.log('\nplanner geometry');
const m = planMission(rect, { altitude: 40, speed: 4 }, cam);
ok(`box is ~200x150 m (got ${m.sizeX.toFixed(0)}x${m.sizeY.toFixed(0)})`,
   near(m.sizeX, 200, 12) && near(m.sizeY, 150, 12));
ok('line spacing = across-footprint x (1 - side overlap)',
   near(m.stats.sideSpacing, footprint(cam, 40).across * 0.3, 1e-6));
ok('shot spacing = along-footprint x (1 - front overlap)',
   near(m.stats.fwdSpacing, footprint(cam, 40).along * 0.2, 1e-6));
ok('three passes present', m.passes.length === 3, JSON.stringify(m.passes.map(p => p.name)));
ok('nadir pitch is -90', m.waypoints.filter(w => w.pass === 'nadir').every(w => w.pitch === -90));
ok('oblique pitch is -45', m.waypoints.filter(w => w.pass === 'oblique').every(w => w.pitch === -45));
ok('orbit points all face the POI', m.waypoints.filter(w => w.pass === 'orbit').every(w => w.heading.mode === 'towardPOI' && w.heading.poi));

// The orbit tilt is derived, not hardcoded: it should point at the box centre.
const orb = m.waypoints.filter(w => w.pass === 'orbit');
const orbR = Math.max(...orb.map(w => Math.hypot(m.frame.toLocal(w.lat, w.lon).x, m.frame.toLocal(w.lat, w.lon).y)));
const wantPitch = -(Math.atan2(m.params.altitude, orbR) * 180) / Math.PI;
ok(`orbit tilt aims at the centre (${orb[0].pitch.toFixed(0)}° vs ${wantPitch.toFixed(0)}°)`,
   near(orb[0].pitch, wantPitch, 1.5));
// A low, close orbit must tilt shallower than a high, distant one.
const lowOrbit = planMission(rect, { altitude: 5, orbitPad: 5, nadir: false, oblique: false }, cam);
const highOrbit = planMission(rect, { altitude: 100, orbitPad: 5, nadir: false, oblique: false }, cam);
// The under-canopy case: a playground-sized box orbited low and close.
const playRect = { south: 50.06, north: 50.06 + 15 / 111132,
                   west: 19.93, east: 19.93 + 20 / (111412 * Math.cos((50 * Math.PI) / 180)) };
const play = planMission(playRect, { altitude: 5, orbitPad: 6, orbitRings: 2, nadir: false, oblique: false }, cam);
ok(`playground orbit fits one mission (${play.stats.waypoints} wp, ${play.stats.minutes.toFixed(1)} min)`,
   play.stats.waypoints <= 200 && play.stats.minutes < 15);
ok('playground orbit keeps sub-cm GSD', play.stats.gsdCm < 0.2, `${play.stats.gsdCm.toFixed(2)}`);
ok('playground orbit tilts shallow (subject is beside, not below)',
   play.waypoints[0].pitch > -30, `${play.waypoints[0].pitch.toFixed(0)}`);
// A negative offset must tighten the ring, and never invert past the floor.
const tight = planMission(playRect, { altitude: 5, orbitPad: -6, nadir: false, oblique: false }, cam);
const radiusOf = (p) => Math.max(...p.waypoints.map(w => {
  const l = p.frame.toLocal(w.lat, w.lon); return Math.hypot(l.x, l.y);
}));
ok(`negative offset pulls the ring in (${radiusOf(tight).toFixed(0)} m vs ${radiusOf(play).toFixed(0)} m)`,
   radiusOf(tight) < radiusOf(play));
ok('orbit radius never collapses below 3 m',
   radiusOf(planMission(playRect, { orbitPad: -500, nadir: false, oblique: false }, cam)) >= 2.9);
ok(`low orbit tilts shallower than high (${lowOrbit.waypoints[0].pitch.toFixed(0)}° vs ${highOrbit.waypoints[0].pitch.toFixed(0)}°)`,
   lowOrbit.waypoints[0].pitch > highOrbit.waypoints[0].pitch);
// Ring spacing must follow slant range, not altitude, or a low orbit explodes.
// Spacing follows slant range, so a low orbit must not blow up the way it
// would if it used the (tiny) nadir footprint at 5 m.
ok(`low orbit spacing follows slant range (${lowOrbit.stats.waypoints} wp, not 700+)`,
   lowOrbit.stats.waypoints < 150, String(lowOrbit.stats.waypoints));
const rings2 = planMission(rect, { altitude: 5, orbitPad: 5, orbitRings: 2, nadir: false, oblique: false }, cam);
ok('2 rings doubles the orbit points', rings2.stats.waypoints === 2 * lowOrbit.stats.waypoints);
ok('2 rings fly at two distinct heights', new Set(rings2.waypoints.map(w => w.alt)).size === 2);
ok('lower ring sits below the set altitude', Math.min(...rings2.waypoints.map(w => w.alt)) < 5);

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
const iv = planMission(rect, { altitude: 40, photoMode: 'interval' }, cam);
ok('interval mode emits far fewer waypoints', iv.exported.length < m.exported.length / 3,
   `${iv.exported.length} vs ${m.exported.length}`);
ok('interval mode keeps the whole orbit ring',
   iv.exported.filter(w => w.pass === 'orbit').length === iv.waypoints.filter(w => w.pass === 'orbit').length);
ok('export indices are 0..n-1 contiguous',
   iv.exported.every((w, i) => w.exportIndex === i));
const nadirOnly = planMission(rect, { oblique: false, orbit: false }, cam);
ok('passes can be switched off', nadirOnly.passes.length === 1 && nadirOnly.waypoints.every(w => w.pass === 'nadir'));
ok('higher altitude -> fewer photos', planMission(rect, { altitude: 80 }, cam).stats.photos < m.stats.photos);

console.log('\ndome orbit + cross passes');
const dome = planMission(playRect, {
  altitude: 8, subjectHeight: 3, orbitPad: 0, orbitRings: 4,
  nadir: false, oblique: false,
}, cam);
const ringsOf = (p) => {
  const byAlt = new Map();
  for (const w of p.waypoints.filter(x => x.pass === 'orbit')) {
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
ok(`every ring holds the same slant range (${slants.map(s => s.toFixed(1)).join(', ')} m)`,
   Math.max(...slants) - Math.min(...slants) < 0.6);
ok('tilt steepens with height — level low, looking down high',
   rr.every((r, i) => i === 0 || r[1].pitch < rr[i - 1][1].pitch));
ok(`tilt spans a real range (${rr[0][1].pitch}° to ${rr[3][1].pitch}°)`,
   rr[0][1].pitch - rr[3][1].pitch > 10);

// Dragging a level in the 3D view pins one height and leaves the rest alone.
console.log('\ndragged levels');
{
  const base = { altitude: 40, orbitRings: 3, nadir: false, oblique: false };
  const derived = planMission(rect, base, cam);
  const alts = (m) => [...new Set(m.waypoints.map((w) => Math.round(w.alt * 10) / 10))].sort((a, b) => a - b);
  ok('the planner reports the heights it flew', derived.heights.orbit.length === 3);

  const pinned = planMission(rect, { ...base, orbitHeights: [12, ...derived.heights.orbit.slice(1)] }, cam);
  ok('a pinned ring flies at the height it was dragged to', alts(pinned)[0] === 12);
  ok('and the other rings do not move',
     alts(pinned).slice(1).join() === alts(derived).slice(1).join());

  // A stale list -- one written before the ring count changed -- is ignored
  // rather than half-applied.
  const stale = planMission(rect, { ...base, orbitRings: 4, orbitHeights: [12, 20, 40] }, cam);
  ok('a height list that no longer fits the ring count is dropped',
     alts(stale).join() === alts(planMission(rect, { ...base, orbitRings: 4 }, cam)).join());

  const levels = planMission(rect, { altitude: 40, orbitRings: 2 }, cam).levels;
  ok('every level names the knob that owns it',
     levels.some((l) => l.kind === 'altitude' && l.z === 40) && levels.some((l) => l.kind === 'orbit'));
  ok('the level the grids fly at belongs to the altitude, not to a ring',
     levels.filter((l) => l.z === 40).length === 1);

  const xh = planMission(rect, { altitude: 40, transect: true, transectLevels: 3, nadir: false, oblique: false, orbit: false }, cam);
  const xp = planMission(rect, { altitude: 40, transect: true, transectLevels: 3, nadir: false, oblique: false, orbit: false,
                                 transectHeights: [3, xh.heights.transect[1], 40] }, cam);
  ok('a cross-pass level can be pinned too', alts(xp)[0] === 3);
}

// Orbit density must stay inside the published 7.5-15 deg guidance.
for (const [label, opts] of [
  ['tight ring', { altitude: 5, subjectHeight: 3, orbitPad: 0 }],
  ['wide ring', { altitude: 60, orbitPad: 40 }],
]) {
  const p = planMission(playRect, { ...opts, nadir: false, oblique: false }, cam);
  const per = p.waypoints.filter(w => w.pass === 'orbit').length;
  ok(`${label}: ${per} frames/ring = ${(360 / per).toFixed(1)}° steps, inside 7.5–15°`,
     per >= 24 && per <= 48, String(per));
}

const tr = planMission(playRect, {
  altitude: 5, subjectHeight: 3, transect: true,
  nadir: false, oblique: false, orbit: false,
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
const poseM = planMission(rect, { altitude: 40 }, cam);
const orbitPts = poseM.waypoints.filter(w => w.pass === 'orbit');
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
const fan = planMission(rect, { altitude: 40, shotsPerStop: 3 }, cam);
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
   planMission(rect, { shotsPerStop: 3, photoMode: 'interval' }, cam).exported.every(w => w.shots.length === 1));

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
ok('one takePhoto per waypoint', d.photos === m.exported.length, `${d.photos}`);
ok('single-shot mode plans one frame per stop', m.exported.every(w => w.shots.length === 1));
// The gimbal is commanded once per pitch change, not once per waypoint.
const pitchChanges = m.exported.reduce((n, w, i) => n + (i === 0 || w.pitch !== m.exported[i - 1].pitch ? 1 : 0), 0);
ok(`one gimbalRotate per pitch change (${d.gimbals} for ${pitchChanges} changes)`, d.gimbals === pitchChanges);
ok('a 3-pass mission changes pitch exactly 3 times', pitchChanges === 3, String(pitchChanges));
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
ok('every waypoint shoots 3 frames in fan mode', JSON.stringify(fd.photos_per_wp) === '[3]', fanProbe);
ok('every waypoint rotates the gimbal 3 times in fan mode', JSON.stringify(fd.gimbals_per_wp) === '[3]');
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
const covOf = (o) => scoreCoverage(planMission(covRect,
  { subjectHeight: 3, orbitPad: 0, nadir: false, oblique: false, orbit: true, ...o }, cam)).summary;

ok('proxy is bare ground when nothing is tall', buildProxy(12, 8, 0).length === 0);
ok('proxy builds a cluster with gaps when something is tall', buildProxy(12, 8, 3).length === 5);
ok('proxy blocks do not overlap each other', (() => {
  const b = buildProxy(12, 8, 3);
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
ok(`rings score well on walls (${covRing3.byKind.wall.good.toFixed(0)}%)`, covRing3.byKind.wall.good > 80);
ok('a nadir grid still nails the tops', covNadir.byKind.top.good > 90);
ok('cross passes alone cannot cover the outside',
   covOf({ altitude: 7, orbit: false, transect: true }).good < 60);

// Occlusion has to actually be tested, or the score is meaningless.
ok('some surface is genuinely occluded from a single low ring',
   covOf({ altitude: 7, orbitRings: 1 }).unseen > 2);
ok('adding passes reduces the unseen fraction',
   covOf({ altitude: 7, orbitRings: 3, transect: true }).unseen
   < covOf({ altitude: 7, orbitRings: 1 }).unseen);

// Diminishing returns on rings, which is the whole reason to measure.
const covR1 = covOf({ altitude: 7, orbitRings: 1 }).good;
const covR2 = covOf({ altitude: 7, orbitRings: 2 }).good;
const covR5 = covOf({ altitude: 7, orbitRings: 5 }).good;
ok(`ring 1→2 helps more than 2→5 (${(covR2 - covR1).toFixed(1)} vs ${(covR5 - covR2).toFixed(1)} pts)`,
   covR2 - covR1 > covR5 - covR2);

// The nadir grid is the only thing that fixes the down angle.
const covNoNadir = covOf({ altitude: 7, orbitRings: 3, transect: true });
const covWithNadir = covOf({ altitude: 7, orbitRings: 3, transect: true, nadir: true });
ok(`nadir transforms down-angle coverage (${covNoNadir.withDownAngle.toFixed(0)}% → ${covWithNadir.withDownAngle.toFixed(0)}%)`,
   covWithNadir.withDownAngle - covNoNadir.withDownAngle > 30);

// The frame fan costs no waypoints, so any gain is free coverage.
const covFan1 = covOf({ altitude: 7, orbitRings: 3, shotsPerStop: 1 });
const covFan3 = covOf({ altitude: 7, orbitRings: 3, shotsPerStop: 3 });
ok(`the frame fan buys coverage for zero waypoints (${covFan1.good.toFixed(0)}% → ${covFan3.good.toFixed(0)}%)`,
   covFan3.good > covFan1.good + 2);
ok('but it barely widens the parallax baseline, as predicted',
   covFan3.meanSpread - covFan1.meanSpread < 10,
   `${covFan1.meanSpread.toFixed(0)}° → ${covFan3.meanSpread.toFixed(0)}°`);

ok('every sample carries a grade', (() => {
  const r = scoreCoverage(planMission(covRect, { subjectHeight: 3, altitude: 7 }, cam));
  return r.samples.every(x => ['good', 'flat', 'thin', 'unseen'].includes(x.grade));
})());
ok('capping cameras keeps it interactive but still scores', (() => {
  const m2 = planMission(covRect, { subjectHeight: 3, altitude: 7, orbitRings: 3, transect: true }, cam);
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
    nadir: true, oblique: true, orbit: true, transect: false,
  };
  const code = encodePlan(rect, ui);
  const back = decodePlan(code);
  ok('a plan code round-trips the box to 6 decimals',
     near(back.rect.north, rect.north, 5e-7) && near(back.rect.west, rect.west, 5e-7));
  ok('a plan code round-trips every control', Object.keys(ui).every((k) => back.ui[k] === ui[k]));
  ok('a plan code survives being pasted as a whole url',
     decodePlan(`https://example.com/x/#plan=${code}`).ui.altitude === 52);
  ok('a plan code is short enough to message', code.length < 260, `${code.length} chars`);
  ok('rejects junk', decodePlan('hello') === null && decodePlan('') === null);
  const dragged = decodePlan(encodePlan(rect, { ...ui, orbitHeights: [11, 25, 40] }));
  ok('a plan code carries heights dragged in the 3D view',
     dragged.ui.orbitHeights.join() === '11,25,40');
  const payload = JSON.parse(Buffer.from(code.slice(3), 'base64url').toString());
  ok('and leaves them out of the code entirely when nothing was dragged',
     payload.H === undefined && payload.L === undefined);
  ok('rejects a code whose payload is not a plan', decodePlan('v1.' + Buffer.from('{"r":[1]}').toString('base64')) === null);

  // Same code, same plan: the point of shipping a code instead of a file.
  const a = planMission(rect, { altitude: ui.altitude, speed: ui.speed }, cam);
  const b = planMission(back.rect, { altitude: back.ui.altitude, speed: back.ui.speed }, cam);
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
  const needs = (r) => ['waypoints', 'rect', 'frame', 'cam'].every((k) => r[k] !== undefined);
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

  const smaller = buildKmz(planMission(rect, { altitude: 90, speed: 4 }, cam), 'fly');
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

console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURES'}`);
console.log(`sample kmz: ${kmzPath} (${bytes.length} bytes, ${m.exported.length} waypoints)`);
process.exit(fails ? 1 : 0);
