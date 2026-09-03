// Tests for the heights service. Nothing here touches the network or GUGiK:
// the index is a recorded response and the point cloud is a synthetic tile,
// so this runs in a second, offline, on any machine.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toPuwg92, toWgs84, inPoland } from '../src/puwg92.js';
import { findTiles } from '../src/gugik.js';
import { createTile, tileOf, originOf, TILE_M, SIZE, NO_DATA, MAX_H } from '../src/ndsm.js';
import { createStore, LISTS } from '../src/store.js';

let fails = 0;
const ok = (name, cond, extra = '') => {
  if (cond) console.log(`  ok   ${name}`);
  else { console.log(`  FAIL ${name} ${extra}`); fails++; }
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

console.log('\nprojection');
{
  // Cybulskiego 22, Wroclaw -- the address the whole exercise started from.
  const { east, north } = toPuwg92(51.1166299, 17.0308393);
  ok('PUWG92 easting', near(east, 362219, 2), east.toFixed(1));
  ok('PUWG92 northing', near(north, 362939, 2), north.toFixed(1));
  // The trap this project keeps falling into: at Wroclaw the two are 720 m
  // apart, so a swap stays plausible. Assert they are not interchangeable.
  ok('easting and northing are distinguishable here', Math.abs(east - north) > 500);
  const back = toWgs84(east, north);
  ok('round trips to within a centimetre',
     near(back.lat, 51.1166299, 1e-6) && near(back.lon, 17.0308393, 1e-6));
  // A place where a swap would be obvious, as a control.
  const gd = toPuwg92(54.3520, 18.6466);
  ok('Gdansk is north of Wroclaw', gd.north > north + 200000);
  ok('inPoland accepts Wroclaw', inPoland(51.11, 17.03));
  ok('inPoland rejects Berlin', !inPoland(52.52, 13.40));
}

console.log('\ntile addressing');
{
  const { te, tn } = tileOf(362219, 362939);
  ok('tile index floors to the grid', te === 724 && tn === 725, `${te},${tn}`);
  const { e0, n0 } = originOf(te, tn);
  ok('origin is the south-west corner', e0 === 362000 && n0 === 362500, `${e0},${n0}`);
  ok('the point falls inside its own tile',
     362219 >= e0 && 362219 < e0 + TILE_M && 362939 >= n0 && 362939 < n0 + TILE_M);
  // Negative coordinates never occur in Poland, but flooring must not round
  // toward zero if they ever did -- that would put two tiles at index 0.
  ok('floors rather than truncates', tileOf(-1, -1).te === -1);
}

console.log('\nheight grid');
{
  // A synthetic tile: flat ground at 100 m, one 30 m block, one cell of noise
  // that must be ignored, and a quadrant with no returns at all.
  const { e0, n0 } = originOf(724, 725);
  const pts = [];
  for (let dy = 0; dy < 400; dy += 1) {
    for (let dx = 0; dx < 400; dx += 1) pts.push([e0 + dx, n0 + dy, 100, 2]);
  }
  for (let dy = 100; dy < 140; dy += 1) {
    for (let dx = 100; dx < 140; dx += 1) pts.push([e0 + dx, n0 + dy, 130.4, 6]);
  }
  pts.push([e0 + 200, n0 + 200, 9000, 7]);          // noise, class 7
  pts.push([e0 + 480, n0 + 480, 100, 2]);           // lone point in the far corner

  const t = createTile(724, 725);
  for (const [e, n, z, c] of pts) t.addPoint(e, n, z, c);
  const built = t.finish();
  ok('produces a tile', Boolean(built));
  const { data, stats } = built;
  ok('one byte per square metre', data.length === SIZE * SIZE);

  const cell = (dx, dy) => data[Math.floor(TILE_M - dy) * SIZE + Math.floor(dx)];
  ok('flat ground reads as zero', cell(50, 50) === 0, String(cell(50, 50)));
  // 130.4 - 100 = 30.4, and heights round UP because this decides clearance.
  ok('a 30.4 m block reads as 31, not 30', cell(120, 120) === 31, String(cell(120, 120)));
  ok('noise is discarded', stats.maxHeight <= MAX_H && stats.maxHeight === 31, String(stats.maxHeight));
  ok('unsurveyed ground is no-data, not zero', cell(450, 300) === NO_DATA, String(cell(450, 300)));
  // 400x400 surveyed out of 500x500.
  ok('coverage reports the gap', near(stats.coverage, 0.64, 0.01), String(stats.coverage));
  ok('class counts exclude noise', !stats.classes[7]);
  ok('ground and building classes counted', stats.classes[2] > 0 && stats.classes[6] > 0);
}

console.log('\nheight grid, safety properties');
{
  const t = createTile(0, 0);
  // Sloping ground, so a naive global-minimum floor would inflate every
  // height at the high end of the slope.
  for (let dy = 0; dy < 500; dy += 2) {
    for (let dx = 0; dx < 500; dx += 2) t.addPoint(dx, dy, 100 + dx * 0.05, 2);
  }
  // A 10 m mast at the top of the slope.
  t.addPoint(400, 250, 100 + 400 * 0.05 + 10, 5);
  const { data } = t.finish();
  const at = (dx, dy) => data[Math.floor(500 - dy) * SIZE + Math.floor(dx)];
  ok('a slope does not become height', at(400, 100) <= 1, String(at(400, 100)));
  // The ground model takes the LOWEST ground return in each 10 m cell, which
  // on a slope is its downhill edge -- so ground reads slightly low and every
  // height above it reads slightly high. That bias is deliberate: at a 5%
  // slope it is a quarter of a metre, and it is a quarter of a metre of extra
  // clearance rather than a quarter of a metre less. Assert the size of it,
  // and assert the direction, which is the part that matters.
  const measured = at(400, 250);
  ok('an object on a slope measures against local ground',
     measured >= 10 && measured <= 11, String(measured));
  ok('and the slope bias never under-reports', measured >= 10, String(measured));

  // Everything above the cap must clamp, never wrap around to a small number.
  const tall = createTile(0, 0);
  tall.addPoint(10, 10, 0, 2);
  tall.addPoint(10, 10, 5000, 6);
  ok('absurd heights clamp instead of wrapping',
     tall.finish().data[Math.floor(500 - 10) * SIZE + 10] === MAX_H);
}

console.log('\nGUGiK index');
{
  // A recorded pair of index entries. The first covers the query box; the
  // second is a PL-2000 survey, which the reader must skip because its
  // eastings start with the zone number and would land in the Baltic.
  const member = (n0, e0, n1, e1, crs, url) => `<wfs:member>
    <gml:lowerCorner>${n0} ${e0}</gml:lowerCorner>
    <gml:upperCorner>${n1} ${e1}</gml:upperCorner>
    <gugik:uklad_xy>${crs}</gugik:uklad_xy>
    <gugik:char_przestrz>12 p/m2</gugik:char_przestrz>
    <gugik:url_do_pobrania>${url}</gugik:url_do_pobrania>
  </wfs:member>`;

  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const year = url.match(/LIDAR(\d{4})/)[1];
    if (year !== '2024') return { ok: true, text: async () => '<wfs:FeatureCollection/>' };
    return {
      ok: true,
      text: async () => `<wfs:FeatureCollection>
        ${member(362500, 362000, 363000, 362500, 'PL-1992', 'https://x/a.laz')}
        ${member(362500, 362000, 363000, 362500, 'PL-2000 strefa 6', 'https://x/b.laz')}
        ${member(900000, 900000, 900500, 900500, 'PL-1992', 'https://x/far.laz')}
      </wfs:FeatureCollection>`,
    };
  };
  const box = { e0: 362000, n0: 362500, e1: 362500, n1: 363000 };
  const found = await findTiles(box, { fetchImpl });
  ok('finds the covering tile', found.length === 1, JSON.stringify(found.map((f) => f.url)));
  ok('skips PL-2000 surveys', !found.some((f) => f.url.endsWith('b.laz')));
  ok('skips tiles that do not overlap', !found.some((f) => f.url.endsWith('far.laz')));
  ok('reports the year and density', found[0]?.year === 2024 && found[0]?.density === '12 p/m2');
  ok('tries newest years first', calls[0].includes('LIDAR2026'));
  ok('stops once a year yields tiles', !calls.some((u) => u.includes('LIDAR2023')));

  // The axis-order trap, asserted so it cannot silently regress: BBOX must be
  // north,east, and must carry the URN that pins the order.
  const bbox = decodeURIComponent(calls[0].match(/BBOX=([^&]+)/)[1]);
  ok('BBOX is north,east with an explicit URN',
     bbox.startsWith(`${box.n0},${box.e0},${box.n1},${box.e1}`) && bbox.includes('urn:ogc:def:crs:EPSG::2180'),
     bbox);
}

