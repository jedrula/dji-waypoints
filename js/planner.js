import { frame, distM, bearing } from './geo.js';
import { footprint, gsdCm, fov } from './camera.js';
import { footprintOf, bounds, centroid, circumradius, polygonArea, clipSegment, DEFAULT_SHAPE } from './shape.js';
import { checkObstacles } from './collide.js';

// A 3DGS-oriented capture over the points you tapped. Three passes, in this order:
//   1. nadir grid         - metric backbone, gimbal -90
//   2. oblique cross grid - runs perpendicular to the nadir lines so the two
//                           together give obliques from four azimuths
//   3. perimeter orbit    - heading locked on the box centre, catches facades
//                           and the sky-facing sides the grids miss
//   4. surround ring      - the same ring flown with the camera pointing OUT,
//                           so the capture has a horizon and a world around it
// Gaussian splatting wants view diversity per surface point far more than it
// wants a perfect nadir block, which is why the oblique pass is on by default.

export const DEFAULTS = {
  altitude: 40,
  frontOverlap: 0.8,
  sideOverlap: 0.7,
  speed: 4,
  obliquePitch: -45,
  orbitPitch: null,      // null = aim at the box centre, derived from geometry
  nadir: true,
  oblique: true,
  orbit: true,
  orbitPad: 15,          // metres outside the box corners
  // Rings per THING, not per site -- so three is affordable, and three is what
  // a reconstruction wants: one looking up, one level, one looking down. A
  // subject only ever seen from one elevation has no data for the others.
  subjectClearance: 2,   // how far a dome stands off a thing, and off its neighbours
  orbitRings: 3,
  // Where the LOWEST ring sits, in metres AGL. null spreads from half the set
  // altitude, which is an arbitrary anchor that happens to look reasonable. A
  // number here is the honest version: the height of the tallest thing under
  // the ring plus the clearance you are willing to fly at, so the low ring
  // skims the site rather than guessing at it.
  surround: true,        // outward-facing ring: the landscape, not the subject
  surroundRings: 1,      // >1 adds vertical parallax on whatever stands nearby
  transect: false,       // crossing lines THROUGH the site, camera side-on
  // Cross passes default to ONE height. Multi-level was built and measured:
  // on its own it helps (45 -> 54% coverage over three levels), but alongside a
  // multi-ring orbit it is redundant, because the low ring already supplies the
  // near-horizontal low look. Low-wall coverage measured 85% with either one or
  // two cross-pass levels. Height diversity belongs to the rings.
  transectLevels: 1,
  transectSpacingScale: 1,
  // Per-level height overrides, written by dragging a level in the 3D view.
  // null, or a list whose length no longer matches the ring/level count, falls
  // back to the derived spread -- so changing the ring count, or moving the
  // altitude slider, quietly discards heights that no longer mean anything.
  orbitHeights: null,
  transectHeights: null,
  // Height of what you are capturing; the orbit aims at its middle, not at the
  // ground under it. Defaults to 3 m because almost everything worth splatting
  // has height -- play equipment, cars, walls, hedges, people-sized things --
  // and assuming flat ground is the unusual case, not the common one. Set it to
  // 0 for genuinely flat terrain.
  subjectHeight: 3,
  photoMode: 'waypoint', // 'waypoint' | 'interval'
  shotsPerStop: 1,       // 1 = single frame; >1 = gimbal pitch fan at the stop
  shotSpread: 20,        // degrees between frames in the fan
  usableFlightMin: 18,
};

// Rotating the camera about its own optical centre adds no parallax and no new
// viewing direction per surface point -- what it adds is vertical coverage: at
// one stop you catch the roofline, the wall and the ground instead of a slice.
// Clamped to the gimbal's real travel, and widened on whichever side has room
// so a nadir stop still yields distinct angles.
export function fanPitches(pitch, n, spread, cam) {
  if (n <= 1) return [pitch];
  const lo = cam.minGimbalPitch;
  const hi = cam.maxGimbalPitch;
  const out = [];
  const push = (v) => {
    // Rounded to 0.1 for the same reason the orbit's own pitch is: the XML
    // writes one decimal, so an unrounded angle means the planner, the UI and
    // the file disagree about what was shot.
    const c = Math.round(Math.max(lo, Math.min(hi, v)) * 10) / 10;
    if (!out.some((x) => Math.abs(x - c) < 0.5)) out.push(c);
  };
  const half = (n - 1) / 2;
  for (let k = -half; k <= half; k++) push(pitch + k * spread);
  // Clamping can collapse the fan (a -90 nadir has no room below); keep
  // widening upward, then downward, until we have n distinct angles.
  let step = 1;
  while (out.length < n && step < 12) {
    push(pitch + (half + step) * spread);
    if (out.length < n) push(pitch - (half + step) * spread);
    step++;
  }
  return out.sort((a, b) => a - b).slice(0, n);
}

