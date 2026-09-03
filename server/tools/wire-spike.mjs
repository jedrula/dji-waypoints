// Trying to find overhead lines in Polish LiDAR, and failing.
//
// THIS DOES NOT WORK. It is kept because the negative is worth more than
// another attempt at the same idea, and because the way it fails is specific
// and instructive.
//
// The premise is sound. ASPRS reserves classes 13-16 for wires and no Polish
// tile sampled uses any of them, but the returns must still be in there -- a
// scanner sweeping a field gets a few hits off a conductor on the way past.
// And a conductor has a shape nothing natural has:
//
//   a TREE is a column: returns at every height, all the way down.
//   a WIRE is a thread: a few returns in a thin band, clear air beneath.
//
// That test finds plenty. None of it is wire.
//
//   Dominikowo, 4 pts/m2, leaf-off: 9 "lines" at 6.5-9.8 m, which is exactly
//   distribution height. All of them are bare winter branches and hedgerows.
//   A deciduous canopy with no leaves IS a set of thin threads with gaps.
//
//   Wroclaw, 12 pts/m2: one cluster at elongation 4764 -- collinear to within
//   centimetres over 20 m, at a constant 5.9 m. Textbook conductor geometry.
//   Laid over the orthophoto it is the ridge of a roof. The flaw: a parapet
//   has open ground beneath it, ground returns are not "air", so a building
//   edge passes the clearance test looking like a span over a street.
//
//   Excluding candidates near building- or vegetation-classified returns
//   fixes that and leaves ZERO line-like clusters on either tile.
//
// So either the conductors were never captured, or they cannot be told from
// ridges and branches at these densities by this kind of rule. Either way the
// honest output is nothing, and a detector that confidently returns wires here
// is returning roofs.
//
// The wires that ARE recorded somewhere: GESUT, the geodetic register of
// utility networks, aggregated nationally as KIUT at
//   https://integracja.gugik.gov.pl/cgi-bin/KrajowaIntegracjaUzbrojeniaTerenu
// with a przewod_elektroenergetyczny layer. Three catches. Coverage is by
// powiat and partial -- Wroclaw answers, Dominikowo's powiat returns an empty
// tile. It is WMS only; the WFS is restricted to GUGiK's own address. And it
// is a register of what is buried where, so it carries plan geometry without
// heights and does not cleanly separate overhead from underground -- which is
// the only distinction that matters to an aircraft.
//
// Usage: node tools/wire-spike.mjs <tileNorth> <tileEast>
//
import { readFileSync } from 'node:fs';
import { forEachPoint } from '../src/laz.js';
import { findTiles, createTileStore } from '../src/gugik.js';

const [tn, te] = process.argv.slice(2).map(Number);
const TILE = 500, e0 = te * TILE, n0 = tn * TILE;
const store = createTileStore({ dir: new URL('../var/laz', import.meta.url).pathname });
const srcs = await findTiles({ e0, n0, e1: e0 + TILE, n1: n0 + TILE });

const G = 5, GN = TILE / G;
const gnd = new Float32Array(GN * GN).fill(Infinity);
const X = [], Y = [], Z = [], C = [];
for (const s of srcs) {
  const { file } = await store.fetchLaz(s.url);
  await forEachPoint(readFileSync(file), (e, nth, z, c) => {
    const dx = e - e0, dy = nth - n0;
    if (dx < 0 || dy < 0 || dx >= TILE || dy >= TILE || c === 7) return;
    if (c === 2) {
      const gi = Math.min(GN-1,(dy/G)|0)*GN + Math.min(GN-1,(dx/G)|0);
      if (z < gnd[gi]) gnd[gi] = z;
    }
    X.push(dx); Y.push(dy); Z.push(z); C.push(c);
  });
}
for (let pass = 0; pass < GN; pass++) {
  let holes = 0; const nx = Float32Array.from(gnd);
  for (let r = 0; r < GN; r++) for (let c = 0; c < GN; c++) {
    const i = r*GN+c; if (gnd[i] !== Infinity) continue;
    let s = 0, k = 0;
    for (let dr=-1;dr<=1;dr++) for (let dc=-1;dc<=1;dc++){
      const rr=r+dr, cc=c+dc; if(rr<0||cc<0||rr>=GN||cc>=GN)continue;
      const v=gnd[rr*GN+cc]; if(v!==Infinity){s+=v;k++;}
    }
    if (k) nx[i]=s/k; else holes++;
  }
  gnd.set(nx); if(!holes) break;
}
const ground = (dx,dy) => gnd[Math.min(GN-1,(dy/G)|0)*GN + Math.min(GN-1,(dx/G)|0)];

