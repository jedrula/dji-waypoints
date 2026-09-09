// What colour a thing is, in every view.
//
// One table, because three renderers draw the same flight: the map, the flat
// 3D and the survey. It was copied into two of them with identical values and
// the third had invented its own single blue, which is how a pass ends up
// green on the left and blue on the right while both files look correct on
// their own.
//
// The colours themselves are per PASS, not per view: what tells you which pass
// a line belongs to is its colour, so the same pass has to look the same
// wherever it is drawn or the two pictures are of different flights.
export const PASS_COLOR = {
  nadir: '#4da3ff',
  oblique: '#ffb84d',
  orbit: '#5ad19a',
  transect: '#c98bff',
  surround: '#ff6fb5',
  establish: '#7ee0a0',
};

// Anything the palette has no name for. Grey, so an unnamed pass reads as
// unnamed rather than borrowing a meaning.
export const PASS_FALLBACK = '#8b98a5';

// A leg the collision check flagged, by how bad it is. A strike and a near
// miss are not the same news, so they are not the same colour.
export const LEG_COLOR = { clear: '#ffb84d', near: '#ff9f4d', strike: '#ff5d5d' };

// A waypoint carries its own `pass` key, so most callers can index the table
// directly. This is for the places that only have the pass's NAME -- the list
// of passes in the readout -- where "Oblique grid -45°" has to become
// `oblique`.
export function passColour(name) {
  const lower = String(name ?? '').toLowerCase();
  const first = lower.split(/[\s-]/)[0];
  if (PASS_COLOR[first]) return PASS_COLOR[first];
  const starts = Object.keys(PASS_COLOR).find((k) => lower.startsWith(k));
  return starts ? PASS_COLOR[starts] : PASS_FALLBACK;
}

// The three-digit hex a WebGL renderer wants, from the same string the other
// two use. One table, two notations.
export const asHex = (css) => Number.parseInt(String(css).replace('#', ''), 16);