// Lines are laid across the footprint's bounding box and then cut down to the
// footprint itself. Cutting the LINE rather than dropping shots off a fixed
// lattice is what keeps the spacing right either way, and it puts a shot on
// each cut end -- the edge of the thing you tapped, where overlap is thinnest.
function gridPass(g) {
  const { halfCross, halfAlong, sideSpacing, fwdSpacing, axis, f, clip } = g;
  const nLines = Math.max(2, Math.ceil((2 * halfCross) / sideSpacing) + 1);
  const dCross = (2 * halfCross) / (nLines - 1);
  const at = (c, a) => (axis === 'NS' ? { x: c, y: a } : { x: a, y: c });
  const along = (q) => (axis === 'NS' ? q.y : q.x);

  const pts = [];
  let flown = 0;          // lines that survived the clip, and so drive the serpentine
  let shotTotal = 0;
  for (let i = 0; i < nLines; i++) {
    const c = -halfCross + i * dCross;
    let a0 = -halfAlong;
    let a1 = halfAlong;
    if (clip) {
      const seg = clipSegment(clip, at(c, -halfAlong), at(c, halfAlong));
      if (!seg) continue;                     // this line misses the footprint
      a0 = Math.min(along(seg[0]), along(seg[1]));
      a1 = Math.max(along(seg[0]), along(seg[1]));
    }
    const span = a1 - a0;
    // A line that only grazes a corner is one photo, not two on top of each other.
    const nShots = span < 0.5 ? 1 : Math.max(2, Math.ceil(span / fwdSpacing) + 1);
    const dAlong = nShots > 1 ? span / (nShots - 1) : 0;
    for (let j = 0; j < nShots; j++) {
      const k = flown % 2 === 0 ? j : nShots - 1 - j;   // serpentine
      const q = at(c, a0 + k * dAlong);
      pts.push({
        ...f.toLatLon(q.x, q.y),
        alt: g.alt,
        pitch: g.pitch,
        heading: { mode: 'followWayline' },
        photo: true,
        pass: g.pass,
        lineStart: j === 0,
      });
    }
    flown++;
    shotTotal += nShots;
  }
  return {
    pts,
    nLines: flown,
    dCross,
    nShots: flown ? Math.round(shotTotal / flown) : 0,
    dAlong: fwdSpacing,
  };
}

// Every tall thing on the site, in one list, in local metres.
//
// This is the single rule, and it has to be single: the things flown around and
// the things scored must be the same things, or the plan optimises for a site
// the score is not measuring.
//
// Three or more capture taps with an outline between them are ONE thing -- the
// footprint you drew -- not one thing per tap. Get that wrong and it shows up
// twice over: the flight puts a dome around each corner of a building, and the
// scorer models four pillars whose inward faces nothing can ever see.
//
// Obstacles are separate things, each its own. You marked them individually
// because they are individual, and flying round them is what photographs them.
export function subjectsOf(local, hull, avoid = [], f) {
  const out = [];
  const tallTaps = local.filter((q) => (q.height ?? 0) > 0.5);

  if (tallTaps.length && hull && hull.length >= 3 && polygonArea(hull) > 1) {
    const c = centroid(hull);
    const b = bounds(hull);
    out.push({
      x: c.x,
      y: c.y,
      // The footprint's own width, so the ring stands off from the whole thing
      // rather than from an assumed six metres.
      span: Math.max(b.x1 - b.x0, b.y1 - b.y0),
      height: Math.max(...tallTaps.map((q) => q.height)),
      kind: 'capture',
    });
  } else {
    // One or two taps outline nothing, so each is a small thing of its own.
    for (const q of tallTaps) {
      out.push({ x: q.x, y: q.y, span: SUBJECT_SPAN, height: q.height, kind: 'capture' });
    }
  }

  for (const o of avoid) {
    if ((o.height ?? 0) <= 0.5) continue;
    out.push({
      ...f.toLocal(o.lat, o.lon),
      span: o.span ?? SUBJECT_SPAN,
      height: o.height,
      kind: 'obstacle',
    });
  }
  return out;
}

// One dome around ONE thing.
//
// The perimeter orbit this replaces was a SITE-shaped answer: a single ring at
// a single radius around everything, which gives a 3 m wall and a 20 m tower
// exactly the same treatment and spends most of its length over the grass
// between them. What a reconstruction wants is angular diversity per surface,
// and that is a thing-shaped question -- so every tall thing you tapped gets
// its own ring, sized to itself.
//
// Obstacles are tall things too. You marked them so the aircraft would go
// round them, and going round them is precisely the flight that photographs
// them, so they are subjects here as well: one tap does both jobs.
// How wide a tapped thing is assumed to be when nothing says otherwise. A tap
// says where and how tall, not how wide; a genuinely wide thing is several taps.
export const SUBJECT_SPAN = 6;

const FILL = 1.35;              // leave a margin around the thing in frame
const MIN_PER_RING_OBJ = 12;    // every 30 deg, the floor for a small thing
const MAX_PER_RING_OBJ = 32;    // every 11 deg, past which frames stop earning

