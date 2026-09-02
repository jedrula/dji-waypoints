import { zip } from './zip.js';

// DJI Fly (consumer: Mini / Air / Mavic) reads waylines.wpml and ignores
// template.kml -- but the file must still be present or the KMZ is rejected.
// Fly-generated files use the uav.com namespace and author "fly"; Pilot 2 /
// enterprise use dji.com. Both profiles are here because the drone enum is the
// one value worth being able to change without a code edit.
export const PROFILES = {
  fly: {
    id: 'fly',
    label: 'DJI Fly (Mini / Air / Mavic)',
    ns: 'http://www.uav.com/wpmz/1.0.2',
    author: 'fly',
    droneEnumValue: 68,
    droneSubEnumValue: 0,
    payload: null,
  },
  pilot2: {
    id: 'pilot2',
    label: 'DJI Pilot 2 (enterprise)',
    ns: 'http://www.dji.com/wpmz/1.0.2',
    author: 'dji-waypoints',
    droneEnumValue: 68,
    droneSubEnumValue: 0,
    payload: null,
  },
};

const f6 = (n) => Number(n).toFixed(6);
const f1 = (n) => Number(n).toFixed(1);

function headingXml(w, indent) {
  const i = indent;
  const poi = w.heading.mode === 'towardPOI' && w.heading.poi
    ? `${f6(w.heading.poi.lat)},${f6(w.heading.poi.lon)},0.000000`
    : '0.000000,0.000000,0.000000';
  // smoothTransition is the only mode that reads waypointHeadingAngle; it is
  // how a side-on camera gets an explicit compass yaw.
  const angle = w.heading.mode === 'smoothTransition' ? f1(w.heading.angle ?? 0) : '0';
  return [
    `${i}<wpml:waypointHeadingParam>`,
    `${i}  <wpml:waypointHeadingMode>${w.heading.mode}</wpml:waypointHeadingMode>`,
    `${i}  <wpml:waypointHeadingAngle>${angle}</wpml:waypointHeadingAngle>`,
    `${i}  <wpml:waypointPoiPoint>${poi}</wpml:waypointPoiPoint>`,
    `${i}  <wpml:waypointHeadingPathMode>followBadArc</wpml:waypointHeadingPathMode>`,
    `${i}</wpml:waypointHeadingParam>`,
  ].join('\n');
}

function turnXml(indent) {
  const i = indent;
  return [
    `${i}<wpml:waypointTurnParam>`,
    `${i}  <wpml:waypointTurnMode>toPointAndStopWithDiscontinuityCurvature</wpml:waypointTurnMode>`,
    `${i}  <wpml:waypointTurnDampingDist>0</wpml:waypointTurnDampingDist>`,
    `${i}</wpml:waypointTurnParam>`,
  ].join('\n');
}

