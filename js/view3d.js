import { fov, orientation } from './camera.js';
import { GRADE_COLOR } from './coverage.js';
import { createTileCache, pickZoom, tileRange, tileBounds, TILE_PX } from './tiles.js';

// A small hand-rolled 3D view. The scene is a few thousand line segments, so a
// WebGL library would be more dependency than drawing. Coordinates are local
// ENU metres: x east, y north, z up.

const PASS_COLOR = { nadir: '#4da3ff', oblique: '#ffb84d', orbit: '#5ad19a', transect: '#c98bff', surround: '#ff6fb5' };
// Obstacles are the world, not the plan, so they get their own family of
// colours rather than borrowing a pass's: slate while the flight stays clear of
// them, and the grade of the trouble once it does not.
const CONFLICT_COLOR = { strike: '#ff5d5d', near: '#ffb84d' };
const OBSTACLE_COLOR = { clear: '#9aa7b4', near: '#ffb84d', strike: '#ff5d5d' };
const HOVER_COLOR = '#4da3ff';
const DEG = Math.PI / 180;

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a, b) => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
const norm = (a) => {
  const l = Math.hypot(a.x, a.y, a.z) || 1;
  return { x: a.x / l, y: a.y / l, z: a.z / l };
};
const add = (a, b, s = 1) => ({ x: a.x + b.x * s, y: a.y + b.y * s, z: a.z + b.z * s });

