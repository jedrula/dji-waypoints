// A plan is deterministic: the same box and the same settings produce the same
// KMZ, byte for byte. So moving a plan between devices does not need the file --
// it needs four corners and a dozen numbers, which fit in a string you can
// AirDrop, message to yourself, or paste.
//
// That closes the awkward gap in the field: the phone has a real GNSS receiver
// and knows where you are standing, the MacBook has the USB cable to the
// controller, and the two do not talk. Plan on the phone, send the code, install
// from the Mac.

const VERSION = 'v1';

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
  ['profile', 'x'],
];
const PASSES = ['nadir', 'oblique', 'orbit', 'transect'];

function b64url(s) {
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64url(s) {
  const t = s.replace(/-/g, '+').replace(/_/g, '/');
  return atob(t + '='.repeat((4 - (t.length % 4)) % 4));
}

// `ui` is raw control values, not derived params: restoring has to reproduce
// what the sliders said, or a restored plan quietly differs from the original.
export function encodePlan(rect, ui) {
  if (!rect) return null;
  const o = { r: [rect.north, rect.south, rect.east, rect.west].map((n) => +n.toFixed(6)) };
  for (const [key, short] of FIELDS) o[short] = ui[key];
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
  if (!s.startsWith(`${VERSION}.`)) return null;
  let o;
  try {
    o = JSON.parse(unb64url(s.slice(VERSION.length + 1)));
  } catch {
    return null;
  }
  if (!Array.isArray(o.r) || o.r.length !== 4 || o.r.some((n) => typeof n !== 'number')) return null;
  const [north, south, east, west] = o.r;
  if (north <= south || Math.abs(north) > 90 || Math.abs(south) > 90) return null;

  const ui = {};
  for (const [key, short] of FIELDS) if (o[short] !== undefined) ui[key] = o[short];
  PASSES.forEach((name, i) => { ui[name] = Boolean(o.p & (1 << i)); });
  return { rect: { north, south, east, west }, ui };
}