// One action group per waypoint. Each frame in the stop's pitch fan gets a
// gimbalRotate followed by a takePhoto; the gimbal command is skipped when the
// angle already matches, so a single-shot mission emits three rotations in
// total rather than one per waypoint.
function actionGroupXml(w, idx, indent, { withPhoto, pitchRef }) {
  const i = indent;
  const actions = [];
  let actionId = 0;

  const rotate = (pitch) => {
    actions.push([
      `${i}  <wpml:action>`,
      `${i}    <wpml:actionId>${actionId++}</wpml:actionId>`,
      `${i}    <wpml:actionActuatorFunc>gimbalRotate</wpml:actionActuatorFunc>`,
      `${i}    <wpml:actionActuatorFuncParam>`,
      `${i}      <wpml:gimbalRotateMode>absoluteAngle</wpml:gimbalRotateMode>`,
      `${i}      <wpml:gimbalPitchRotateEnable>1</wpml:gimbalPitchRotateEnable>`,
      `${i}      <wpml:gimbalPitchRotateAngle>${f1(pitch)}</wpml:gimbalPitchRotateAngle>`,
      `${i}      <wpml:gimbalRollRotateEnable>0</wpml:gimbalRollRotateEnable>`,
      `${i}      <wpml:gimbalRollRotateAngle>0</wpml:gimbalRollRotateAngle>`,
      `${i}      <wpml:gimbalYawRotateEnable>0</wpml:gimbalYawRotateEnable>`,
      `${i}      <wpml:gimbalYawRotateAngle>0</wpml:gimbalYawRotateAngle>`,
      `${i}      <wpml:gimbalRotateTimeEnable>0</wpml:gimbalRotateTimeEnable>`,
      `${i}      <wpml:gimbalRotateTime>0</wpml:gimbalRotateTime>`,
      `${i}      <wpml:payloadPositionIndex>0</wpml:payloadPositionIndex>`,
      `${i}    </wpml:actionActuatorFuncParam>`,
      `${i}  </wpml:action>`,
    ].join('\n'));
    pitchRef.last = pitch;
  };

  const shoot = (suffix) => {
    actions.push([
      `${i}  <wpml:action>`,
      `${i}    <wpml:actionId>${actionId++}</wpml:actionId>`,
      `${i}    <wpml:actionActuatorFunc>takePhoto</wpml:actionActuatorFunc>`,
      `${i}    <wpml:actionActuatorFuncParam>`,
      `${i}      <wpml:fileSuffix>${suffix}</wpml:fileSuffix>`,
      `${i}      <wpml:payloadPositionIndex>0</wpml:payloadPositionIndex>`,
      `${i}    </wpml:actionActuatorFuncParam>`,
      `${i}  </wpml:action>`,
    ].join('\n'));
  };

  const shots = w.shots ?? [w.pitch];
  if (withPhoto) {
    shots.forEach((pitch, k) => {
      if (pitch !== pitchRef.last) rotate(pitch);
      shoot(shots.length > 1 ? `${w.pass}_${idx}_${k}` : `${w.pass}_${idx}`);
    });
  } else if (w.pitch !== pitchRef.last) {
    // Interval mode: no shutter here, but the pass still needs its gimbal angle.
    rotate(w.pitch);
  }

  if (!actions.length) return null;
  return [
    `${i}<wpml:actionGroup>`,
    `${i}  <wpml:actionGroupId>${idx}</wpml:actionGroupId>`,
    `${i}  <wpml:actionGroupStartIndex>${idx}</wpml:actionGroupStartIndex>`,
    `${i}  <wpml:actionGroupEndIndex>${idx}</wpml:actionGroupEndIndex>`,
    `${i}  <wpml:actionGroupMode>sequence</wpml:actionGroupMode>`,
    `${i}  <wpml:actionTrigger>`,
    `${i}    <wpml:actionTriggerType>reachPoint</wpml:actionTriggerType>`,
    `${i}  </wpml:actionTrigger>`,
    actions.join('\n'),
    `${i}</wpml:actionGroup>`,
  ].join('\n');
}

function intervalGroupXml(mission, lastIdx, indent) {
  const i = indent;
  const d = mission.stats.fwdSpacing;
  return [
    `${i}<wpml:actionGroup>`,
    `${i}  <wpml:actionGroupId>9000</wpml:actionGroupId>`,
    `${i}  <wpml:actionGroupStartIndex>0</wpml:actionGroupStartIndex>`,
    `${i}  <wpml:actionGroupEndIndex>${lastIdx}</wpml:actionGroupEndIndex>`,
    `${i}  <wpml:actionGroupMode>sequence</wpml:actionGroupMode>`,
    `${i}  <wpml:actionTrigger>`,
    `${i}    <wpml:actionTriggerType>multipleDistance</wpml:actionTriggerType>`,
    `${i}    <wpml:actionTriggerParam>${f1(d)}</wpml:actionTriggerParam>`,
    `${i}  </wpml:actionTrigger>`,
    `${i}  <wpml:action>`,
    `${i}    <wpml:actionId>0</wpml:actionId>`,
    `${i}    <wpml:actionActuatorFunc>takePhoto</wpml:actionActuatorFunc>`,
    `${i}    <wpml:actionActuatorFuncParam>`,
    `${i}      <wpml:fileSuffix>interval</wpml:fileSuffix>`,
    `${i}      <wpml:payloadPositionIndex>0</wpml:payloadPositionIndex>`,
    `${i}    </wpml:actionActuatorFuncParam>`,
    `${i}  </wpml:action>`,
    `${i}</wpml:actionGroup>`,
  ].join('\n');
}