function objectPass(g) {
  const { subject, others = [], f, cam, frontOverlap, rings, clearance, pitchOverride } = g;
  const { x: cx, y: cy, height: H, span } = subject;
  const aimZ = H / 2;

  // Far enough back to frame the thing's HEIGHT, and never closer than its own
  // footprint plus whatever clearance the flight is being held to.
  //
  // Framing the whole WIDTH is the tempting version and it is wrong: it asks to
  // fit the entire footprint in one frame, so a 200 m site three metres tall
  // gets a 260 m standoff, resolves nothing, and costs a ring the size of the
  // county. Width is covered by going around; only height has to fit the frame,
  // and the span term already keeps the ring outside the thing.
  const view = fov(cam);
  const framing = (H / 2) / Math.tan(view.v / 2) * FILL;
  const r = Math.max(span / 2 + clearance + 2, framing, 3);

  // Heights from just above the ground to over the top, so the thing is seen
  // looking up, level and down. One ring means the level one.
  //
  // The low ring is the one that has to be argued with. Sized off this thing
  // alone it is a route that flies at 2 m around a bush standing next to a
  // twenty metre tree -- so anything else the ring would pass near raises the
  // floor. Only things it would actually pass near: a tall thing on the far
  // side of the site is not in the way, and letting it lift every ring would
  // throw away the low views that are the whole point of flying one.
  // Only things the RING passes close to, which is not the same as things near
  // the middle. A ring of radius r stands off from its own centre, so its
  // closest approach to something d away is |d - r| -- a neighbour at exactly
  // r is right under the flight path, and one at the centre or far outside is
  // nowhere near it. Testing distance-from-centre instead counts neighbours the
  // ring never goes near, which collapsed the dome round every post in a row
  // that had a post on each side.
  const nearby = others.filter((o) => {
    const d = Math.hypot(o.x - cx, o.y - cy);
    return Math.abs(d - r) - o.span / 2 < clearance;
  });
  const floor = nearby.length
    ? Math.max(...nearby.map((o) => o.height)) + clearance
    : 0;
  const lowZ = Math.max(2, floor, Math.min(H * 0.35, H - 0.5));
  const highZ = Math.max(lowZ + 1, floor, H + Math.max(2, H * 0.35));
  // Rings only earn their place if they see the thing from genuinely different
  // elevations. Squeezed between a floor raised by a neighbour and the top of a
  // short thing, three of them land within a metre of each other and cost three
  // times the flying for one viewpoint -- so below a couple of metres of spread
  // it is honestly one ring.
  const spread = highZ - lowZ;
  const useRings = rings <= 1 || spread < 2 ? 1 : rings;
  const heights = useRings === 1
    ? [Math.max(lowZ, Math.min(highZ, aimZ > lowZ ? aimZ : lowZ))]
    : Array.from({ length: useRings }, (_, k) => lowZ + (spread * k) / (useRings - 1));

  // A dome rather than a cylinder: each ring pulls in as it rises so the slant
  // range stays constant, which keeps framing and ground resolution even.
  const slant = Math.hypot(r, Math.max(0.5, heights[0] - aimZ));
  const centre = f.toLatLon(cx, cy);
  const pts = [];

  for (let ri = 0; ri < heights.length; ri++) {
    const h = heights[ri];
    const rise = h - aimZ;
    const ringR = useRings === 1
      ? r
      : Math.max(span / 2 + clearance + 1, Math.sqrt(Math.max(9, slant * slant - rise * rise)));
    // Spacing comes from the slant range to the thing, not from height above
    // the ground: the camera is aimed sideways at it.
    const range = Math.hypot(ringR, rise);
    const frameWidth = 2 * range * Math.tan(view.h / 2);
    const step = Math.max(0.4, frameWidth * (1 - frontOverlap));
    const n = Math.max(MIN_PER_RING_OBJ, Math.min(MAX_PER_RING_OBJ,
      Math.ceil((2 * Math.PI * ringR) / step)));
    const aimed = -(Math.atan2(rise, ringR) * 180) / Math.PI;
    const pitch = pitchOverride ?? Math.round(
      Math.max(cam.minGimbalPitch, Math.min(cam.maxGimbalPitch, aimed)) * 10,
    ) / 10;
    for (let i = 0; i < n; i++) {
      // Offset alternate rings by half a step so they do not stack identically.
      const ang = (2 * Math.PI * (i + (ri % 2) * 0.5)) / n;
      pts.push({
        ...f.toLatLon(cx + ringR * Math.sin(ang), cy + ringR * Math.cos(ang)),
        alt: h,
        pitch,
        heading: { mode: 'towardPOI', poi: centre },
        photo: true,
        pass: 'orbit',
        lineStart: i === 0,
      });
    }
  }
  return { pts, r, heights, top: highZ };
}


