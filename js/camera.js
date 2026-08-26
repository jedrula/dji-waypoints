// Camera model. FOV is derived from the 35mm-equivalent focal length, which is
// the number DJI publishes and the only one that survives sensor-crop guesswork.
// Mini 5 Pro: 1" sensor, 50 MP, 24 mm equiv (that is the 84 deg *diagonal* FOV
// DJI quotes: 2*atan(43.267/2/24) = 84.0 deg).

const DIAG_35MM = 43.2666; // mm, diagonal of a full 35mm frame

export const CAMERAS = {
  mini5pro: {
    id: 'mini5pro',
    name: 'DJI Mini 5 Pro',
    focal35: 24,
    imageW: 8192, // 50 MP, 4:3
    imageH: 6144,
    maxSpeed: 15, // m/s allowed on a wayline
    minGimbalPitch: -90,
    maxGimbalPitch: 35,
  },
};

// Half-angles of the frame, radians. Long image axis = horizontal = across track.
export function fov(cam) {
  const k = DIAG_35MM / Math.hypot(cam.imageW, cam.imageH);
  const w = cam.imageW * k;
  const h = cam.imageH * k;
  return {
    h: 2 * Math.atan(w / 2 / cam.focal35),
    v: 2 * Math.atan(h / 2 / cam.focal35),
  };
}

// Ground footprint of one nadir photo at `alt` metres AGL.
export function footprint(cam, alt) {
  const f = fov(cam);
  return {
    across: 2 * alt * Math.tan(f.h / 2),
    along: 2 * alt * Math.tan(f.v / 2),
  };
}

// Ground sample distance, cm/px.
export function gsdCm(cam, alt) {
  return (footprint(cam, alt).across * 100) / cam.imageW;
}

// Altitude that yields a given GSD, metres.
export function altForGsd(cam, gsdCmTarget) {
  return (gsdCmTarget * cam.imageW) / (100 * 2 * Math.tan(fov(cam).h / 2));
}

const DEG = Math.PI / 180;
const cross3 = (a, b) => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});

// Camera orientation from compass yaw (0 = north, clockwise) and gimbal pitch
// (negative = down); roll is always 0. World frame is ENU: x east, y north,
// z up. Shared by the 3D view and the coverage scorer so they can never
// disagree about where a camera is looking.
export function orientation(yaw, pitch) {
  const y = yaw * DEG;
  const p = pitch * DEG;
  const forward = {
    x: Math.sin(y) * Math.cos(p),
    y: Math.cos(y) * Math.cos(p),
    z: Math.sin(p),
  };
  const right = { x: Math.cos(y), y: -Math.sin(y), z: 0 };
  return { forward, right, up: cross3(right, forward) };
}