// 1 m spatial hash over everything, so a neighbourhood query is 9 buckets.
const CELL = 1, CN = TILE / CELL;
const buckets = new Map();
const key = (cx, cy) => cy * CN + cx;
for (let i = 0; i < X.length; i++) {
  const k = key(Math.min(CN-1,(X[i]/CELL)|0), Math.min(CN-1,(Y[i]/CELL)|0));
  let b = buckets.get(k); if (!b) buckets.set(k, b = []);
  b.push(i);
}

const MIN_H = 4;        // below this it is a fence, a hedge, a car
const BAND = 2.0;       // a conductor and its neighbours sit in a thin slice
const CLEAR = 3.0;      // and there is this much empty air beneath them
const MAX_NEIGH = 10;   // a canopy column has far more returns than this

// Air points only. The density test has to ignore the ground: a conductor
// strung over a field has forty ground returns beneath it in any three metres,
// and counting those rejects every wire in open country -- which is most of
// them.
const AIR = [];
for (let i = 0; i < X.length; i++) if (Z[i] - ground(X[i], Y[i]) >= 1.0) AIR.push(i);
const airBuckets = new Map();
for (const i of AIR) {
  const k = key(Math.min(CN-1,(X[i]/CELL)|0), Math.min(CN-1,(Y[i]/CELL)|0));
  let b = airBuckets.get(k); if (!b) airBuckets.set(k, b = []);
  b.push(i);
}
const H = new Float32Array(X.length);
for (const i of AIR) H[i] = Z[i] - ground(X[i], Y[i]);

const stage = { air: AIR.length, high: 0, thin: 0, clear: 0 };
const cand = [];
for (const i of AIR) {
  const h = H[i];
  if (h < MIN_H) continue;
  stage.high++;
  const cx = Math.min(CN-1,(X[i]/CELL)|0), cy = Math.min(CN-1,(Y[i]/CELL)|0);
  let inBand = 0, belowCount = 0, below = 0;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const b = airBuckets.get(key(cx+dx, cy+dy)); if (!b) continue;
    for (const j of b) {
      const hj = H[j];
      if (Math.abs(hj - h) <= BAND) inBand++;
      else if (hj < h) { belowCount++; if (hj > below) below = hj; }
    }
  }
  // A thread, not a canopy: only a handful of returns share its height slice.
  if (inBand > MAX_NEIGH) continue;
  stage.thin++;
  // Nothing built or growing at its own height nearby. This is the test that
  // throws out roof ridges, and it is the one I was missing: a parapet has
  // open ground below it, ground returns are not "air", so it sails through
  // the clearance test looking exactly like a conductor over a street.
  let touching = 0;
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    const b = airBuckets.get(key(cx+dx, cy+dy)); if (!b) continue;
    for (const j of b) {
      if (Math.abs(H[j] - h) > 2.5) continue;
      if (C[j] === 6 || C[j] === 5 || C[j] === 4) touching++;
    }
  }
  if (touching > 2) continue;
  stage.free = (stage.free ?? 0) + 1;
  // And clear air beneath. This is the test that separates a conductor from a
  // branch: a branch has the rest of its tree under it.
  if (belowCount > 2 || h - below < CLEAR) continue;
  stage.clear++;
  cand.push(i);
}
console.log(`  above 1 m ${stage.air.toLocaleString()} -> above ${MIN_H} m ${stage.high.toLocaleString()} -> thin ${stage.thin.toLocaleString()} -> clear of buildings/canopy ${(stage.free??0).toLocaleString()} -> clear beneath ${stage.clear.toLocaleString()}`);

