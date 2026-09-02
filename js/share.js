// A plan is deterministic: the same box and the same settings produce the same
// KMZ, byte for byte. So moving a plan between devices does not need the file --
// it needs four corners and a dozen numbers, which fit in a string you can
// AirDrop, message to yourself, or paste.
//
// That closes the awkward gap in the field: the phone has a real GNSS receiver
// and knows where you are standing, the MacBook has the USB cable to the
// controller, and the two do not talk. Plan on the phone, send the code, install
// from the Mac.

// v1 carried a rectangle. v2 carries the points you tapped, because that is
// now what a plan is -- and a v1 code still decodes, into the four corners of
// its rectangle, which is the same footprint it always described.
const VERSION = 'v2';
const LEGACY = 'v1';

// Short keys keep the code short enough to read out loud if it comes to that.
const FIELDS = [
  ['altitude', 'a'],
  ['frontOverlap', 'f'],
  ['sideOverlap', 'd'],
  ['speed', 'v'],
  ['orbitPad', 'o'],
  ['subjectHeight', 'h'],
  ['photoMode', 'm'],
  ['shotsPerStop', 'n'],
  ['orbitRings', 'g'],
  ['surroundRings', 's'],
  ['profile', 'x'],
  // Heights pinned by dragging a level in the 3D view. Lists, not numbers,
  // and usually absent -- a code only carries them once you have dragged.
  ['orbitHeights', 'H'],
  ['transectHeights', 'L'],
];
// Append only: the mask is positional, so a code written before a pass existed
// decodes with that pass OFF. That is the right answer -- a restored plan has to
// be the plan that was saved, not today's defaults applied to yesterday's box.
const PASSES = ['nadir', 'oblique', 'orbit', 'transect', 'surround'];

function b64url(s) {
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64url(s) {
  const t = s.replace(/-/g, '+').replace(/_/g, '/');
  return atob(t + '='.repeat((4 - (t.length % 4)) % 4));
}

// `ui` is raw control values, not derived params: restoring has to reproduce
// what the sliders said, or a restored plan quietly differs from the original.
// A point is [lat, lon, height]. Six decimals is ~10 cm, which is finer than
// anything a tap on a phone map can express, and the height is whole metres
// plus one -- you judged it standing next to the thing.
const packPoint = (q) => [+q.lat.toFixed(6), +q.lon.toFixed(6), +(q.height ?? 0).toFixed(1)];

export function encodePlan(site, ui) {
  const points = site?.points ?? [];
  if (!points.length) return null;
  const o = { t: points.map(packPoint) };
  if (site.shape && site.shape !== 'hull') o.k = site.shape;
  for (const [key, short] of FIELDS) if (ui[key] !== undefined && ui[key] !== null) o[short] = ui[key];
  o.p = PASSES.reduce((mask, name, i) => mask | (ui[name] ? 1 << i : 0), 0);
  return `${VERSION}.${b64url(JSON.stringify(o))}`;
}

// Takes a bare code, a full URL, or a hash -- whatever survived the trip
// through Messages, Notes or a QR reader.
export function decodePlan(text) {
  if (!text) return null;
  let s = String(text).trim();
  const hash = s.lastIndexOf('#');
  if (hash >= 0) s = s.slice(hash + 1);
  if (s.startsWith('plan=')) s = s.slice(5);
  const version = [VERSION, LEGACY].find((v) => s.startsWith(`${v}.`));
  if (!version) return null;
  let o;
  try {
    o = JSON.parse(unb64url(s.slice(version.length + 1)));
  } catch {
    return null;
  }

  const points = version === LEGACY ? legacyPoints(o) : readPoints(o.t);
  if (!points) return null;

  const ui = {};
  for (const [key, short] of FIELDS) if (o[short] !== undefined) ui[key] = o[short];
  PASSES.forEach((name, i) => { ui[name] = Boolean(o.p & (1 << i)); });
  return { points, shape: typeof o.k === 'string' ? o.k : 'hull', ui };
}

const sane = (lat, lon) => Number.isFinite(lat) && Number.isFinite(lon)
  && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;

function readPoints(t) {
  if (!Array.isArray(t) || !t.length || t.length > 400) return null;
  const points = [];
  for (const q of t) {
    if (!Array.isArray(q) || q.length < 2) return null;
    const [lat, lon, height] = q.map(Number);
    if (!sane(lat, lon)) return null;
    points.push({ lat, lon, height: Number.isFinite(height) ? Math.max(0, height) : 0 });
  }
  return points;
}

// A v1 plan is a rectangle, and a rectangle is its four corners -- so an old
// link opens as exactly the footprint it always described, with a height of 0
// because v1 kept the subject height as a slider rather than on the ground.
// `h` was that slider; it becomes the height of every corner, which is the
// closest true reading of what the plan meant.
function legacyPoints(o) {
  if (!Array.isArray(o.r) || o.r.length !== 4 || o.r.some((n) => typeof n !== 'number')) return null;
  const [north, south, east, west] = o.r;
  if (north <= south || !sane(north, east) || !sane(south, west)) return null;
  const height = Number.isFinite(o.h) ? Math.max(0, o.h) : 0;
  return [
    { lat: south, lon: west, height },
    { lat: south, lon: east, height },
    { lat: north, lon: east, height },
    { lat: north, lon: west, height },
  ];
}
