#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { readZip } from './unzip.mjs';
import { parseXml, find, first, textOf, walk, tagOf } from './xml.mjs';

// Validate a DJI waypoint KMZ against the WPML spec. Works on files this app
// produced AND on files DJI Fly produced -- point it at both and diff, which is
// the only way to be sure short of flying it.

const ENUMS = {
  flyToWaylineMode: ['safely', 'pointToPoint'],
  finishAction: ['goHome', 'noAction', 'autoLand', 'gotoFirstWaypoint'],
  exitOnRCLost: ['goContinue', 'executeLostAction'],
  executeRCLostAction: ['goBack', 'landing', 'hover'],
  executeHeightMode: ['WGS84', 'relativeToStartPoint', 'realTimeFollowSurface'],
  waypointHeadingMode: ['followWayline', 'manually', 'fixed', 'smoothTransition', 'towardPOI'],
  waypointHeadingPathMode: ['clockwise', 'counterClockwise', 'followBadArc'],
  waypointTurnMode: [
    'coordinateTurn', 'toPointAndStopWithDiscontinuityCurvature',
    'toPointAndStopWithContinuityCurvature', 'toPointAndPassWithContinuityCurvature',
  ],
  actionTriggerType: ['reachPoint', 'betweenAdjacentPoints', 'multipleTiming', 'multipleDistance'],
  actionActuatorFunc: [
    'takePhoto', 'startRecord', 'stopRecord', 'focus', 'zoom', 'customDirName',
    'gimbalRotate', 'rotateYaw', 'hover', 'gimbalEvenlyRotate', 'accurateShoot',
    'orientedShoot', 'panoShot', 'recordPointCloud',
  ],
  gimbalRotateMode: ['absoluteAngle', 'relativeAngle'],
};

const MAX_WAYPOINTS = 200; // DJI Fly