// The same ring, flown with the camera pointing AWAY from the middle. Every
// other pass here photographs the box; nothing photographs what is around it,
// so a splat trained on them is a subject floating in a void -- no horizon, no
// depth behind it, and nothing at any distance to place it against. Which is
// also why the result has no sense of perspective: perspective is what the
// background gives you.
//
// Where the depth out here comes from is worth being clear about. Two stations
// on opposite sides of the ring look outward along opposite azimuths and share
// no view at all, so this pass alone triangulates almost nothing far away -- it
// is a wide panorama with a little parallax between neighbours. The long
// baseline comes from the INWARD orbit: an orbit frame looks over the box at
// the landscape beyond it, from the far side of the same ring, which both
// triangulates that landscape and keeps the two image sets connected in SfM.
// The pass is worth much more with the orbit on than without it.
function surroundPass(g) {
  const { halfX, halfY, pad, f, alt, rings, cam, frontOverlap } = g;
  const r = Math.max(3, (g.reach ?? Math.hypot(halfX, halfY)) + pad);

  // Facing outward, a frame covers an ANGLE rather than a patch of ground, so
  // the spacing that matters is the yaw step between stations and nothing about
  // the range. Bounded either side: below 12 stations consecutive frames stop
  // overlapping enough to match, above 36 they are near-duplicates costing
  // waypoints the subject passes spend better.
  const stepDeg = ((fov(cam).h * 180) / Math.PI) * (1 - frontOverlap);
  const n = Math.max(12, Math.min(36, Math.ceil(360 / Math.max(2, stepDeg))));

  // Tilt so the top of the frame sits just above the horizon: everything below
  // it is landscape, and the horizon line -- the strongest feature anywhere out
  // here -- stays in shot. This is a camera angle, not a geometry problem: the
  // horizon is at eye level from 5 m and from 100 m alike, so unlike every
  // other pitch in this file it does not depend on the altitude. What it does
  // depend on is the lens, and a wider one would tilt further down.
  const SKY_MARGIN = 4;
  const pitch = Math.round(Math.max(cam.minGimbalPitch, Math.min(cam.maxGimbalPitch,
    -((fov(cam).v * 90) / Math.PI - SKY_MARGIN))) * 10) / 10;

  // Extra rings sit BELOW the set altitude, same spread as the orbit. Height
  // buys much less here than it does on the subject -- the far field looks the
  // same from either -- but it does give vertical parallax on what stands just
  // outside the ring, which is exactly the mid-distance stuff a splat renders
  // worst.
  const heights = rings <= 1
    ? [alt]
    : Array.from({ length: rings }, (_, k) => alt * (0.5 + (0.5 * k) / (rings - 1)));

  const pts = [];
  for (let ri = 0; ri < heights.length; ri++) {
    for (let i = 0; i < n; i++) {
      // Half-step offset between rings, so a second ring is not the first one
      // photographed twice.
      const angDeg = (360 * (i + (ri % 2) * 0.5)) / n;
      const ang = (angDeg * Math.PI) / 180;
      pts.push({
        ...f.toLatLon(r * Math.sin(ang), r * Math.cos(ang)),
        alt: heights[ri],
        pitch,
        // No POI to aim at -- towardPOI only ever points inward -- so the
        // outward azimuth is written as an explicit compass yaw, the same way
        // the cross passes hold a side-on camera.
        heading: { mode: 'smoothTransition', angle: ((angDeg + 540) % 360) - 180 },
        photo: true,
        pass: 'surround',
        lineStart: i === 0,
      });
    }
  }
  return { pts, n, r, pitch, heights };
}

// Lines flown THROUGH the site with the camera side-on. An orbit only ever
// sees a subject's outside; anything tucked between structures, or facing
// inward, is occluded from every point on the ring. Crossing passes fix that,
// and a sideways camera gives real lateral parallax as you sweep past --
// far more useful than a forward-facing camera, which barely changes view
// direction as it advances.
function transectPass(g) {
  const { halfX, halfY, axis, f, alt, cam, frontOverlap, aimZ, spacingScale, level } = g;
  const alongHalf = axis === 'NS' ? halfY : halfX;
  const crossHalf = axis === 'NS' ? halfX : halfY;

  // How far the stuff we are looking at typically sits. Half the narrow
  // dimension is a decent stand-in for "the other side of the site".
  const look = Math.max(4, Math.min(halfX, halfY)) * spacingScale;
  const frameW = 2 * look * Math.tan(fov(cam).h / 2);
  const shotSpacing = Math.max(0.8, frameW * (1 - frontOverlap));
  const lineSpacing = Math.max(3, look);

  const nLines = Math.max(1, Math.ceil((2 * crossHalf) / lineSpacing));
  const dCross = nLines === 1 ? 0 : (2 * crossHalf) / nLines;
  const nShots = Math.max(2, Math.ceil((2 * alongHalf) / shotSpacing) + 1);
  const dAlong = (2 * alongHalf) / (nShots - 1);

  // Aim the camera at the subject's middle from this level's height. A low pass
  // comes out near horizontal, which is what sees under an overhang and into
  // the bottom of a structure; a high one looks down into the gaps instead.
  const pitch = Math.round(-(Math.atan2(alt - aimZ, look) * 180) / Math.PI * 10) / 10;
  void level;

  const pts = [];
  for (let i = 0; i < nLines; i++) {
    const c = nLines === 1 ? 0 : -crossHalf + dCross / 2 + i * dCross;
    const forward = i % 2 === 0 ? 1 : -1; // serpentine
    // Camera looks 90 deg off the direction of travel. Because the serpentine
    // reverses each line, that side alternates -- so a pair of lines covers
    // both flanks without flying the grid twice.
    const travelYaw = axis === 'NS' ? (forward > 0 ? 0 : 180) : (forward > 0 ? 90 : -90);
    const yaw = ((travelYaw + 90 + 540) % 360) - 180;
    for (let j = 0; j < nShots; j++) {
      const k = forward > 0 ? j : nShots - 1 - j;
      const a = -alongHalf + k * dAlong;
      const x = axis === 'NS' ? c : a;
      const y = axis === 'NS' ? a : c;
      pts.push({
        ...f.toLatLon(x, y),
        alt,
        pitch,
        heading: { mode: 'smoothTransition', angle: yaw },
        photo: true,
        pass: 'transect',
        lineStart: j === 0,
      });
    }
  }
  return { pts, nLines, nShots, lineSpacing, shotSpacing, pitch, look };
}

// A rectangle is four taps, one at each corner. Older saved plans and links
// carry a rect, and this is how they arrive at a planner that no longer has
// one -- exactly, since a box's hull is its own corners.
export function pointsFromRect(rect, height = 0) {
  return [
    { lat: rect.south, lon: rect.west, height },
    { lat: rect.south, lon: rect.east, height },
    { lat: rect.north, lon: rect.east, height },
    { lat: rect.north, lon: rect.west, height },
  ];
}