// Cluster the survivors, then keep only what runs in a straight line. A branch
// over a gap passes every test above; it does not pass this one.
const candSet = new Set(cand);
const used = new Set();
const RAD = 4.0;
const lines = [];
for (const seed of cand) {
  if (used.has(seed)) continue;
  const stack = [seed], group = [];
  used.add(seed);
  while (stack.length) {
    const i = stack.pop(); group.push(i);
    const cx = Math.min(CN-1,(X[i]/CELL)|0), cy = Math.min(CN-1,(Y[i]/CELL)|0);
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const b = airBuckets.get(key(cx+dx, cy+dy)); if (!b) continue;
      for (const j of b) {
        if (used.has(j) || !candSet.has(j)) continue;
        if (Math.hypot(X[j]-X[i], Y[j]-Y[i], Z[j]-Z[i]) <= RAD) { used.add(j); stack.push(j); }
      }
    }
  }
  if (group.length < 8) continue;
  // PCA in plan: a conductor is one direction and almost nothing across it.
  let mx=0,my=0; for(const i of group){mx+=X[i];my+=Y[i];} mx/=group.length; my/=group.length;
  let sxx=0,sxy=0,syy=0;
  for(const i of group){const a=X[i]-mx,b=Y[i]-my; sxx+=a*a; sxy+=a*b; syy+=b*b;}
  sxx/=group.length; sxy/=group.length; syy/=group.length;
  const tr=sxx+syy, det=sxx*syy-sxy*sxy;
  const l1=tr/2+Math.sqrt(Math.max(0,tr*tr/4-det)), l2=tr/2-Math.sqrt(Math.max(0,tr*tr/4-det));
  const elong = l2 > 1e-6 ? l1/l2 : Infinity;
  const len = Math.sqrt(l1)*3.4;
  const hs = group.map(i=>Z[i]-ground(X[i],Y[i]));
  lines.push({ n: group.length, len, elong, mx, my,
    h: hs.reduce((a,b)=>a+b,0)/hs.length, hmax: Math.max(...hs),
    dir: Math.atan2(2*sxy, sxx-syy)/2 * 180/Math.PI });
}


lines.sort((a,b)=>b.len-a.len);
console.log(`tile ${tn}/${te}: ${X.length.toLocaleString()} points -> ${cand.length.toLocaleString()} thin-and-clear -> ${lines.length} clusters`);
console.log('\nlinear clusters (length m, elongation, mean h, max h, bearing):');
for (const l of lines.filter(l=>l.elong>6&&l.len>12).slice(0,14)) {
  console.log(`  ${l.len.toFixed(0).padStart(4)} m  elong ${l.elong.toFixed(0).padStart(4)}  h ${l.h.toFixed(1).padStart(5)} m (max ${l.hmax.toFixed(1)})  ${l.dir.toFixed(0).padStart(4)}deg  ${l.n} pts  at ${(e0+l.mx).toFixed(0)},${(n0+l.my).toFixed(0)}`);
}
const keep = lines.filter(l=>l.elong>6&&l.len>12);
console.log(`\n${keep.length} line-like clusters, total ${keep.reduce((a,b)=>a+b.len,0).toFixed(0)} m of candidate conductor`);

// Dump every candidate point plus the kept lines, so they can be laid over the
// orthophoto and judged by eye -- which is the only ground truth available.
import { writeFileSync } from 'node:fs';
writeFileSync('/private/tmp/wires.json', JSON.stringify({
  tile: { tn, te, e0, n0, span: TILE },
  points: cand.map(i => [ +X[i].toFixed(1), +Y[i].toFixed(1), +H[i].toFixed(1) ]),
  lines: keep.map(l => ({ mx:+l.mx.toFixed(1), my:+l.my.toFixed(1), len:+l.len.toFixed(0),
                          dir:+l.dir.toFixed(1), h:+l.h.toFixed(1), n:l.n })),
}));
console.log('wrote /private/tmp/wires.json');