function missionConfigXml(mission, profile, indent) {
  const i = indent;
  const p = mission.params;
  const lines = [
    `${i}<wpml:missionConfig>`,
    `${i}  <wpml:flyToWaylineMode>safely</wpml:flyToWaylineMode>`,
    `${i}  <wpml:finishAction>goHome</wpml:finishAction>`,
    `${i}  <wpml:exitOnRCLost>executeLostAction</wpml:exitOnRCLost>`,
    `${i}  <wpml:executeRCLostAction>goBack</wpml:executeRCLostAction>`,
    `${i}  <wpml:takeOffSecurityHeight>${f1(Math.max(20, Math.min(p.altitude, 100)))}</wpml:takeOffSecurityHeight>`,
    `${i}  <wpml:globalTransitionalSpeed>${f1(Math.min(10, mission.cam.maxSpeed))}</wpml:globalTransitionalSpeed>`,
    `${i}  <wpml:globalRTHHeight>${f1(Math.max(30, p.altitude + 10))}</wpml:globalRTHHeight>`,
    `${i}  <wpml:droneInfo>`,
    `${i}    <wpml:droneEnumValue>${profile.droneEnumValue}</wpml:droneEnumValue>`,
    `${i}    <wpml:droneSubEnumValue>${profile.droneSubEnumValue}</wpml:droneSubEnumValue>`,
    `${i}  </wpml:droneInfo>`,
  ];
  if (profile.payload) {
    lines.push(
      `${i}  <wpml:payloadInfo>`,
      `${i}    <wpml:payloadEnumValue>${profile.payload.enum}</wpml:payloadEnumValue>`,
      `${i}    <wpml:payloadPositionIndex>0</wpml:payloadPositionIndex>`,
      `${i}  </wpml:payloadInfo>`
    );
  }
  lines.push(`${i}</wpml:missionConfig>`);
  return lines.join('\n');
}

