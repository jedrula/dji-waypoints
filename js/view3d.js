import { fov, orientation } from './camera.js';
import { GRADE_COLOR } from './coverage.js';

// A small hand-rolled 3D view. The scene is a few thousand line segments, so a
// WebGL library would be more dependency than drawing. Coordinates are local
// ENU metres: x east, y north, z up.

const PASS_COLOR = { nadir: '#4da3ff', oblique: '#ffb84d', orbit: '#5ad19a', transect: '#c98bff' };
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
  const view = { az: 35, el: 28, dist: 400, target: { x: 0, y: 0, z: 0 } };
  const NEAR = 0.5;
  const VFOV = 28 * DEG;

  let onLevelChange = null;   // set by the app; enables dragging the levels
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
    const a = f.toLocal(mission.rect.south, mission.rect.west);
    const b = f.toLocal(mission.rect.north, mission.rect.east);
    const box = {
      x0: Math.min(a.x, b.x), x1: Math.max(a.x, b.x),
      y0: Math.min(a.y, b.y), y1: Math.max(a.y, b.y),
    };
    const span = Math.max(box.x1 - box.x0, box.y1 - box.y0, 20);
    const maxAlt = Math.max(...pts.map((p) => p.z), 1);
    // Keep the frustum wedges readable rather than to scale.
    const frustumLen = Math.max(2, Math.min(span * 0.09, maxAlt * 0.7));
    const step = Math.max(1, Math.ceil(pts.length / 70));

    // What actually flies at each height, so the scale can name it rather than
    // just marking a number.
    const NAME = { nadir: 'nadir', oblique: 'oblique', orbit: 'orbit', transect: 'cross' };
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

    scene = { pts, box, span, maxAlt, frustumLen, step, levels };

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

    // ground grid
    const grid = span > 300 ? 50 : span > 120 ? 20 : span > 40 ? 10 : 5;
    const gx0 = Math.floor((box.x0 - span * 0.3) / grid) * grid;
    const gx1 = Math.ceil((box.x1 + span * 0.3) / grid) * grid;
    const gy0 = Math.floor((box.y0 - span * 0.3) / grid) * grid;
    const gy1 = Math.ceil((box.y1 + span * 0.3) / grid) * grid;
    ctx.strokeStyle = '#1b222b';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = gx0; x <= gx1; x += grid) line({ x, y: gy0, z: 0 }, { x, y: gy1, z: 0 }, b, w, h, f);
    for (let y = gy0; y <= gy1; y += grid) line({ x: gx0, y, z: 0 }, { x: gx1, y, z: 0 }, b, w, h, f);
    ctx.stroke();

    // the drawn rectangle, on the ground
    ctx.strokeStyle = '#4da3ff';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    const c = [
      { x: box.x0, y: box.y0, z: 0 }, { x: box.x1, y: box.y0, z: 0 },
      { x: box.x1, y: box.y1, z: 0 }, { x: box.x0, y: box.y1, z: 0 },
    ];
    for (let i = 0; i < 4; i++) line(c[i], c[(i + 1) % 4], b, w, h, f);
    ctx.stroke();
    ctx.setLineDash([]);

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

    // start marker
    const v0 = toView(pts[0], b);
    if (v0.z > NEAR) {
      const s = project(v0, w, h, f);
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(s.x, s.y, 4, 0, Math.PI * 2);
      ctx.fill();
    }

    // scale + altitude readout
    ctx.fillStyle = '#8b98a5';
    ctx.font = '11px -apple-system, sans-serif';
    ctx.fillText(`grid ${grid} m · top ${scene.maxAlt.toFixed(0)} m AGL · drag to orbit, scroll to zoom${onLevelChange ? ', drag a level to move it' : ''}`, 10, h - 10);
    if (showCoverage && coverage) {
      let lx = 10;
      const legend = [['good', 'good'], ['flat', 'no parallax'], ['thin', '<3 views'], ['unseen', 'unseen']];
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

  // Height under the pointer, read off the mast the scale is currently drawn on.
  function dragZ(pt) {
    if (!scale) return null;
    const h = canvas.clientHeight;
    return zAtScreenY(scale.anchor, pt.y, basis(), h, focal(h));
  }

  canvas.addEventListener('pointerdown', (e) => {
    const pt = local(e);
    const t = levelAt(pt.x, pt.y);
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
      canvas.style.cursor = t ? 'ns-resize' : '';
      const z = t ? t.z : null;
      if (z !== hoverZ) { hoverZ = z; draw(); }
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
  const stop = () => { drag = null; };
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', stop);
  canvas.addEventListener('pointerleave', () => {
    if (drag || hoverZ === null) return;
    hoverZ = null;
    draw();
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    view.dist = Math.max(5, Math.min(6000, view.dist * (e.deltaY > 0 ? 1.12 : 0.89)));
    draw();
  }, { passive: false });

  return {
    setMission(m, cov) { mission = m; coverage = cov ?? null; build(); draw(); },
    // Called with the planner handles owning the dragged level and its new
    // height; setting it is what makes the levels draggable at all.
    onLevelChange(fn) { onLevelChange = fn; },
    setCoverage(c) { coverage = c; draw(); },
    toggleCoverage(on) { showCoverage = on; draw(); },
    draw,
    reset() { framedKey = null; build(); draw(); },
    get view() { return view; },
  };
}
