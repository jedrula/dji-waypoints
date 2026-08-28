// One shape for anything that gets drawn: the planner's output and a mission
// read back off the controller are both a list of camera stations in a local
// frame, so they go through the same renderers rather than each having its own.
//
// planMission() already produces this shape. What was missing is the other
// direction -- a KMZ has no idea which pass a waypoint belonged to, no box and
// no local frame, so those get reconstructed here and nowhere else.

import { frame } from './geo.js';

// The file records what the camera did, not why, so the pass is inferred. It
// only drives colour, and the rules follow from how the passes are flown:
// an orbit is the only pass that aims at a point, nadir is the only one that
// looks straight down, and a near-level camera is a cross pass.
export function inferPass(w) {
  if (w.headingMode === 'towardPOI') return 'orbit';
  if (w.pitch <= -80) return 'nadir';
  if (w.pitch <= -20) return 'oblique';
  return 'transect';
}

export function routeFromRead(read, cam) {
  const lats = read.waypoints.map((w) => w.lat);
  const lons = read.waypoints.map((w) => w.lon);
  const rect = {
    north: Math.max(...lats), south: Math.min(...lats),
    east: Math.max(...lons), west: Math.min(...lons),
  };
  const f = frame((rect.north + rect.south) / 2, (rect.east + rect.west) / 2);

  return {
    source: 'device',
    cam,
    rect,
    frame: f,
    meta: read.meta,
    // `shots` is the pitch fan a planned stop carries; a read waypoint has one
    // frame, so it is a fan of one.
    waypoints: read.waypoints.map((w) => ({
      lat: w.lat, lon: w.lon, alt: w.alt,
      yaw: w.yaw, pitch: w.pitch, shots: [w.pitch],
      pass: inferPass(w),
    })),
  };
}
