#!/usr/bin/env node
import { CAMERAS } from '../js/camera.js';
import { planMission } from '../js/planner.js';
import { scoreCoverage } from '../js/coverage.js';

// Score capture configurations against each other geometrically. Answers
// "does this pass earn its waypoints" without rendering or training anything.
//
// usage: node tools/compare.mjs [siteWidth] [siteDepth] [subjectHeight] [altitude]

const cam = CAMERAS.mini5pro;
const [W = 25, D = 17, H = 3, ALT = 7] = process.argv.slice(2).map(Number);

const rect = (() => {
  const dLat = D / 111132;
  const dLon = W / (111412 * Math.cos((50 * Math.PI) / 180));
  return { south: 50, north: 50 + dLat, west: 19.93, east: 19.93 + dLon };
})();

const base = { subjectHeight: H, orbitPad: 0, nadir: false, oblique: false, orbit: true };

const CONFIGS = [
  ['nadir grid only (high)', { altitude: 40, nadir: true, orbit: false }],
  ['1 ring', { altitude: ALT, orbitRings: 1 }],
  ['2 rings', { altitude: ALT, orbitRings: 2 }],
  ['3 rings', { altitude: ALT, orbitRings: 3 }],
  ['4 rings', { altitude: ALT, orbitRings: 4 }],
  ['5 rings', { altitude: ALT, orbitRings: 5 }],
  ['cross passes only', { altitude: ALT, orbit: false, transect: true }],
  ['2 rings + cross', { altitude: ALT, orbitRings: 2, transect: true }],
  ['3 rings + cross', { altitude: ALT, orbitRings: 3, transect: true }],
  ['3 rings + cross + nadir', { altitude: ALT, orbitRings: 3, transect: true, nadir: true }],
  ['3 rings, 3-frame fan', { altitude: ALT, orbitRings: 3, shotsPerStop: 3 }],
  ['3 rings + cross, fan', { altitude: ALT, orbitRings: 3, transect: true, shotsPerStop: 3 }],
];

console.log(`\nsite ${W} x ${D} m · subject ${H} m tall · orbit altitude ${ALT} m`);
console.log(`camera ${cam.name}\n`);
console.log('configuration              wp  photos   good%  unseen%  walls%  down%   views  spread°  per-100wp');
console.log('─'.repeat(103));

const rows = [];
for (const [label, opts] of CONFIGS) {
  const m = planMission(rect, { ...base, ...opts }, cam);
  const r = scoreCoverage(m);
  const s = r.summary;
  const walls = s.byKind.wall?.good ?? 0;
  // Coverage bought per 100 waypoints: the number that says whether a pass
  // is worth what it costs.
  const efficiency = (s.good / Math.max(1, m.stats.waypoints)) * 100;
  rows.push({ label, wp: m.stats.waypoints, photos: m.stats.photos, ...s, walls, efficiency });
  console.log(
    label.padEnd(25),
    String(m.stats.waypoints).padStart(4),
    String(m.stats.photos).padStart(7),
    s.good.toFixed(0).padStart(7),
    s.unseen.toFixed(0).padStart(8),
    walls.toFixed(0).padStart(7),
    s.withDownAngle.toFixed(0).padStart(6),
    s.meanViews.toFixed(0).padStart(7),
    s.meanSpread.toFixed(0).padStart(8),
    efficiency.toFixed(2).padStart(10),
  );
}

console.log('\nmarginal value — what each addition actually buys:');
const find = (l) => rows.find((r) => r.label === l);
const delta = (a, b) => {
  const A = find(a);
  const B = find(b);
  if (!A || !B) return;
  const dw = B.wp - A.wp;
  console.log(
    `  ${a} → ${b}`.padEnd(48),
    `${dw >= 0 ? '+' : ''}${dw} wp`.padStart(9),
    `good ${(B.good - A.good) >= 0 ? '+' : ''}${(B.good - A.good).toFixed(1)}`.padStart(13),
    `down ${(B.withDownAngle - A.withDownAngle) >= 0 ? '+' : ''}${(B.withDownAngle - A.withDownAngle).toFixed(1)}`.padStart(13),
  );
};
delta('1 ring', '2 rings');
delta('2 rings', '3 rings');
delta('3 rings', '4 rings');
delta('4 rings', '5 rings');
delta('3 rings', '3 rings + cross');
delta('3 rings + cross', '3 rings + cross + nadir');
delta('3 rings', '3 rings, 3-frame fan');
console.log('');