// `site` is what you tapped: `{ points: [{lat, lon, height}], shape }`. The
// footprint derived from those points is what gets flown -- see js/shape.js for
// why that derivation is a table rather than a rule.
export function planMission(site, opts, cam) {
  const p = { ...DEFAULTS, ...opts };
  const points = site?.points ?? [];
  if (!points.length) throw new Error('a mission needs at least one capture point');
  const shape = site.shape ?? DEFAULT_SHAPE;
  // Marked to be flown around, and therefore also flown around -- which is the
  // flight that photographs them. See objectPass.
  const avoid = site.obstacles ?? [];

  // Two passes at the frame, because the origin wants to be the middle of the
  // footprint and the footprint is not known until there is a frame to build it
  // in. The first frame is a scratch one at the mean of the taps; the second is
  // the one everything downstream measures in, and it sits where every pass
  // already assumes the middle is.
  const mean = (k) => points.reduce((t, q) => t + q[k], 0) / points.length;
  const scratch = frame(mean('lat'), mean('lon'));
  const rough = footprintOf(points.map((q) => scratch.toLocal(q.lat, q.lon)), shape);
  const rb = bounds(rough);
  const mid = scratch.toLatLon((rb.x0 + rb.x1) / 2, (rb.y0 + rb.y1) / 2);

  const f = frame(mid.lat, mid.lon);
  const local = points.map((q) => ({ ...f.toLocal(q.lat, q.lon), height: q.height ?? 0 }));
  const hull = footprintOf(local, shape);
  const bb = bounds(hull);
  const halfX = Math.max(Math.abs(bb.x0), Math.abs(bb.x1));
  const halfY = Math.max(Math.abs(bb.y0), Math.abs(bb.y1));
  // Only worth clipping to a footprint that has an inside. One or two taps
  // describe a spot, not an outline, and the orbit is the pass that matters there.
  const clip = polygonArea(hull) > 1 ? hull : null;
  const reach = circumradius(hull, { x: 0, y: 0 });

  // How tall the thing is, from the taps rather than from a slider: the tallest
  // point you marked. Everything that used to read `subjectHeight` -- where the
  // orbit aims, how low the rings start, how far the auto-fit search reaches
  // down -- now answers to what you actually said was there.
  p.subjectHeight = opts.subjectHeight
    ?? local.reduce((h, q) => Math.max(h, q.height ?? 0), 0);

  const subjects = subjectsOf(local, hull, avoid, f);

  const fp = footprint(cam, p.altitude);
  const sideSpacing = Math.max(1, fp.across * (1 - p.sideOverlap));
  const fwdSpacing = Math.max(1, fp.along * (1 - p.frontOverlap));

  const waypoints = [];
  const passes = [];
  // Every distinct height the plan flies, tagged with what owns it, so the 3D
  // view can hand a dragged level back to the knob that set it.
  const heightLevels = [];
  // The heights each multi-level pass actually flew, so the UI can pin one of
  // them without having to re-derive the whole spread.
  let orbitHeightsUsed = null;
  let transectHeightsUsed = null;
  // `push(...pts)` blows the call stack once a pass runs into six figures of
  // points, which a big box at low altitude does; append instead of spreading.
  const add = (pts) => { for (const q of pts) waypoints.push(q); };

  // Something always flies at the set altitude -- the grids, the top orbit ring,
  // the top cross level -- and they are tied to it rather than to each other,
  // so that level answers to the altitude slider and never to one pass.
  heightLevels.push({ kind: 'altitude', index: 0, z: p.altitude });
  if (p.nadir) {
    const r = gridPass({
      halfCross: halfX, halfAlong: halfY, sideSpacing, fwdSpacing, clip,
      axis: 'NS', f, alt: p.altitude, pitch: -90, pass: 'nadir',
    });
    add(r.pts);
    passes.push({ name: 'Nadir grid', count: r.pts.length, detail: `${r.nLines} lines @ ${r.dCross.toFixed(1)} m` });
  }
  if (p.oblique) {
    const r = gridPass({
      halfCross: halfY, halfAlong: halfX, sideSpacing, fwdSpacing, clip,
      axis: 'EW', f, alt: p.altitude, pitch: p.obliquePitch, pass: 'oblique',
    });
    add(r.pts);
    passes.push({ name: `Oblique grid ${p.obliquePitch}°`, count: r.pts.length, detail: `${r.nLines} lines @ ${r.dCross.toFixed(1)} m` });
  }
  if (p.transect) {
    const aimZ = (p.subjectHeight ?? 0) / 2;
    const nLevels = Math.max(1, p.transectLevels ?? 1);
    // Spread from a low band up to the set altitude, never below 2 m. The low
    // pass is the one that earns its place -- it is the only camera in the whole
    // plan that looks under things.
    const lowest = Math.max(2, Math.min(p.altitude, p.altitude * 0.35));
    const derived = nLevels === 1
      ? [p.altitude]
      : Array.from({ length: nLevels }, (_, k) => lowest + ((p.altitude - lowest) * k) / (nLevels - 1));
    const xTop = derived.length - 1;
    const levels = p.transectHeights?.length === derived.length
      ? p.transectHeights.map((z, i) => (i === xTop ? p.altitude : Math.min(z, p.altitude)))
      : derived;
    transectHeightsUsed = levels;

    for (let li = 0; li < levels.length; li++) {
      const levelAlt = levels[li];
      if (levelAlt !== p.altitude) heightLevels.push({ kind: 'transect', index: li, z: levelAlt });
      for (const axis of ['NS', 'EW']) {
        const r = transectPass({
          halfX, halfY, axis, f, cam, aimZ, level: li,
          alt: levelAlt, frontOverlap: p.frontOverlap,
          spacingScale: p.transectSpacingScale ?? 1,
        });
        add(r.pts);
        passes.push({
          name: `Cross ${axis === 'NS' ? 'N–S' : 'E–W'} @ ${levelAlt.toFixed(1)} m ${r.pitch}°`,
          count: r.pts.length,
          detail: `${r.nLines} line${r.nLines > 1 ? 's' : ''}, side-on at ${r.look.toFixed(0)} m`,
        });
      }
    }
  }
  if (p.orbit && subjects.length) {
    // Nearest-first, so the route walks from one thing to the next rather than
    // criss-crossing the site between them.
    const order = [...subjects];
    const visited = [];
    let at = { x: 0, y: 0 };
    while (order.length) {
      let best = 0;
      for (let i = 1; i < order.length; i++) {
        if (Math.hypot(order[i].x - at.x, order[i].y - at.y)
            < Math.hypot(order[best].x - at.x, order[best].y - at.y)) best = i;
      }
      const [next] = order.splice(best, 1);
      visited.push(next);
      at = next;
    }

    const rings = Math.max(1, p.orbitRings);
    let count = 0;
    let tallest = null;
    const flownRings = [];

    // Getting from one dome to the next is a leg like any other, and the
    // aircraft flies it straight. A dome round a bush sits at three metres and
    // the next one is across the site, so the direct line between them goes
    // through whatever stands in between -- which is exactly the tree you
    // marked. Climb out of each dome and travel above everything.
    //
    // The vertical part is safe by construction: it rises from a station that
    // is already standing clear of its own subject. The horizontal part is at
    // transitZ, which clears the tallest thing on the site by the clearance.
    const transitZ = Math.max(...subjects.map((q) => q.height)) + (p.subjectClearance ?? 2);
    const overhead = (w) => ({
      ...w, alt: transitZ, photo: false, transit: true,
      heading: { mode: 'followWayline' }, pitch: -90, lineStart: false,
    });
    for (const subject of visited) {
      const r = objectPass({
        subject,
        others: visited.filter((o) => o !== subject),
        f, cam, frontOverlap: p.frontOverlap, rings,
        clearance: p.subjectClearance ?? 2, pitchOverride: p.orbitPitch,
      });
      if (r.pts.length) {
        // Only worth the two waypoints when the ring is actually below the
        // transit height: a dome round the tallest thing already ends up there.
        const needsLift = r.heights.some((h) => h < transitZ - 0.5);
        if (needsLift) add([overhead(r.pts[0])]);
        add(r.pts);
        if (needsLift) add([overhead(r.pts[r.pts.length - 1])]);
      }
      count += r.pts.length;
      flownRings.push(r.heights.length);
      if (!tallest || subject.height > tallest.subject.height) tallest = { subject, r };
    }
    // The altitude scale can only speak for one set of heights, so it speaks
    // for the tallest thing -- the one whose rings reach highest.
    orbitHeightsUsed = tallest.r.heights;
    tallest.r.heights.forEach((h, i) => {
      if (!heightLevels.some((lv) => Math.abs(lv.z - h) < 0.05)) {
        heightLevels.push({ kind: 'orbit', index: i, z: h });
      }
    });
    const nCap = visited.filter((q) => q.kind === 'capture').length;
    const nObs = visited.length - nCap;
    // A dome squeezed between a raised floor and a short subject honestly flies
    // fewer rings than were asked for, so report what was flown.
    const ringTally = [...new Set(flownRings)].sort((a, b) => b - a)
      .map((n) => `${flownRings.filter((x) => x === n).length}\u00d7${n}`)
      .join(', ');
    const sameEverywhere = new Set(flownRings).size === 1;
    passes.push({
      name: `Orbit ${visited.length} thing${visited.length === 1 ? '' : 's'}`,
      count,
      detail: `${sameEverywhere ? `${flownRings[0]} ring${flownRings[0] === 1 ? '' : 's'} each`
        : `rings ${ringTally}`} · tallest ${tallest.subject.height.toFixed(0)} m`
        + `${nObs ? ` · ${nCap} tapped, ${nObs} obstacles` : ''}`,
    });
  }
  if (p.surround) {
    const r = surroundPass({
      halfX, halfY, reach, pad: p.orbitPad, f, cam, frontOverlap: p.frontOverlap,
      alt: p.altitude, rings: Math.max(1, p.surroundRings),
    });
    add(r.pts);
    // Rings below the top one get a label on the altitude scale but no grip:
    // nothing here is derived from a height the way the orbit's aim is, so
    // there is nothing for a drag to write back to.
    passes.push({
      name: `Surround ${r.pitch.toFixed(0)}°`,
      count: r.pts.length,
      detail: r.heights.length > 1
        ? `${r.heights.length} rings, 360° in ${r.n}`
        : `360° in ${r.n}, r = ${r.r.toFixed(0)} m`,
    });
  }

  // Where each camera actually points. followWayline aims along the leg to the
  // next waypoint; towardPOI aims at the box centre. Needed by both the map
  // pose ticks and the 3D frustums, so it belongs in the plan, not the view.
  waypoints.forEach((w, i) => {
    if (w.heading.mode === 'smoothTransition') {
      w.yaw = w.heading.angle;
      return;
    }
    if (w.heading.mode === 'towardPOI' && w.heading.poi) {
      w.yaw = bearing(w, w.heading.poi);
      return;
    }
    const next = waypoints[i + 1];
    if (next && next.pass === w.pass) w.yaw = bearing(w, next);
    else if (i > 0 && waypoints[i - 1].pass === w.pass) w.yaw = waypoints[i - 1].yaw ?? 0;
    else w.yaw = 0;
  });

  // A distance trigger fires one frame; the fan only exists in waypoint mode.
  const shotsPerStop = p.photoMode === 'interval' ? 1 : Math.max(1, p.shotsPerStop);
  waypoints.forEach((w) => {
    w.speed = p.speed;
    w.shots = fanPitches(w.pitch, shotsPerStop, p.shotSpread, cam);
  });

  // In interval mode only the turns of the grid legs are waypoints; the photos
  // come from a distance-triggered action group. Ring points are all kept --
  // a circle reduced to its endpoints is a straight line.
  let exported = waypoints;
  let photos = waypoints.reduce((n, w) => n + (w.photo === false ? 0 : w.shots.length), 0);
  if (p.photoMode === 'interval') {
    exported = waypoints.filter((w, i) => {
      if (w.pass === 'orbit' || w.pass === 'surround') return true;
      return w.lineStart || i === waypoints.length - 1 || waypoints[i + 1]?.lineStart;
    });
  }
  exported.forEach((w, i) => { w.exportIndex = i; });

  let dist = 0;
  for (let i = 1; i < waypoints.length; i++) dist += distM(waypoints[i - 1], waypoints[i]);

  if (p.photoMode === 'interval') photos = Math.round(dist / fwdSpacing);

  // Waypoint-per-photo stops at every point; interval mode flies straight
  // through. Extra frames in a fan cost a gimbal move plus a shutter, not a stop.
  const extraShots = exported.reduce((n, w) => n + w.shots.length - 1, 0);
  const stopPenalty = p.photoMode === 'waypoint' ? exported.length * 2.5 + extraShots * 2 : 0;
  const seconds = dist / Math.max(p.speed, 0.1) + stopPenalty;

  return {
    params: p,
    cam,
    site: { points, shape, obstacles: avoid },
    subjects,                   // every tall thing, in local metres
    hull,                       // the footprint, in local metres
    points: local,              // the taps themselves, in local metres, with heights
    frame: f,
    centre: f.toLatLon(0, 0),
    sizeX: halfX * 2,
    sizeY: halfY * 2,
    waypoints,          // every planned photo station (for drawing)
    exported,           // what actually goes into the KMZ
    passes,
    levels: heightLevels,
    heights: { orbit: orbitHeightsUsed, transect: transectHeightsUsed },
    stats: {
      photos,
      waypoints: exported.length,
      shotsPerStop,
      distanceM: dist,
      seconds,
      minutes: seconds / 60,
      batteries: Math.ceil(seconds / 60 / p.usableFlightMin),
      gsdCm: gsdCm(cam, p.altitude),
      footprint: fp,
      sideSpacing,
      fwdSpacing,
      // The footprint's own area, which is the ground you are paying to fly
      // over -- not the bounding box around it.
      areaHa: (polygonArea(hull) || halfX * 2 * halfY * 2) / 10000,
      reachM: reach,
    },
  };
}