export function checkKmz(buf, label = 'kmz') {
  const errors = [];
  const warnings = [];
  const info = {};
  const err = (m) => errors.push(m);
  const warn = (m) => warnings.push(m);

  let files;
  try { files = readZip(buf); } catch (e) { return { errors: [`${e.message}`], warnings, info }; }
  info.entries = [...files.keys()];

  for (const need of ['wpmz/template.kml', 'wpmz/waylines.wpml']) {
    if (!files.has(need)) err(`missing ${need}`);
  }
  if (errors.length) return { errors, warnings, info };

  const docs = {};
  for (const name of ['wpmz/template.kml', 'wpmz/waylines.wpml']) {
    try { docs[name] = parseXml(files.get(name).data.toString('utf8')); }
    catch (e) { err(`${name}: ${e.message}`); }
  }
  if (errors.length) return { errors, warnings, info };

  const wl = docs['wpmz/waylines.wpml'];
  const ns = Object.entries(wl.attrs).find(([k]) => k.startsWith('xmlns:'))?.[1] ?? '(none)';
  info.namespace = ns;
  if (!/wpmz\/\d+\.\d+\.\d+$/.test(ns)) err(`waylines.wpml namespace looks wrong: ${ns}`);
  info.flavour = ns.includes('uav.com') ? 'DJI Fly (consumer)'
    : ns.includes('dji.com') ? 'DJI Pilot 2 / enterprise' : 'unknown';

  info.author = textOf(docs['wpmz/template.kml'], 'Document/author') ?? '(none)';

  const cfg = first(wl, 'Document/missionConfig');
  if (!cfg) err('waylines.wpml has no missionConfig');
  else {
    for (const k of ['flyToWaylineMode', 'finishAction', 'exitOnRCLost', 'globalTransitionalSpeed']) {
      if (textOf(cfg, k) === undefined) err(`missionConfig missing ${k}`);
    }
    // The spec lists takeOffSecurityHeight as required; DJI Fly does not write
    // it, and a mission pulled off a Mini 5 Pro has no such element. Refusing
    // that file would mean refusing what the aircraft itself produced.
    if (textOf(cfg, 'takeOffSecurityHeight') === undefined) warn('missionConfig has no takeOffSecurityHeight (DJI Fly omits it too)');
    for (const [k, allowed] of Object.entries(ENUMS)) {
      const v = textOf(cfg, k);
      if (v !== undefined && !allowed.includes(v)) err(`missionConfig/${k} = "${v}" not in ${allowed.join('|')}`);
    }
    const thText = textOf(cfg, 'takeOffSecurityHeight');
    if (thText !== undefined) {
      const th = parseFloat(thText);
      if (!(th >= 1.2 && th <= 1500)) err(`takeOffSecurityHeight ${th} outside [1.2, 1500]`);
    }
    const gs = parseFloat(textOf(cfg, 'globalTransitionalSpeed'));
    if (!(gs > 0 && gs <= 15)) err(`globalTransitionalSpeed ${gs} outside (0, 15]`);
    info.drone = `${textOf(cfg, 'droneInfo/droneEnumValue') ?? '?'}/${textOf(cfg, 'droneInfo/droneSubEnumValue') ?? '?'}`;
    info.payload = textOf(cfg, 'payloadInfo/payloadEnumValue') ?? '(none)';
  }

  const folders = find(wl, 'Document/Folder');
  if (!folders.length) err('waylines.wpml has no Folder');
  info.folders = folders.length;
  let total = 0;

  folders.forEach((folder, fi) => {
    const tag = `Folder[${fi}]`;
    for (const k of ['templateId', 'waylineId', 'autoFlightSpeed', 'executeHeightMode']) {
      if (textOf(folder, k) === undefined) err(`${tag} missing ${k}`);
    }
    const ehm = textOf(folder, 'executeHeightMode');
    if (ehm && !ENUMS.executeHeightMode.includes(ehm)) err(`${tag}/executeHeightMode = "${ehm}" invalid`);
    const afs = parseFloat(textOf(folder, 'autoFlightSpeed'));
    if (!(afs > 0 && afs <= 15)) err(`${tag}/autoFlightSpeed ${afs} outside (0, 15]`);

    const pms = find(folder, 'Placemark');
    total += pms.length;
    if (!pms.length) err(`${tag} has no Placemark`);

    pms.forEach((pm, i) => {
      const at = `${tag}/Placemark[${i}]`;
      const idx = textOf(pm, 'index');
      if (idx === undefined) err(`${at} missing index`);
      else if (+idx !== i) err(`${at} index is ${idx}, expected ${i} (must be contiguous from 0)`);

      const coords = textOf(pm, 'Point/coordinates');
      if (!coords) err(`${at} missing Point/coordinates`);
      else {
        const [lon, lat, ...rest] = coords.split(',').map((n) => parseFloat(n));
        if (rest.length) warn(`${at} coordinates carry a third value; DJI expects "lon,lat"`);
        if (!(lon >= -180 && lon <= 180)) err(`${at} longitude ${lon} out of range`);
        if (!(lat >= -90 && lat <= 90)) err(`${at} latitude ${lat} out of range`);
        if (Math.abs(lat) <= 90 && Math.abs(lon) <= 90 && Math.abs(lat) > Math.abs(lon) === false) {
          // not decidable in general; only flag the classic swap near 0,0
        }
      }

      if (textOf(pm, 'executeHeight') === undefined) err(`${at} missing executeHeight`);
      const sp = parseFloat(textOf(pm, 'waypointSpeed'));
      if (!(sp > 0 && sp <= 15)) err(`${at} waypointSpeed ${sp} outside (0, 15]`);

      const hm = textOf(pm, 'waypointHeadingParam/waypointHeadingMode');
      if (!hm) err(`${at} missing waypointHeadingParam/waypointHeadingMode`);
      else if (!ENUMS.waypointHeadingMode.includes(hm)) err(`${at} heading mode "${hm}" invalid`);
      if (hm === 'towardPOI') {
        const poi = textOf(pm, 'waypointHeadingParam/waypointPoiPoint');
        if (!poi || poi.split(',').length !== 3) err(`${at} towardPOI needs waypointPoiPoint "lat,lon,alt"`);
        else if (poi.split(',').slice(0, 2).every((v) => parseFloat(v) === 0)) {
          err(`${at} towardPOI points at 0,0`);
        }
      }
      const tm = textOf(pm, 'waypointTurnParam/waypointTurnMode');
      if (!tm) err(`${at} missing waypointTurnParam/waypointTurnMode`);
      else if (!ENUMS.waypointTurnMode.includes(tm)) err(`${at} turn mode "${tm}" invalid`);
      if (tm && /ContinuityCurvature$/.test(tm) && textOf(pm, 'useStraightLine') === undefined
          && textOf(folder, 'globalUseStraightLine') === undefined) {
        warn(`${at} uses ${tm} without useStraightLine`);
      }

      for (const g of find(pm, 'actionGroup')) {
        const s = +textOf(g, 'actionGroupStartIndex');
        const e = +textOf(g, 'actionGroupEndIndex');
        const gid = textOf(g, 'actionGroupId');
        if (gid === undefined) err(`${at} actionGroup missing actionGroupId`);
        if (!(s <= e)) err(`${at} actionGroup ${gid}: start ${s} > end ${e}`);
        if (s < 0 || e >= pms.length) err(`${at} actionGroup ${gid}: range ${s}..${e} outside 0..${pms.length - 1}`);
        const tt = textOf(g, 'actionTrigger/actionTriggerType');
        if (!tt) err(`${at} actionGroup ${gid} missing actionTriggerType`);
        else if (!ENUMS.actionTriggerType.includes(tt)) err(`${at} trigger "${tt}" invalid`);
        if (tt === 'multipleTiming' || tt === 'multipleDistance') {
          const tp = parseFloat(textOf(g, 'actionTrigger/actionTriggerParam'));
          if (!(tp > 0)) err(`${at} ${tt} needs a positive actionTriggerParam`);
        }
        const acts = find(g, 'action');
        if (!acts.length) err(`${at} actionGroup ${gid} has no action`);
        // DJI Fly numbers action ids from 1 within a group, not 0. Unique and
        // increasing is what actually matters -- the ids are referenced by
        // nothing, and a real Mini 5 Pro mission fails a from-zero rule.
        const seenIds = new Set();
        let lastId = -Infinity;
        acts.forEach((a, ai) => {
          const id = textOf(a, 'actionId');
          if (id === undefined || !Number.isFinite(+id)) err(`${at} actionGroup ${gid} action ${ai} has no actionId`);
          else if (seenIds.has(+id)) err(`${at} actionGroup ${gid}: duplicate actionId ${id}`);
          else if (+id < lastId) err(`${at} actionGroup ${gid}: actionId ${id} goes backwards`);
          if (id !== undefined) { seenIds.add(+id); lastId = +id; }
          const fn = textOf(a, 'actionActuatorFunc');
          if (!fn) err(`${at} actionGroup ${gid} action ${ai} missing actionActuatorFunc`);
          else if (!ENUMS.actionActuatorFunc.includes(fn)) err(`${at} unknown action "${fn}"`);
          if (fn === 'gimbalRotate') {
            const mode = textOf(a, 'actionActuatorFuncParam/gimbalRotateMode');
            if (mode && !ENUMS.gimbalRotateMode.includes(mode)) err(`${at} gimbalRotateMode "${mode}" invalid`);
            const p = parseFloat(textOf(a, 'actionActuatorFuncParam/gimbalPitchRotateAngle'));
            if (Number.isFinite(p) && (p < -90 || p > 35)) {
              warn(`${at} gimbal pitch ${p} outside the Mini 5 Pro range [-90, 35]`);
            }
          }
        });
      }
    });
  });

  info.waypoints = total;
  info.photos = [...walk(wl)].filter((n) => tagOf(n.tag) === 'actionActuatorFunc' && n.text === 'takePhoto').length;
  info.triggers = [...new Set([...walk(wl)]
    .filter((n) => tagOf(n.tag) === 'actionTriggerType').map((n) => n.text))];
  info.heights = [...new Set([...walk(wl)]
    .filter((n) => tagOf(n.tag) === 'executeHeight').map((n) => +n.text))].sort((a, b) => a - b);
  info.pitches = [...new Set([...walk(wl)]
    .filter((n) => tagOf(n.tag) === 'gimbalPitchRotateAngle').map((n) => +n.text))].sort((a, b) => a - b);

  if (total > MAX_WAYPOINTS) warn(`${total} waypoints exceeds DJI Fly's limit of ${MAX_WAYPOINTS}`);
  return { errors, warnings, info };
}