export function templateKml(mission, profile, now = Date.now()) {
  const p = mission.params;
  const wps = mission.exported.map((w) =>
    [
      `      <Placemark>`,
      `        <Point>`,
      `          <coordinates>${f6(w.lon)},${f6(w.lat)}</coordinates>`,
      `        </Point>`,
      `        <wpml:index>${w.exportIndex}</wpml:index>`,
      `        <wpml:ellipsoidHeight>${f1(w.alt)}</wpml:ellipsoidHeight>`,
      `        <wpml:height>${f1(w.alt)}</wpml:height>`,
      `        <wpml:useGlobalHeight>0</wpml:useGlobalHeight>`,
      `        <wpml:useGlobalSpeed>0</wpml:useGlobalSpeed>`,
      `        <wpml:waypointSpeed>${f1(w.speed)}</wpml:waypointSpeed>`,
      `        <wpml:useGlobalHeadingParam>0</wpml:useGlobalHeadingParam>`,
      headingXml(w, '        '),
      `        <wpml:useGlobalTurnParam>0</wpml:useGlobalTurnParam>`,
      turnXml('        '),
      `        <wpml:gimbalPitchAngle>${f1(w.pitch)}</wpml:gimbalPitchAngle>`,
      `      </Placemark>`,
    ].join('\n')
  );

  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:wpml="${profile.ns}">
  <Document>
    <wpml:author>${profile.author}</wpml:author>
    <wpml:createTime>${now}</wpml:createTime>
    <wpml:updateTime>${now}</wpml:updateTime>
${missionConfigXml(mission, profile, '    ')}
    <Folder>
      <wpml:templateType>waypoint</wpml:templateType>
      <wpml:templateId>0</wpml:templateId>
      <wpml:waylineCoordinateSysParam>
        <wpml:coordinateMode>WGS84</wpml:coordinateMode>
        <wpml:heightMode>relativeToStartPoint</wpml:heightMode>
        <wpml:positioningType>GPS</wpml:positioningType>
      </wpml:waylineCoordinateSysParam>
      <wpml:autoFlightSpeed>${f1(p.speed)}</wpml:autoFlightSpeed>
      <wpml:gimbalPitchMode>usePointSetting</wpml:gimbalPitchMode>
      <wpml:globalWaypointHeadingParam>
        <wpml:waypointHeadingMode>followWayline</wpml:waypointHeadingMode>
        <wpml:waypointHeadingAngle>0</wpml:waypointHeadingAngle>
        <wpml:waypointPoiPoint>0.000000,0.000000,0.000000</wpml:waypointPoiPoint>
        <wpml:waypointHeadingPathMode>followBadArc</wpml:waypointHeadingPathMode>
      </wpml:globalWaypointHeadingParam>
      <wpml:globalWaypointTurnMode>toPointAndStopWithDiscontinuityCurvature</wpml:globalWaypointTurnMode>
      <wpml:globalUseStraightLine>1</wpml:globalUseStraightLine>
${wps.join('\n')}
    </Folder>
  </Document>
</kml>
`;
}

export function waylinesWpml(mission, profile) {
  const p = mission.params;
  const interval = p.photoMode === 'interval';
  const last = mission.exported.length - 1;

  const pitchRef = { last: null };
  const wps = mission.exported.map((w) => {
    const rows = [
      `      <Placemark>`,
      `        <Point>`,
      `          <coordinates>${f6(w.lon)},${f6(w.lat)}</coordinates>`,
      `        </Point>`,
      `        <wpml:index>${w.exportIndex}</wpml:index>`,
      `        <wpml:executeHeight>${f1(w.alt)}</wpml:executeHeight>`,
      `        <wpml:waypointSpeed>${f1(w.speed)}</wpml:waypointSpeed>`,
      headingXml(w, '        '),
      turnXml('        '),
      // A transit waypoint is the climb out of one dome and across to the next.
      // It is a place the aircraft passes through, not a station, so it takes
      // no photo -- and photo: false is how any waypoint says that.
      actionGroupXml(w, w.exportIndex, '        ',
        { withPhoto: !interval && w.photo !== false, pitchRef }),
    ].filter((r) => r !== null);
    if (interval && w.exportIndex === 0) {
      rows.push(intervalGroupXml(mission, last, '        '));
    }
    rows.push(`      </Placemark>`);
    return rows.join('\n');
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:wpml="${profile.ns}">
  <Document>
${missionConfigXml(mission, profile, '    ')}
    <Folder>
      <wpml:templateId>0</wpml:templateId>
      <wpml:waylineId>0</wpml:waylineId>
      <wpml:executeHeightMode>relativeToStartPoint</wpml:executeHeightMode>
      <wpml:autoFlightSpeed>${f1(p.speed)}</wpml:autoFlightSpeed>
${wps.join('\n')}
    </Folder>
  </Document>
</kml>
`;
}

export function buildKmz(mission, profileId = 'fly', now = Date.now()) {
  const profile = PROFILES[profileId] ?? PROFILES.fly;
  return zip(
    [
      { name: 'wpmz/' },
      { name: 'wpmz/res/' },
      { name: 'wpmz/template.kml', text: templateKml(mission, profile, now) },
      { name: 'wpmz/waylines.wpml', text: waylinesWpml(mission, profile) },
    ],
    new Date(now)
  );
}