console.log('\nsync store');
{
  const dir = mkdtempSync(join(tmpdir(), 'heights-'));
  const store = createStore({ dir });
  const key = 'andrzej-H5rGhCrCRmPXoRSFUA8etg';
  const plans = LISTS['/sync'];

  const a = await store.put(plans, key, [{ id: 'aaaaaa', updatedAt: 10, name: 'one', code: 'v2.x' }]);
  ok('stores a plan', a.length === 1 && a[0].name === 'one');
  const b = await store.put(plans, key, [{ id: 'aaaaaa', updatedAt: 20, name: 'two', code: 'v2.y' }]);
  ok('last write wins per id', b.length === 1 && b[0].name === 'two');
  const c = await store.put(plans, key, [{ id: 'aaaaaa', updatedAt: 15, name: 'stale', code: 'v2.z' }]);
  ok('an older write does not win', c[0].name === 'two');
  const d = await store.put(plans, key, [{ id: 'aaaaaa', deleted: true, updatedAt: 30 }]);
  ok('a tombstone travels like any other write', d[0].deleted === true);
  ok('rejects a record with no usable id',
     (await store.put(plans, key, [{ id: '!!', updatedAt: 40, name: 'x', code: 'y' }])).length === 1);
  ok('separate keys are separate lists',
     (await store.get(plans, 'someone-else-0123456789abcdef')).length === 0);

  // Two syncs landing together. On a filesystem this is the case that loses
  // data if the writes are not serialised -- both read the same file, both
  // merge against the same stale copy, and the later write wins outright.
  const store2 = createStore({ dir });
  const key2 = 'concurrent-0123456789abcdefgh';
  await Promise.all([
    store2.put(plans, key2, [{ id: 'p1aaaa', updatedAt: 1, name: 'first', code: 'a' }]),
    store2.put(plans, key2, [{ id: 'p2aaaa', updatedAt: 2, name: 'second', code: 'b' }]),
    store2.put(plans, key2, [{ id: 'p3aaaa', updatedAt: 3, name: 'third', code: 'c' }]),
  ]);
  const all = await store2.get(plans, key2);
  ok('concurrent syncs do not lose records', all.length === 3, `kept ${all.length} of 3`);

  const obstacles = LISTS['/obstacles'];
  const good = await store.put(obstacles, key, [{
    id: 'obsaaa', updatedAt: 5, name: '~building',
    north: 51.12, south: 51.11, east: 17.04, west: 17.03, height: 24,
  }]);
  ok('stores an obstacle', good.length === 1 && good[0].height === 24);
  const huge = await store.put(obstacles, key, [{
    id: 'obsbbb', updatedAt: 6, north: 52, south: 51, east: 18, west: 17, height: 24,
  }]);
  ok('rejects a box the size of a country', huge.length === 1);

  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${fails === 0 ? 'ALL PASS' : `${fails} FAILURES`}`);
process.exit(fails ? 1 : 0);