// Structural fingerprint: which wpml elements appear, and how often.
export function shape(buf) {
  const files = readZip(buf);
  const out = {};
  for (const name of ['wpmz/template.kml', 'wpmz/waylines.wpml']) {
    if (!files.has(name)) continue;
    const counts = new Map();
    for (const n of walk(parseXml(files.get(name).data.toString('utf8')))) {
      const t = tagOf(n.tag);
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    out[name] = counts;
  }
  return out;
}

function main() {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.log('usage: node tools/check.mjs <mission.kmz> [reference-from-dji.kmz]');
    process.exit(2);
  }
  const [target, reference] = args;
  const { errors, warnings, info } = checkKmz(readFileSync(target), target);

  console.log(`\n${target}`);
  console.log(`  flavour     ${info.flavour ?? '?'}  (${info.namespace ?? '?'})`);
  console.log(`  author      ${info.author ?? '?'}`);
  console.log(`  drone       ${info.drone ?? '?'}   payload ${info.payload ?? '?'}`);
  console.log(`  waypoints   ${info.waypoints ?? '?'} in ${info.folders ?? '?'} folder(s)`);
  console.log(`  photos      ${info.photos ?? '?'}   triggers: ${(info.triggers ?? []).join(', ')}`);
  console.log(`  heights     ${(info.heights ?? []).join(', ')}`);
  console.log(`  gimbal      ${(info.pitches ?? []).join(', ')}`);
  console.log(`  entries     ${(info.entries ?? []).join(', ')}`);

  for (const w of warnings) console.log(`  WARN  ${w}`);
  for (const e of errors) console.log(`  ERROR ${e}`);

  if (reference) {
    console.log(`\ndiff against ${reference}`);
    const a = shape(readFileSync(target));
    const b = shape(readFileSync(reference));
    for (const file of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const ca = a[file] ?? new Map();
      const cb = b[file] ?? new Map();
      const onlyRef = [...cb.keys()].filter((k) => !ca.has(k));
      const onlyOurs = [...ca.keys()].filter((k) => !cb.has(k));
      console.log(`  ${file}`);
      if (onlyRef.length) console.log(`    only in reference (consider adding): ${onlyRef.join(', ')}`);
      if (onlyOurs.length) console.log(`    only in ours (consider removing):   ${onlyOurs.join(', ')}`);
      if (!onlyRef.length && !onlyOurs.length) console.log('    same element vocabulary');
    }
  }

  const ok = errors.length === 0;
  console.log(`\n${ok ? 'PASS' : `FAIL — ${errors.length} error(s)`}${warnings.length ? ` (${warnings.length} warning(s))` : ''}\n`);
  process.exit(ok ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