export function createView3D(canvas) {
  const ctx = canvas.getContext('2d');
  let mission = null;
  let scene = null;
  let coverage = null;
  let showCoverage = true;
  let obstacles = [];      // boxes already in the mission's local metres
  let conflicts = [];      // legs the collision check flagged, in lat/lon
  let ground = null;       // { on, url, attribution } -- imagery under the plan
  let tiles = null;        // the cache for whichever basemap `ground` names
  let redrawTimer = null;
  const view = { az: 35, el: 28, dist: 400, target: { x: 0, y: 0, z: 0 } };
  const NEAR = 0.5;
  const VFOV = 28 * DEG;

  let onLevelChange = null;   // set by the app; enables dragging the levels
  let onBoxHeight = null;     // ditto, for dragging the top of an obstacle
  let onBoxSelect = null;     // ditto, for clicking one
  let hits = [];              // every projected obstacle face, nearest first
  let tags = [];              // name + height plates, drawn last so nothing hides them
  let hoverBox = null;        // obstacle id under the pointer, or being dragged
  let scale = null;           // last drawn altitude scale, for hit testing
  let anchorIdx = -1;         // which outset corner currently carries the mast
  let hoverZ = null;          // level under the pointer, or being dragged
  let framedKey = null;       // ground box the camera was last framed to

  function basis() {
    const el = view.el * DEG;
    const az = view.az * DEG;
    const eye = {
      x: view.target.x + view.dist * Math.cos(el) * Math.sin(az),
      y: view.target.y + view.dist * Math.cos(el) * Math.cos(az),
      z: view.target.z + view.dist * Math.sin(el),
    };
    const forward = norm(sub(view.target, eye));
    const right = norm(cross(forward, { x: 0, y: 0, z: 1 }));
    const up = cross(right, forward);
    return { eye, forward, right, up };
  }

  // World point -> view space. vz is depth along the view axis.
  function toView(p, b) {
    const d = sub(p, b.eye);
    return { x: dot(d, b.right), y: dot(d, b.up), z: dot(d, b.forward) };
  }

  function project(v, w, h, f) {
    return { x: w / 2 + (v.x / v.z) * f, y: h / 2 - (v.y / v.z) * f };
  }

  const focal = (h) => h / 2 / Math.tan(VFOV);

  // The inverse of project() along the mast: which height on the vertical line
  // through `anchor` lands on screen row `sy`. The mast is a straight line in
  // view space, so this solves exactly rather than searching.
  function zAtScreenY(anchor, sy, b, h, f) {
    const v0 = toView({ x: anchor.x, y: anchor.y, z: 0 }, b);
    const v1 = toView({ x: anchor.x, y: anchor.y, z: 1 }, b);
    const dy = v1.y - v0.y;
    const dz = v1.z - v0.z;
    const k = (h / 2 - sy) / f;
    const den = dy - k * dz;
    if (Math.abs(den) < 1e-9) return null;
    return (k * v0.z - v0.y) / den;
  }

  // Clip a segment against the near plane so points behind the camera do not
  // fling across the screen.
  function clipNear(a, b) {
    if (a.z >= NEAR && b.z >= NEAR) return [a, b];
    if (a.z < NEAR && b.z < NEAR) return null;
    const t = (NEAR - a.z) / (b.z - a.z);
    const mid = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: NEAR };
    return a.z < NEAR ? [mid, b] : [a, mid];
  }

  function line(p, q, b, w, h, f) {
    const c = clipNear(toView(p, b), toView(q, b));
    if (!c) return;
    const s0 = project(c[0], w, h, f);
    const s1 = project(c[1], w, h, f);
    ctx.moveTo(s0.x, s0.y);
    ctx.lineTo(s1.x, s1.y);
  }


  function build() {
    if (!mission) { scene = null; return; }
    const f = mission.frame;
    const pts = mission.waypoints.map((w) => {
      const l = f.toLocal(w.lat, w.lon);
      return { x: l.x, y: l.y, z: w.alt, pass: w.pass, yaw: w.yaw ?? 0, shots: w.shots ?? [w.pitch] };
    });
    // The footprint you tapped, already in this frame's metres. A mission read
    // off the controller has none -- a KMZ records the flight, not what it was
    // for -- so there the flight's own extent stands in.
    const src = mission.hull?.length ? mission.hull : pts;
    const box = {
      x0: Math.min(...src.map((q) => q.x)), x1: Math.max(...src.map((q) => q.x)),
      y0: Math.min(...src.map((q) => q.y)), y1: Math.max(...src.map((q) => q.y)),
    };
    const span = Math.max(box.x1 - box.x0, box.y1 - box.y0, 20);
    const maxAlt = Math.max(...pts.map((p) => p.z), 1);
    // Keep the frustum wedges readable rather than to scale.
    const frustumLen = Math.max(2, Math.min(span * 0.09, maxAlt * 0.7));
    const step = Math.max(1, Math.ceil(pts.length / 70));

    // What actually flies at each height, so the scale can name it rather than
    // just marking a number.
    const NAME = { nadir: 'nadir', oblique: 'oblique', orbit: 'orbit', transect: 'cross', surround: 'surround' };
    const byHeight = new Map();
    for (const p of pts) {
      const key = Math.round(p.z * 10) / 10;
      if (!byHeight.has(key)) byHeight.set(key, { z: key, passes: new Set(), tilts: new Set(), n: 0 });
      const e = byHeight.get(key);
      e.passes.add(NAME[p.pass] ?? p.pass);
      for (const t of p.shots) e.tilts.add(Math.round(t));
      e.n++;
    }
    // Which planner knob owns each height, so a dragged level can be handed
    // back to it. A height nothing claims (a device route, say) still gets a
    // label, just no grip.
    const owners = mission.levels ?? [];
    const levels = [...byHeight.values()]
      .map((e) => ({
        z: e.z,
        n: e.n,
        label: `${e.z.toFixed(e.z < 10 ? 1 : 0)} m`,
        // Once several passes share a height the tilt list gets long enough to
        // run across the drawing, so name the passes and drop the angles.
        detail: e.passes.size > 2
          ? [...e.passes].join(' + ')
          : `${[...e.passes].join(' + ')} · ${[...e.tilts].sort((a, b) => b - a).join('/')}°`,
        handles: owners.filter((o) => Math.round(o.z * 10) / 10 === e.z),
      }))
      .sort((a, b) => a.z - b.z);

    // Flagged legs arrive as geography, like everything else that crosses a
    // module boundary here; the frame turns them into the metres this view draws.
    const legs = conflicts.map((c) => ({
      a: { ...f.toLocal(c.a.lat, c.a.lon), z: c.a.alt },
      b: { ...f.toLocal(c.b.lat, c.b.lon), z: c.b.alt },
      grade: c.grade,
    }));

    // How much ground to draw. The rectangle is not it: an orbit ring stands
    // well outside the box it circles, and a flight path hanging over the edge
    // of the world looks like a bug rather than like a wide orbit.
    const area = { x0: box.x0, x1: box.x1, y0: box.y0, y1: box.y1 };
    for (const p of pts) {
      if (p.x < area.x0) area.x0 = p.x;
      if (p.x > area.x1) area.x1 = p.x;
      if (p.y < area.y0) area.y0 = p.y;
      if (p.y > area.y1) area.y1 = p.y;
    }
    const margin = Math.max(area.x1 - area.x0, area.y1 - area.y0) * 0.12;
    area.x0 -= margin; area.x1 += margin;
    area.y0 -= margin; area.y1 += margin;

    scene = { pts, box, span, maxAlt, frustumLen, step, levels, legs, area };

    // Re-frame only when the ground box itself changed. Replanning -- which
    // happens on every slider tick and on every pixel of a level drag -- must
    // not yank the camera back to its default while you are working.
    const key = `${box.x0.toFixed(1)},${box.y0.toFixed(1)},${box.x1.toFixed(1)},${box.y1.toFixed(1)}`;
    if (key !== framedKey) {
      framedKey = key;
      view.target = { x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2, z: maxAlt / 2 };
      view.dist = span * 2.2 + maxAlt * 2;
    }
  }

  // The five faces of a box that can ever be seen from above the ground: four
  // walls and a roof. Each carries its outward normal, which is what decides
  // whether it is facing the camera at all.
  function boxFaces(bx) {
    const { min, max } = bx;
    const q = (pts, n) => ({ pts, n });
    return [
      q([{ x: min.x, y: min.y, z: max.z }, { x: max.x, y: min.y, z: max.z },
         { x: max.x, y: max.y, z: max.z }, { x: min.x, y: max.y, z: max.z }], { x: 0, y: 0, z: 1 }),
      q([{ x: min.x, y: min.y, z: 0 }, { x: max.x, y: min.y, z: 0 },
         { x: max.x, y: min.y, z: max.z }, { x: min.x, y: min.y, z: max.z }], { x: 0, y: -1, z: 0 }),
      q([{ x: min.x, y: max.y, z: 0 }, { x: max.x, y: max.y, z: 0 },
         { x: max.x, y: max.y, z: max.z }, { x: min.x, y: max.y, z: max.z }], { x: 0, y: 1, z: 0 }),
      q([{ x: min.x, y: min.y, z: 0 }, { x: min.x, y: max.y, z: 0 },
         { x: min.x, y: max.y, z: max.z }, { x: min.x, y: min.y, z: max.z }], { x: -1, y: 0, z: 0 }),
      q([{ x: max.x, y: min.y, z: 0 }, { x: max.x, y: max.y, z: 0 },
         { x: max.x, y: max.y, z: max.z }, { x: max.x, y: min.y, z: max.z }], { x: 1, y: 0, z: 0 }),
    ];
  }

  function drawObstacles(b, w, h, f) {
    hits = [];
    tags = [];
    if (!obstacles.length) return;
    const faces = [];
    for (const bx of obstacles) {
      const grade = bx.grade ?? 'clear';
      const centre = { x: (bx.min.x + bx.max.x) / 2, y: (bx.min.y + bx.max.y) / 2 };
      for (const face of boxFaces(bx)) {
        // Back-face cull against the eye, not against a fixed direction: this
        // is a perspective view, and a wall can face away at one end of a big
        // box and towards you at the other.
        const mid = face.pts.reduce((a, p) => add(a, p, 0.25), { x: 0, y: 0, z: 0 });
        if (dot(face.n, sub(mid, b.eye)) >= 0) continue;
        const vs = face.pts.map((p) => toView(p, b));
        if (vs.some((v) => v.z <= NEAR)) continue;   // straddling the eye plane
        const poly = vs.map((v) => project(v, w, h, f));
        const depth = toView(mid, b).z;
        const roof = face.n.z > 0;
        faces.push({ id: bx.id, grade, depth, s: poly, roof, on: Boolean(bx.selected) });
        // Every face is clickable, because "click the box" has to mean the box
        // and not one particular sliver of it -- a low box seen from a low
        // angle has almost no roof on screen. The roof carries the extra job of
        // being the height handle, which is why it is flagged.
        hits.push({ id: bx.id, poly, depth, roof, z: bx.max.z, centre });
      }
    }
    faces.sort((m, n) => n.depth - m.depth);
    hits.sort((m, n) => m.depth - n.depth);   // nearest first, for hit testing

    for (const face of faces) {
      ctx.beginPath();
      ctx.moveTo(face.s[0].x, face.s[0].y);
      for (let k = 1; k < face.s.length; k++) ctx.lineTo(face.s[k].x, face.s[k].y);
      ctx.closePath();
      const hot = hoverBox === face.id;
      const lit = hot || face.on;
      const col = lit ? HOVER_COLOR : OBSTACLE_COLOR[face.grade];
      // Translucent enough that the flight path behind a box still shows
      // through -- an obstacle you cannot see past is worse than no obstacle.
      // The roof of a live box is the exception: it is a handle, so it looks
      // like one.
      ctx.globalAlpha = lit && face.roof ? 0.4 : face.grade === 'clear' ? 0.16 : 0.24;
      ctx.fillStyle = col;
      ctx.fill();
      ctx.globalAlpha = lit ? 1 : face.grade === 'clear' ? 0.55 : 0.9;
      ctx.strokeStyle = col;
      ctx.lineWidth = face.on ? 2 : lit && face.roof ? 2 : 1;
      ctx.stroke();

      // A grip drawn across the roof of the live box, for the same reason the
      // altitude levels have one: it is how a thing that can be dragged says so.
      if (lit && face.roof) {
        const c = face.s.reduce((a, q) => ({ x: a.x + q.x / 4, y: a.y + q.y / 4 }), { x: 0, y: 0 });
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        for (let k = -1; k <= 1; k++) {
          ctx.moveTo(c.x - 7, c.y + k * 4);
          ctx.lineTo(c.x + 7, c.y + k * 4);
        }
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;

    // Which box this is and how tall, for the one you are working on. Collected
    // here and drawn at the very end, so the flight path cannot cover the
    // answer to the question you clicked the box to ask.
    for (const bx of obstacles) {
      if (!bx.selected && hoverBox !== bx.id) continue;
      const top = toView({ x: (bx.min.x + bx.max.x) / 2, y: (bx.min.y + bx.max.y) / 2, z: bx.max.z }, b);
      if (top.z <= NEAR) continue;
      const sp = project(top, w, h, f);
      const hM = bx.max.z;
      tags.push({
        x: sp.x, y: sp.y - 26,
        text: `${bx.name ? `${bx.name} · ` : ''}${Number.isInteger(hM) ? hM : hM.toFixed(1)} m`,
        on: Boolean(bx.selected),
      });
    }
  }

  function drawTags() {
    if (!tags.length) return;
    ctx.font = '12px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const t of tags) {
      const wid = ctx.measureText(t.text).width + 18;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(t.x - wid / 2, t.y - 11, wid, 22, 6);
      else ctx.rect(t.x - wid / 2, t.y - 11, wid, 22);
      ctx.fillStyle = 'rgba(11,14,17,0.92)';
      ctx.fill();
      ctx.strokeStyle = t.on ? HOVER_COLOR : 'rgba(139,152,165,0.4)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = '#f0f6fc';
      ctx.fillText(t.text, t.x, t.y);
    }
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  }

  // Canvas 2D can only do affine transforms, and a ground plane under a
  // perspective camera is a homography -- so no single transform maps a tile
  // onto its footprint. The fix is the one software renderers used before
  // hardware did it for them: cut the tile into cells and use a per-cell
  // affine, which converges on the right answer as the cells get smaller.
  //
  // The imagery is a PHOTOGRAPH, not a model of the ground. Anything with
  // height leans away from nadir, so a roof is painted metres from the walls
  // holding it up. That is why this is off unless asked for, and why the boxes
  // are the thing to judge clearance against.
  function drawGround(b, w, h, f, dpr) {
    if (!ground?.on || !tiles || !mission || !scene) return;
    const fr = mission.frame;
    const { area } = scene;
    const sw = fr.toLatLon(area.x0, area.y0);
    const ne = fr.toLatLon(area.x1, area.y1);
    // Never past what the service holds: beyond that it answers with a grey
    // placeholder tile rather than an error, which would paint "Map data not
    // yet available" across the ground and look like our bug.
    const z = pickZoom({ south: sw.lat, west: sw.lon, north: ne.lat, east: ne.lon },
                       { maxZoom: ground.maxZoom ?? 19 });
    const r = tileRange({ south: sw.lat, west: sw.lon, north: ne.lat, east: ne.lon }, z);

    for (let tx = r.x0; tx <= r.x1; tx++) {
      for (let ty = r.y0; ty <= r.y1; ty++) {
        const img = tiles.get(z, tx, ty);
        if (!img) continue;                       // still loading; it will redraw
        const tb = tileBounds(z, tx, ty);
        // A tile is axis-aligned in Mercator and the local frame is affine in
        // lat/lon, so its footprint is a rectangle in metres. Within one tile
        // the Mercator stretch is far under a centimetre, so interpolating
        // across it linearly is exact enough to ignore.
        const nw = fr.toLocal(tb.north, tb.west);
        const se = fr.toLocal(tb.south, tb.east);

        const corner = (u, v) => {
          const p = toView({ x: nw.x + (se.x - nw.x) * u, y: nw.y + (se.y - nw.y) * v, z: 0 }, b);
          return p.z <= NEAR ? null : project(p, w, h, f);
        };
        // How finely to cut it: by how much of the screen the tile covers, so a
        // tile in the distance costs almost nothing and one under your nose is
        // smooth. Halved mid-drag, where a frame matters more than a pixel.
        const outline = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([u, v]) => corner(u, v));
        if (outline.every((p) => !p)) continue;
        const seen = outline.filter(Boolean);
        const extent = Math.max(
          ...seen.map((p) => Math.max(...seen.map((q) => Math.hypot(p.x - q.x, p.y - q.y)))),
        );
        let n = Math.min(6, Math.max(1, Math.round(extent / 140)));
        if (drag) n = Math.max(1, n >> 1);

        for (let i = 0; i < n; i++) {
          for (let j = 0; j < n; j++) {
            const P = [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]]
              .map(([a, c]) => corner(a / n, c / n));
            if (P.some((p) => !p)) continue;      // straddles the eye plane
            const su = TILE_PX / n;
            const U = [[i * su, j * su], [(i + 1) * su, j * su],
                       [(i + 1) * su, (j + 1) * su], [i * su, (j + 1) * su]];
            for (const [m, q, o] of [[0, 1, 2], [0, 2, 3]]) {
              paintTriangle(img, [P[m], P[q], P[o]], [U[m], U[q], U[o]], dpr);
            }
          }
        }
      }
    }
  }

  // One triangle of a tile: solve the affine that carries its three source
  // pixels onto its three screen points, clip to it, and let drawImage do the
  // rest. The clip is nudged outwards about the centroid because two triangles
  // sharing an edge each round it their own way, and the half-pixel nobody
  // claims shows up as a grid of hairlines across the ground.
  const SEAM = 0.4;
  function paintTriangle(img, P, U, dpr) {
    const [[u0, v0], [u1, v1], [u2, v2]] = U;
    const den = (u1 - u0) * (v2 - v0) - (u2 - u0) * (v1 - v0);
    if (!den) return;
    const a = ((P[1].x - P[0].x) * (v2 - v0) - (P[2].x - P[0].x) * (v1 - v0)) / den;
    const bb = ((P[1].y - P[0].y) * (v2 - v0) - (P[2].y - P[0].y) * (v1 - v0)) / den;
    const c = ((P[2].x - P[0].x) * (u1 - u0) - (P[1].x - P[0].x) * (u2 - u0)) / den;
    const d = ((P[2].y - P[0].y) * (u1 - u0) - (P[1].y - P[0].y) * (u2 - u0)) / den;

    const cx = (P[0].x + P[1].x + P[2].x) / 3;
    const cy = (P[0].y + P[1].y + P[2].y) / 3;
    ctx.save();
    ctx.beginPath();
    for (let k = 0; k < 3; k++) {
      const dx = P[k].x - cx;
      const dy = P[k].y - cy;
      const len = Math.hypot(dx, dy) || 1;
      const x = P[k].x + (dx / len) * SEAM;
      const y = P[k].y + (dy / len) * SEAM;
      if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.clip();
    ctx.setTransform(dpr * a, dpr * bb, dpr * c, dpr * d,
                     dpr * (P[0].x - a * u0 - c * v0), dpr * (P[0].y - bb * u0 - d * v0));
    ctx.drawImage(img, 0, 0);
    ctx.restore();
  }

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#0b0e11';
    ctx.fillRect(0, 0, w, h);
    if (!scene) return;

    const b = basis();
    const f = focal(h);
    const { box, span, pts, frustumLen, step } = scene;

    drawGround(b, w, h, f, dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // ground grid -- fainter over imagery, where it is a scale reference rather
    // than the only thing telling you where the ground is
    const grid = span > 300 ? 50 : span > 120 ? 20 : span > 40 ? 10 : 5;
    const gx0 = Math.floor(scene.area.x0 / grid) * grid;
    const gx1 = Math.ceil(scene.area.x1 / grid) * grid;
    const gy0 = Math.floor(scene.area.y0 / grid) * grid;
    const gy1 = Math.ceil(scene.area.y1 / grid) * grid;
    ctx.strokeStyle = ground?.on && tiles ? 'rgba(255,255,255,0.13)' : '#1b222b';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = gx0; x <= gx1; x += grid) line({ x, y: gy0, z: 0 }, { x, y: gy1, z: 0 }, b, w, h, f);
    for (let y = gy0; y <= gy1; y += grid) line({ x: gx0, y, z: 0 }, { x: gx1, y, z: 0 }, b, w, h, f);
    ctx.stroke();


    // What is already standing there. Faces rather than wireframe, because a
    // wireframe box does not tell you which side of it the path is on -- and
    // the whole reason these are here is to be looked at against the path.
    // Painter's algorithm over the visible faces of every box at once: there is
    // no depth buffer, so far faces have to be laid down before near ones.
    drawObstacles(b, w, h, f);

    // flight path, one stroke per pass so colours stay separate
    let i = 0;
    while (i < pts.length) {
      const pass = pts[i].pass;
      ctx.strokeStyle = PASS_COLOR[pass];
      ctx.globalAlpha = 0.85;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      let j = i;
      while (j + 1 < pts.length && pts[j + 1].pass === pass) {
        line(pts[j], pts[j + 1], b, w, h, f);
        j++;
      }
      ctx.stroke();
      i = j + 1;
    }
    ctx.globalAlpha = 1;

    // The legs that come too close, restruck over the path in the colour of the
    // news. Thicker than the path so they read at a glance from any angle.
    for (const grade of ['near', 'strike']) {
      const set = scene.legs.filter((l) => l.grade === grade);
      if (!set.length) continue;
      ctx.strokeStyle = CONFLICT_COLOR[grade];
      ctx.lineWidth = grade === 'strike' ? 3.5 : 2.5;
      ctx.beginPath();
      for (const l of set) line(l.a, l.b, b, w, h, f);
      ctx.stroke();
    }
    ctx.lineWidth = 1;

    // camera frustums, far ones first so near ones sit on top
    const wedges = [];
    for (let k = 0; k < pts.length; k += step) {
      const p = pts[k];
      for (const pitch of p.shots) {
        const o = orientation(p.yaw, pitch);
        wedges.push({ p, o, depth: toView(p, b).z, pass: p.pass });
      }
    }
    wedges.sort((m, n) => n.depth - m.depth);

    const fv = fov(mission.cam);
    const th = Math.tan(fv.h / 2);
    const tv = Math.tan(fv.v / 2);
    for (const wd of wedges) {
      const corners = [[1, 1], [1, -1], [-1, -1], [-1, 1]].map(([sx, sy]) => {
        let d = add(wd.o.forward, wd.o.right, sx * th);
        d = add(d, wd.o.up, sy * tv);
        return add(wd.p, norm(d), frustumLen);
      });
      ctx.strokeStyle = PASS_COLOR[wd.pass];
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const cr of corners) line(wd.p, cr, b, w, h, f);
      for (let k = 0; k < 4; k++) line(corners[k], corners[(k + 1) % 4], b, w, h, f);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // coverage: the proxy structures, then a dot per surface sample coloured
    // by how well it is seen. Drawn before the start marker so the marker wins.
    if (showCoverage && coverage) {
      ctx.strokeStyle = 'rgba(140,152,166,0.5)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const bx of coverage.boxes) {
        const c = [
          { x: bx.min.x, y: bx.min.y }, { x: bx.max.x, y: bx.min.y },
          { x: bx.max.x, y: bx.max.y }, { x: bx.min.x, y: bx.max.y },
        ];
        for (let k = 0; k < 4; k++) {
          const a1 = { ...c[k], z: 0 };
          const a2 = { ...c[(k + 1) % 4], z: 0 };
          const b1 = { ...c[k], z: bx.max.z };
          const b2 = { ...c[(k + 1) % 4], z: bx.max.z };
          line(a1, a2, b, w, h, f);
          line(b1, b2, b, w, h, f);
          line(a1, b1, b, w, h, f);
        }
      }
      ctx.stroke();

      const dots = [];
      for (const sm of coverage.samples) {
        const v = toView(sm.p, b);
        if (v.z <= NEAR) continue;
        dots.push({ s: project(v, w, h, f), d: v.z, g: sm.grade });
      }
      dots.sort((m, n) => n.d - m.d);
      for (const dt of dots) {
        ctx.fillStyle = GRADE_COLOR[dt.g];
        ctx.globalAlpha = dt.g === 'good' ? 0.5 : 0.95;
        ctx.beginPath();
        ctx.arc(dt.s.x, dt.s.y, dt.g === 'good' ? 1.8 : 2.8, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    // Altitude scale: a mast standing at whichever box corner currently
    // projects furthest left, ticked at every height the mission actually
    // flies. The readable part -- the labels -- is pinned to the left margin
    // instead of hanging off the mast, so orbiting slides the leader lines and
    // leaves the text where you last read it.
    scale = null;
    if (scene.levels.length) {
      const pad = span * 0.22;
      const corners = [
        { x: box.x0 - pad, y: box.y0 - pad }, { x: box.x1 + pad, y: box.y0 - pad },
        { x: box.x1 + pad, y: box.y1 + pad }, { x: box.x0 - pad, y: box.y1 + pad },
      ].map((c) => {
        const v = toView({ ...c, z: 0 }, b);
        return v.z <= NEAR ? null : { ...c, sx: project(v, w, h, f).x };
      });

      // Hysteresis: the leftmost corner changes twice per quarter turn, and a
      // scale that hops corners every few degrees of orbit is unreadable. Hold
      // the current one until another is clearly, not marginally, better.
      let bestIdx = -1;
      for (let k = 0; k < corners.length; k++) {
        if (corners[k] && (bestIdx < 0 || corners[k].sx < corners[bestIdx].sx)) bestIdx = k;
      }
      if (bestIdx >= 0 && (anchorIdx < 0 || !corners[anchorIdx]
                           || corners[bestIdx].sx < corners[anchorIdx].sx - w * 0.08)) {
        anchorIdx = bestIdx;
      }
      const anchor = corners[anchorIdx];

      if (anchor) {
        ctx.strokeStyle = 'rgba(139,152,165,0.5)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        line({ ...anchor, z: 0 }, { ...anchor, z: scene.maxAlt }, b, w, h, f);
        ctx.stroke();

        ctx.font = '12px -apple-system, sans-serif';
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        const tick = span * 0.05;
        const ticks = [];
        for (const lv of scene.levels) {
          const v = toView({ ...anchor, z: lv.z }, b);
          if (v.z <= NEAR) continue;
          const sp = project(v, w, h, f);
          const lw = ctx.measureText(lv.label).width;
          const dw = ctx.measureText(lv.detail).width;
          const grip = lv.handles.length ? 14 : 0;
          ticks.push({ z: lv.z, lv, sp, lw, grip, ly: sp.y, bw: 10 + grip + lw + 8 + dw + 10 });
        }
        // Levels a few metres apart project a few pixels apart. Dropping the
        // ones that collide would also drop their grips, so the labels are
        // pushed apart into a legible stack instead and the leader line takes
        // the strain -- it still points at the height the level really is.
        ticks.sort((m, n) => m.sp.y - n.sp.y);
        const ROW = 25;
        for (let k = 1; k < ticks.length; k++) {
          ticks[k].ly = Math.max(ticks[k].ly, ticks[k - 1].ly + ROW);
        }
        for (let k = ticks.length - 2; k >= 0; k--) {
          // Then squeeze back up if the stack ran off the bottom of the canvas.
          ticks[k].ly = Math.min(ticks[k].ly, Math.min(ticks[k + 1].ly - ROW, h - 46 - ROW * (ticks.length - 2 - k)));
        }
        for (const t of ticks) {
          t.ly = Math.max(t.ly, 14);
          t.box = { x: 12, y: t.ly - 11, w: t.bw, h: 22 };
        }

        // Leaders first, so the panels sit on top of their own lines.
        ctx.strokeStyle = 'rgba(139,152,165,0.35)';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        for (const t of ticks) {
          const from = t.box.x + t.box.w + 6;
          if (t.sp.x > from) { ctx.moveTo(from, t.ly); ctx.lineTo(t.sp.x - 3, t.sp.y); }
        }
        ctx.stroke();
        ctx.setLineDash([]);

        // Ticks on the mast, angled into the scene so the height reads as a
        // plane through the site rather than a mark on a stick.
        ctx.strokeStyle = 'rgba(200,212,224,0.8)';
        ctx.beginPath();
        for (const t of ticks) {
          const vEnd = toView({ x: anchor.x + tick, y: anchor.y + tick, z: t.z }, b);
          if (vEnd.z <= NEAR) continue;
          const spEnd = project(vEnd, w, h, f);
          ctx.moveTo(t.sp.x, t.sp.y);
          ctx.lineTo(spEnd.x, spEnd.y);
        }
        ctx.stroke();

        for (const t of ticks) {
          const hot = hoverZ !== null && Math.abs(hoverZ - t.z) < 0.05;
          const r = t.box;
          ctx.beginPath();
          if (ctx.roundRect) ctx.roundRect(r.x, r.y, r.w, r.h, 5);
          else ctx.rect(r.x, r.y, r.w, r.h);
          ctx.fillStyle = hot ? 'rgba(24,32,41,0.96)' : 'rgba(11,14,17,0.9)';
          ctx.fill();
          ctx.strokeStyle = hot ? 'rgba(77,163,255,0.9)' : 'rgba(139,152,165,0.28)';
          ctx.lineWidth = 1;
          ctx.stroke();

          let x = r.x + 10;
          if (t.grip) {
            // Three stacked bars: the same grip every draggable row in every
            // app uses, which is the whole point of drawing it.
            ctx.strokeStyle = hot ? '#4da3ff' : 'rgba(139,152,165,0.75)';
            ctx.beginPath();
            for (let k = -1; k <= 1; k++) {
              ctx.moveTo(x, t.ly + k * 4);
              ctx.lineTo(x + 8, t.ly + k * 4);
            }
            ctx.stroke();
            x += t.grip;
          }
          ctx.fillStyle = '#f0f6fc';
          ctx.fillText(t.lv.label, x, t.ly);
          ctx.fillStyle = hot ? '#c9d5e1' : '#9dabb9';
          ctx.fillText(t.lv.detail, x + t.lw + 8, t.ly);
        }

        scale = { anchor, ticks };
        ctx.textBaseline = 'alphabetic';
      }
    }

    drawTags();

    // start marker
    const v0 = toView(pts[0], b);
    if (v0.z > NEAR) {
      const s = project(v0, w, h, f);
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(s.x, s.y, 4, 0, Math.PI * 2);
      ctx.fill();
    }

    // Over a dark grid, grey text on the background reads fine. Over a sunlit
    // roof it does not, so the imagery gets a scrim to sit the readouts on.
    if (ground?.on && tiles) {
      const g = ctx.createLinearGradient(0, h - 52, 0, h);
      g.addColorStop(0, 'rgba(11,14,17,0)');
      g.addColorStop(1, 'rgba(11,14,17,0.82)');
      ctx.fillStyle = g;
      ctx.fillRect(0, h - 52, w, 52);
    }

    // Scale + altitude readout. A split pane can be half the width of the full
    // view, so the hint sheds its tail rather than running off the edge.
    // Imagery is licensed, and the 3D view has no Leaflet attribution control to
    // carry that for it. Drawn with the rest of the readouts, on the scrim.
    if (ground?.on && tiles && ground.attribution) {
      ctx.fillStyle = 'rgba(160,172,185,0.9)';
      ctx.font = '11px -apple-system, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(ground.attribution, w - 10, h - 10);
      ctx.textAlign = 'left';
    }

    ctx.fillStyle = '#8b98a5';
    ctx.font = '11px -apple-system, sans-serif';
    const facts = `grid ${grid} m · top ${scene.maxAlt.toFixed(0)} m AGL`;
    for (const hint of [
      obstacles.length
        ? `${facts} · click a box to edit it, drag its top to set the height` : '',
      onLevelChange ? `${facts} · drag to orbit, scroll to zoom, drag a level to move it` : '',
      `${facts} · drag to orbit, scroll to zoom`,
      facts,
    ]) {
      if (!hint) continue;
      if (ctx.measureText(hint).width <= w - 20 || hint === facts) { ctx.fillText(hint, 10, h - 10); break; }
    }
    if (showCoverage && coverage) {
      let lx = 10;
      const full = [['good', 'good'], ['flat', 'no parallax'], ['thin', '<3 views'], ['unseen', 'unseen']];
      const short = [['good', 'good'], ['flat', 'flat'], ['thin', 'thin'], ['unseen', 'unseen']];
      const width = (rows) => rows.reduce((n, [, l]) => n + 16 + ctx.measureText(l).width, 10);
      const legend = width(full) <= w - 10 ? full : short;
      for (const [g, label] of legend) {
        ctx.fillStyle = GRADE_COLOR[g];
        ctx.beginPath();
        ctx.arc(lx + 4, h - 28, 3.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#8b98a5';
        ctx.fillText(label, lx + 12, h - 25);
        lx += 16 + ctx.measureText(label).width;
      }
    }
  }

  // interaction
  let drag = null;

  const local = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  // Which level panel, if any, is under the pointer. Generous by a few pixels
  // because these are small targets on a touchscreen.
  function levelAt(x, y) {
    if (!scale || !onLevelChange) return null;
    for (const t of scale.ticks) {
      if (!t.lv.handles.length) continue;
      const r = t.box;
      if (x >= r.x - 4 && x <= r.x + r.w + 6 && y >= r.y - 3 && y <= r.y + r.h + 3) return t;
    }
    return null;
  }

  // Which obstacle face, if any, the pointer is over. Faces are convex quads,
  // so the usual crossing test is enough, and they are already sorted near
  // first -- the one you can see is the one you meant.
  function faceAt(x, y) {
    if (!onBoxSelect && !onBoxHeight) return null;
    for (const r of hits) {
      let inside = false;
      for (let i = 0, j = r.poly.length - 1; i < r.poly.length; j = i++) {
        const a = r.poly[i];
        const c = r.poly[j];
        if ((a.y > y) !== (c.y > y) && x < ((c.x - a.x) * (y - a.y)) / (c.y - a.y) + a.x) inside = !inside;
      }
      if (inside) return r;
    }
    return null;
  }

  // Height under the pointer, read off the mast the scale is currently drawn on.
  function dragZ(pt) {
    if (!scale) return null;
    const h = canvas.clientHeight;
    return zAtScreenY(scale.anchor, pt.y, basis(), h, focal(h));
  }

  canvas.addEventListener('pointerdown', (e) => {
    const pt = local(e);
    const t = levelAt(pt.x, pt.y);
    const face = t ? null : faceAt(pt.x, pt.y);
    if (face) {
      // One gesture, decided on release: let go without moving and you have
      // clicked the box; move first and you were dragging. Same rule the map
      // uses for the same boxes, so the two views do not need explaining
      // separately.
      hoverBox = face.id;
      drag = { box: face.id, x: e.clientX, y: e.clientY, moved: false };
      if (face.roof && onBoxHeight) {
        // Grab offset, so the roof does not jump to the pointer on the first
        // pixel of the drag.
        const h = canvas.clientHeight;
        const z = zAtScreenY(face.centre, pt.y, basis(), h, focal(h));
        drag.roof = face;
        drag.grab = z === null ? 0 : z - face.z;
      }
      canvas.setPointerCapture(e.pointerId);
      draw();
      return;
    }
    if (t) {
      // Grab offset, so the level does not jump to the pointer on the first
      // pixel of the drag.
      const z = dragZ(pt);
      drag = { handles: t.lv.handles, grab: z === null ? 0 : z - t.z };
      hoverZ = t.z;
    } else {
      drag = { x: e.clientX, y: e.clientY };
    }
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) {
      const pt = local(e);
      const t = levelAt(pt.x, pt.y);
      const face = t ? null : faceAt(pt.x, pt.y);
      // The roof says "drag me up and down"; any other face says "click me".
      canvas.style.cursor = t || face?.roof ? 'ns-resize' : face ? 'pointer' : '';
      const z = t ? t.z : null;
      const id = face ? face.id : null;
      if (z !== hoverZ || id !== hoverBox) { hoverZ = z; hoverBox = id; draw(); }
      return;
    }
    if (drag.box) {
      // A few pixels of slop, so a click with a shaky hand is still a click.
      if (Math.abs(e.clientX - drag.x) > 3 || Math.abs(e.clientY - drag.y) > 3) drag.moved = true;
      if (!drag.moved) return;
      if (drag.roof) {
        const h = canvas.clientHeight;
        const z = zAtScreenY(drag.roof.centre, local(e).y, basis(), h, focal(h));
        if (z === null) return;
        onBoxHeight(drag.box, z - drag.grab, { done: false });   // the app redraws
        return;
      }
      // A side face has no drag of its own, so the gesture falls through to
      // what a drag on empty space does: orbit.
      view.az -= (e.clientX - drag.x) * 0.4;
      view.el = Math.max(-5, Math.min(89, view.el + (e.clientY - drag.y) * 0.3));
      drag.x = e.clientX;
      drag.y = e.clientY;
      draw();
      return;
    }
    if (drag.handles) {
      const z = dragZ(local(e));
      if (z === null) return;
      const target = Math.round(Math.max(1, Math.min(500, z - drag.grab)) * 10) / 10;
      hoverZ = target;
      onLevelChange(drag.handles, target);   // the app replans, which redraws
      return;
    }
    view.az -= (e.clientX - drag.x) * 0.4;
    view.el = Math.max(-5, Math.min(89, view.el + (e.clientY - drag.y) * 0.3));
    drag = { x: e.clientX, y: e.clientY };
    draw();
  });
  // A height dragged in the air is a draft until the mouse comes up; that is
  // when it becomes an edit worth storing and sending. A box let go of without
  // being dragged was never an edit at all -- it was a click.
  const stop = () => {
    if (drag?.box) {
      if (!drag.moved) onBoxSelect?.(drag.box);
      else if (drag.roof) {
        const cur = obstacles.find((o) => o.id === drag.box);
        onBoxHeight(drag.box, cur ? cur.max.z : drag.roof.z, { done: true });
      }
    }
    drag = null;
  };
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', stop);
  canvas.addEventListener('pointerleave', () => {
    if (drag || (hoverZ === null && hoverBox === null)) return;
    hoverZ = null;
    hoverBox = null;
    draw();
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    view.dist = Math.max(5, Math.min(6000, view.dist * (e.deltaY > 0 ? 1.12 : 0.89)));
    draw();
  }, { passive: false });

  return {
    setMission(m, cov) { mission = m; coverage = cov ?? null; build(); draw(); },
    // Boxes in the mission's own local metres, each optionally graded by the
    // collision check, plus the legs that earned the grade.
    // `spec` is { on, url(z,x,y), attribution }. Changing the basemap swaps the
    // cache rather than mixing two services' tiles in one texture.
    setGround(spec) {
      const changed = spec?.url !== ground?.url;
      ground = spec ?? null;
      if (changed) tiles = null;
      if (ground?.on && !tiles) {
        tiles = createTileCache({
          url: ground.url,
          // A tile that arrives after the frame that wanted it is invisible
          // until something else forces a redraw. Coalesced with a timer rather
          // than requestAnimationFrame, which does not run in a hidden tab --
          // and tiles land in bursts, so one redraw per burst is the point.
          onLoad: () => {
            clearTimeout(redrawTimer);
            redrawTimer = setTimeout(draw, 30);
          },
        });
      }
      draw();
    },

    setObstacles(boxes, legs) {
      obstacles = boxes ?? [];
      conflicts = legs ?? [];
      build();
      draw();
    },
    // Called with the planner handles owning the dragged level and its new
    // height; setting it is what makes the levels draggable at all.
    onLevelChange(fn) { onLevelChange = fn; },
    // Called with an obstacle id and the height its roof was dragged to;
    // setting it is what makes the boxes resizable at all. `done` marks the
    // end of the gesture, which is the only part worth storing.
    onBoxHeight(fn) { onBoxHeight = fn; },
    // Called with the id of a box that was clicked rather than dragged.
    onBoxSelect(fn) { onBoxSelect = fn; },
    setCoverage(c) { coverage = c; draw(); },
    toggleCoverage(on) { showCoverage = on; draw(); },
    draw,
    reset() { framedKey = null; build(); draw(); },
    get view() { return view; },
  };
}