// DJI Fly refuses missions over 200 waypoints, which a full 3-pass 3DGS capture
// blows past on anything bigger than a house. Split into consecutive chunks the
// app exports as numbered KMZs; each keeps the serpentine order so flying them
// back to back is identical to flying one long mission.
export const DJI_FLY_MAX_WAYPOINTS = 200;

export function splitMission(mission, maxWp = DJI_FLY_MAX_WAYPOINTS) {
  const wps = mission.exported;
  if (wps.length <= maxWp) return [{ ...mission, part: 1, parts: 1 }];
  const parts = Math.ceil(wps.length / maxWp);
  const per = Math.ceil(wps.length / parts);
  const out = [];
  for (let i = 0; i < parts; i++) {
    const slice = wps.slice(i * per, (i + 1) * per).map((w, j) => ({ ...w, exportIndex: j }));
    out.push({ ...mission, exported: slice, part: i + 1, parts });
  }
  return out;
}

// "Propose a flight for this box" -- the whole point of the app. A 3-pass plan
// at 40 m over anything larger than a courtyard blows past both DJI Fly's 200
// waypoint cap and a single battery, so search for the lowest altitude (best
// GSD) that fits both budgets, preferring waypoint-per-photo because that is
// the shutter mode every DJI Fly build is known to honour.
export function proposePlan(site, base, cam, budget = {}) {
  const maxWp = budget.maxWaypoints ?? DJI_FLY_MAX_WAYPOINTS;
  const maxMin = budget.maxMinutes ?? (base.usableFlightMin ?? DEFAULTS.usableFlightMin);

  // A plan that does not fly is not a fit, however cheap it is. Auto-fit used to
  // ask only whether a mission fitted the battery and DJI Fly's waypoint cap,
  // which over a statue in a courtyard picked the lowest altitude available and
  // sent the grids straight through the twelve metre walls around it. The
  // altitude search is exactly where that has to be caught: by the time the
  // collision warning appears, the app has already recommended the flight.
  const clearance = base.subjectClearance ?? DEFAULTS.subjectClearance ?? 2;
  const boxes = (site.obstacles ?? []).filter((o) => (o.height ?? 0) > 0);
  const hits = (m) => {
    if (!boxes.length) return false;
    const local = boxes.map((o, i) => {
      const c = m.frame.toLocal(o.lat, o.lon);
      const half = (o.span ?? SUBJECT_SPAN) / 2;
      return {
        id: `a${i}`,
        min: { x: c.x - half, y: c.y - half, z: 0 },
        max: { x: c.x + half, y: c.y + half, z: Math.max(0.1, o.height) },
      };
    });
    return checkObstacles(m, local, { clearance }).strikes > 0;
  };
  const fits = (m) => m.stats.waypoints <= maxWp && m.stats.minutes <= maxMin && !hits(m);

  // Over flat ground one ring is enough -- the orbit is a supporting pass, and
  // there is no vertical subject to see from several elevations. The moment
  // something has height, elevation diversity is the biggest single win
  // available: measured, one ring to two is +7.1 points of coverage, where two
  // to three is +0.5 and three to four is +0.8.
  // Height comes from the taps now, so ask the planner rather than the caller:
  // one cheap plan settles whether there is anything vertical here at all.
  const probe = planMission(site, { ...base, altitude: 40 }, cam);
  const subjectHeight = probe.params.subjectHeight;
  const hasHeight = subjectHeight > 0.5;
  const ringChoices = hasHeight ? [3, 2, 1] : [1];

  // How low the search may go. Over flat ground 20 m is a sensible floor. With
  // a subject that has height, the useful altitudes are just above it -- an
  // under-canopy playground wants 5-8 m, and a 20 m floor could never find it.
  const floorAlt = hasHeight ? Math.max(3, Math.round(subjectHeight * 1.5)) : 20;
  const step = hasHeight ? 1 : 5;

  // Lowest altitude (best GSD) that fits, for one shutter mode and ring count.
  const lowestFit = (photoMode, orbitRings, surround) => {
    for (let alt = floorAlt; alt <= 120; alt += step) {
      const m = planMission(site, { ...base, altitude: alt, photoMode, orbitRings, surround }, cam);
      if (fits(m)) return m;
    }
    return null;
  };

  // Waypoint-per-photo is the only shutter mode every DJI Fly build is known to
  // honour, so exhaust it before considering the distance trigger -- a worse
  // GSD that definitely flies beats a better one that might not.
  const pick = (photoMode, surround) => {
    const options = ringChoices
      .map((r) => ({ rings: r, mission: lowestFit(photoMode, r, surround) }))
      .filter((o) => o.mission);
    if (!options.length) return null;
    // Rings cost waypoints, which pushes altitude up. Never trade a lot of
    // ground resolution for them: only accept extra rings whose altitude is
    // within a third of the best altitude available.
    const bestAlt = Math.min(...options.map((o) => o.mission.params.altitude));
    const affordable = options.filter((o) => o.mission.params.altitude <= bestAlt * 1.34);
    return affordable.sort((a, b) => b.rings - a.rings)[0].mission;
  };

  // Auto-fit stays predictable on purpose: lowest altitude that fits, with the
  // ring count set by whether the subject has height. It deliberately does NOT
  // optimise the coverage score -- that produced surprising picks (a single
  // high ring, most of the budget unspent) and it cannot know about a canopy
  // overhead. The scorer's job is to tell the pilot what a plan is missing,
  // which the Coverage and Down-angle readouts and their warnings already do.
  // The surround ring is the first thing to go when a battery will not stretch
  // to everything, and it goes before the shutter mode changes. It is the only
  // pass pointed at something other than the subject, so a capture without it
  // is still the capture that was asked for -- where a capture flown on a
  // trigger no one has seen work might be no capture at all. Over a big site
  // that is the usual outcome: the ring is 900 m of flying at 140 m radius, a
  // quarter of the battery, and none of it spent on the subject.
  const wantSurround = base.surround ?? DEFAULTS.surround;
  const full = pick('waypoint', wantSurround);
  const trimmed = !full && wantSurround ? pick('waypoint', false) : null;
  const primary = full ?? trimmed;
  const fallback = pick('interval', wantSurround);

  if (primary) {
    const better = fallback && fallback.params.altitude < primary.params.altitude - 5;
    return {
      mission: primary,
      fits: true,
      note: trimmed
        ? `One battery does not cover the surround ring as well, so it is off — the subject passes come first. Turn it back on and accept a longer flight, or a split.`
        : null,
      alternative: better
        ? `Distance-interval shutter would fit at ${fallback.params.altitude} m (${fallback.stats.gsdCm.toFixed(2)} cm/px vs ${primary.stats.gsdCm.toFixed(2)}), but that trigger is unverified on this airframe.`
        : null,
    };
  }
  if (fallback) {
    return {
      mission: fallback,
      fits: true,
      note: `Too many stations for one photo per waypoint — proposing the distance-interval shutter instead. That trigger is unverified on the Mini 5 Pro; check your first flight.`,
      alternative: null,
    };
  }

  // Nothing fits either way: hand back the lightest plan and say so plainly.
  let best = null;
  for (const photoMode of ['waypoint', 'interval']) {
    for (let alt = 20; alt <= 120; alt += 5) {
      const m = planMission(site, { ...base, altitude: alt, photoMode }, cam);
      if (!best || m.stats.minutes < best.stats.minutes) best = m;
    }
  }
  return {
    mission: best,
    fits: false,
    alternative: null,
    note: `No single flight covers this area. The lightest plan is ${Math.round(best.stats.minutes)} min over ${best.stats.waypoints} waypoints — shrink the box, or accept the split.`,
  };
}
