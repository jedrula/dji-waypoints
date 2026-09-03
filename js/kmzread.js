// Read a mission back out of a KMZ, in the browser or in node.
//
// The planner only ever wrote missions; this is the other direction, and it is
// what lets you look at what is actually sitting on the controller rather than
// trusting that the file you pushed is the file that is there. It also opens a
// KMZ from anywhere else -- an older export, someone else's plan.
//
// Inflate comes from DecompressionStream, which both a modern browser and node
// 18+ provide, so there is no zip dependency and no build step.

import { parseXml, find, first, textOf } from './xml.js';

const u32 = (b, i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24);
const u16 = (b, i) => b[i] | (b[i + 1] << 8);

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Enough of a zip reader to find one named entry. Central directory only --
// local headers lie about sizes when a data descriptor is used.
//
// `only` skips the inflate for entries you did not ask for. A KMZ has two small
// files in it and never needs this; a BDOT10k powiat package has eighty, one of
// which is 182 MB of building polygons, and inflating that to reach the 4 MB of
// power lines next to it is a minute and a gigabyte for nothing.
export async function unzip(bytes, { only } = {}) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let eocd = -1;
  for (let i = b.length - 22; i >= 0 && i > b.length - 66000; i--) {
    if (u32(b, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip: no end-of-central-directory record');

  const count = u16(b, eocd + 10);
  let p = u32(b, eocd + 16) >>> 0;
  const out = new Map();
  const dec = new TextDecoder();

  for (let n = 0; n < count; n++) {
    if (u32(b, p) !== 0x02014b50) throw new Error(`bad central directory entry ${n}`);
    const method = u16(b, p + 10);
    const compSize = u32(b, p + 20) >>> 0;
    const nameLen = u16(b, p + 28);
    const extraLen = u16(b, p + 30);
    const commentLen = u16(b, p + 32);
    const localOff = u32(b, p + 42) >>> 0;
    const name = dec.decode(b.subarray(p + 46, p + 46 + nameLen));

    if (only && !only(name)) { p += 46 + nameLen + extraLen + commentLen; continue; }

    if (u32(b, localOff) !== 0x04034b50) throw new Error(`bad local header for ${name}`);
    const dataAt = localOff + 30 + u16(b, localOff + 26) + u16(b, localOff + 28);
    const comp = b.subarray(dataAt, dataAt + compSize);
    if (method === 0) out.set(name, comp);
    else if (method === 8) out.set(name, await inflateRaw(comp));
    else throw new Error(`${name}: unsupported compression method ${method}`);

    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const num = (v, fallback = 0) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
};

// A read mission is deliberately not the planner's shape: it is what the file
// says, not what some parameters would have produced. Only the fields the map
// and the summary need are lifted out.
export async function readKmz(bytes) {
  const files = await unzip(bytes);
  const wpml = files.get('wpmz/waylines.wpml');
  if (!wpml) throw new Error('no wpmz/waylines.wpml in this KMZ — is it a DJI mission?');
  // parseXml collapses to the document element, so paths start below <kml> --
  // the same shape tools/check.mjs walks.
  const kml = parseXml(new TextDecoder().decode(wpml));
  const cfg = first(kml, 'Document/missionConfig');
  const folder = first(kml, 'Document/Folder');
  if (!folder) throw new Error('waylines.wpml has no Folder');

  const speed = num(textOf(folder, 'autoFlightSpeed'), 0);
  const waypoints = find(folder, 'Placemark').map((pm, i) => {
    const coords = (textOf(pm, 'Point/coordinates') ?? '').trim().split(/[\s,]+/);
    const gimbal = find(pm, 'actionGroup/action')
      .find((a) => textOf(a, 'actionActuatorFunc') === 'gimbalRotate');
    const actions = find(pm, 'actionGroup/action')
      .map((a) => textOf(a, 'actionActuatorFunc')).filter(Boolean);
    return {
      index: Number(textOf(pm, 'index') ?? i),
      lon: num(coords[0]),
      lat: num(coords[1]),
      alt: num(textOf(pm, 'executeHeight') ?? textOf(pm, 'height')),
      speed: num(textOf(pm, 'waypointSpeed'), speed),
      headingMode: textOf(pm, 'waypointHeadingParam/waypointHeadingMode') ?? 'followWayline',
      yaw: num(textOf(pm, 'waypointHeadingParam/waypointHeadingAngle')),
      poi: textOf(pm, 'waypointHeadingParam/waypointPoiPoint') ?? null,
      pitch: gimbal ? num(textOf(gimbal, 'actionActuatorFuncParam/gimbalPitchRotateAngle')) : null,
      actions,
    };
  });
  if (!waypoints.length) throw new Error('this KMZ has no waypoints');

  // Gimbal pitch is set once and held until the next gimbalRotate, so a
  // waypoint without one is still pointing wherever the last one left it.
  let held = 0;
  for (const w of waypoints) {
    if (w.pitch === null) w.pitch = held; else held = w.pitch;
  }

  const heights = [...new Set(waypoints.map((w) => Math.round(w.alt)))].sort((a, b) => a - b);
  return {
    waypoints,
    meta: {
      waypoints: waypoints.length,
      photos: waypoints.reduce((n, w) => n + w.actions.filter((a) => a === 'takePhoto').length, 0),
      heights,
      speed,
      drone: `${textOf(cfg, 'droneInfo/droneEnumValue') ?? '?'}/${textOf(cfg, 'droneInfo/droneSubEnumValue') ?? '?'}`,
      finishAction: textOf(cfg, 'finishAction') ?? null,
      pitches: [...new Set(waypoints.map((w) => Math.round(w.pitch * 10) / 10))].sort((a, b) => a - b),
    },
  };
}
