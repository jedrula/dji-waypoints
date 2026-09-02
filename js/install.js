// The controller view: push the planned KMZ straight into DJI Fly's mission folder on
// a connected controller, without the copy-rename-overwrite dance in a file
// manager. Deliberately not one-click -- installing overwrites a mission that is
// already on the controller, so the panel shows what is going where, and what
// is about to be lost, before the button does anything.
//
// The API behind it lives in tools/serve.mjs and only exists when the page is
// served by `npm start`. On GitHub Pages the probe 404s, the automatic half of
// the view hides itself, and what is left is the by-hand recipe.

import { readKmz } from './kmzread.js';

const $ = (id) => document.getElementById(id);

const state = {
  transports: [],
  transport: null,
  slots: [],
  selected: null,
  planId: null,    // the saved plan being installed
  viewing: null,   // key of the row currently drawn on the map, if any
  viewBusy: null,  // key of the row whose route is being fetched or planned
  busy: false,
  file: null,      // a KMZ picked from disk, which wins over the saved plan
};

// Where each plan was last installed, so that saving an edited plan can go
// straight back to the same mission instead of asking you to find it again.
//
// Deliberately not on the plan record, which syncs: a mission UUID is a fact
// about the controller plugged into THIS machine, and shipping it to the phone
// would only offer to overwrite a slot the phone has never seen. Local, keyed
// by plan id, and it costs nothing when it turns out to be stale -- the slot
// simply is not on the controller any more, and Save says so.
const SLOT_KEY = 'dji.planSlots';

function slotMemory() {
  try {
    const raw = JSON.parse(localStorage.getItem(SLOT_KEY) ?? '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function rememberSlot(planId, transport, slot) {
  if (!planId) return;
  const all = slotMemory();
  all[planId] = { transport, slot };
  try { localStorage.setItem(SLOT_KEY, JSON.stringify(all)); } catch { /* full or private */ }
}

let savedPlans = () => [];
let partsForPlan = () => null;
let planRoute = () => null;
let showRoute = () => {};
let badge = () => {};
let hasApi = false;

function shortId(id) {
  return id.length > 17 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

function when(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(+d)) return '—';
  return d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('json')) throw new Error(`${res.status} ${res.statusText}`);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `${res.status}`);
  return body;
}

/* ---------- rendering ---------- */

function setStatus(text, kind = '') {
  const el = $('instStatus');
  el.textContent = text;
  el.className = `hint ${kind}`;
}

function renderAll() {
  renderPlans();
  renderSlots();
  renderTransfer();
}

// Putting a route on the map is the same act whether it came off the controller
// or out of a saved plan, so it is one button: View, … while it loads, Hide
// while it is up, and only ever one route at a time.
function viewButton(key, load) {
  const b = document.createElement('button');
  const showing = state.viewing === key;
  const busy = state.viewBusy === key;
  b.type = 'button';
  b.className = `slotview${showing ? ' on' : ''}`;
  b.title = 'Show this on the map and in 3D';
  b.textContent = busy ? '…' : (showing ? 'Hide' : 'View');
  b.disabled = Boolean(state.viewBusy);
  b.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (showing) {          // second click puts your own plan back
      state.viewing = null;
      showRoute(null);
      setStatus('Back to your plan.');
      renderAll();
      return;
    }
    state.viewBusy = key;
    renderAll();
    // Let the "…" paint before work that can block for a second on a big plan.
    await new Promise((r) => setTimeout(r, 0));
    try {
      setStatus(await load(), 'ok');
      state.viewing = key;
    } catch (err) {
      setStatus(err.message, 'bad');
    }
    state.viewBusy = null;
    renderAll();
  });
  return b;
}

// Both lists here are the same thing -- pick one of these, and look at it before
// you commit -- so they are built once and cannot drift apart.
function pickRow({ key, group, title, sub, meta, selected, disabled, onPick, view }) {
  const row = document.createElement('label');
  row.className = `slot${selected ? ' on' : ''}${disabled ? ' unusable' : ''}`;

  const radio = document.createElement('input');
  radio.type = 'radio';
  radio.name = group;
  radio.checked = selected;
  radio.disabled = disabled;
  radio.addEventListener('change', onPick);
  row.append(radio);

  const main = document.createElement('span');
  main.className = 'slotmain';
  main.innerHTML = '<b></b><em></em>';
  main.querySelector('b').textContent = title;
  main.querySelector('em').textContent = sub;
  row.append(main);

  if (meta) {
    const el = document.createElement('span');
    el.className = `slotmeta${meta.bad ? ' bad' : ''}`;
    el.textContent = meta.text;
    row.append(el);
  }
  if (view) row.append(viewButton(key, view));
  return row;
}

// What gets installed is a saved plan, the same thing Saved plans exports as a
// file. Not "whatever is on the map": a flight worth putting on the aircraft is
// a flight worth being able to find again, and one that cannot be picked by
// accident from another view.
function renderPlans() {
  const box = $('instPlans');
  const plans = savedPlans();
  box.innerHTML = '';
  if (!plans.length) {
    box.innerHTML = '<p class="hint">No saved plans yet. Draw one in New plan and save it, '
      + 'or pick a KMZ file below.</p>';
    return;
  }
  if (!plans.some((p) => p.id === state.planId)) state.planId = null;
  for (const p of plans) {
    box.append(pickRow({
      key: `plan:${p.id}`,
      group: 'instPlanPick',
      title: p.name,
      sub: when(p.updatedAt),
      selected: state.planId === p.id,
      disabled: Boolean(state.file),   // a file from disk wins
      onPick: () => { state.planId = p.id; renderAll(); },
      view: () => {
        const route = planRoute(p);
        if (!route) throw new Error(`“${p.name}” will not decode — it may be from an older format.`);
        showRoute({ kind: 'plan', mission: route });
        return `${p.name}: ${route.stats.waypoints} waypoints, ${route.params.altitude} m, `
          + `${route.passes.length} passes — on the map, and in the 3D view`;
      },
    }));
  }
}

function renderSlots() {
  const box = $('instSlots');
  box.innerHTML = '';
  if (!state.transport) {
    box.innerHTML = '<p class="hint">Nothing connected yet.</p>';
    return;
  }
  if (!state.slots.length) {
    box.innerHTML = '<p class="hint">No mission folders on this controller. Create a throwaway '
      + 'waypoint mission in DJI Fly — that is what makes a folder we can write into.</p>';
    return;
  }
  const usable = state.slots.filter((s) => s.exists);
  for (const s of state.slots) {
    const meta = { text: s.exists ? `${s.waypoints ?? '?'} wp` : 'empty', bad: false };
    if (s.exists && s.valid === false) { meta.text += ' · invalid'; meta.bad = true; }
    box.append(pickRow({
      key: `slot:${s.id}`,
      group: 'instSlotPick',
      title: shortId(s.id),
      sub: when(s.mtime),
      meta,
      selected: state.selected === s.id,
      disabled: !s.exists,
      onPick: () => { state.selected = s.id; renderAll(); },
      // Looking before overwriting: draw what is in this slot on the map, so
      // "replaces 134 wp" is a route you can see rather than a number.
      view: s.exists ? async () => {
        const res = await fetch(`/api/slot?transport=${encodeURIComponent(state.transport)}&slot=${encodeURIComponent(s.id)}`);
        if (!res.ok) throw new Error(`could not read that slot (${res.status})`);
        const read = await readKmz(new Uint8Array(await res.arrayBuffer()));
        showRoute({ kind: 'device', read });
        // A distance-interval mission has one takePhoto for the whole route,
        // so "1 photo" there means a trigger, not a single frame.
        const shots = read.meta.photos === 1 && read.meta.waypoints > 2
          ? '1 photo action (interval trigger)'
          : `${read.meta.photos} photo${read.meta.photos === 1 ? '' : 's'}`;
        return `${shortId(s.id)}: ${read.meta.waypoints} waypoints, `
          + `${read.meta.heights.join('/')} m, ${shots}, drone ${read.meta.drone}`
          + ' — dashed on the map, and in the 3D view';
      } : null,
    }));
  }
  if (!usable.length) {
    box.insertAdjacentHTML('beforeend',
      '<p class="hint">A folder with no KMZ inside is not something DJI Fly lists, so it cannot be used as a slot.</p>');
  }
}

// A KMZ that arrived some other way -- AirDropped from the phone, exported
// earlier, handed over by someone else -- installs through the same review.
function sourceParts() {
  if (state.file) {
    return [{
      name: state.file.name,
      waypoints: '?',
      detail: `${(state.file.bytes.length / 1024).toFixed(0)} kB from disk`,
      bytes: state.file.bytes,
    }];
  }
  const plan = savedPlans().find((p) => p.id === state.planId);
  return plan ? partsForPlan(plan) : null;
}

// The heart of the panel: exactly what is about to be written, and over what.
function renderTransfer() {
  const box = $('instXfer');
  const btn = $('instGo');
  const parts = sourceParts();
  box.innerHTML = '';

  if (!state.transport) {
    box.innerHTML = '<p class="hint">Connect a controller first.</p>';
    btn.disabled = true;
    return;
  }
  if (!parts) {
    box.innerHTML = '<p class="hint">Pick a plan to install, or a KMZ file.</p>';
    btn.disabled = true;
    return;
  }
  const usable = state.slots.filter((s) => s.exists);
  const start = usable.findIndex((s) => s.id === state.selected);
  if (start < 0) {
    box.innerHTML = '<p class="hint">Pick the mission to overwrite.</p>';
    btn.disabled = true;
    return;
  }
  const targets = usable.slice(start, start + parts.length);
  if (targets.length < parts.length) {
    box.innerHTML = `<p class="hint bad">${parts.length} parts but only ${targets.length} slot(s) from there. `
      + 'Make more throwaway missions in DJI Fly, or start higher up the list.</p>';
    btn.disabled = true;
    return;
  }

  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const t = targets[i];
    const row = document.createElement('div');
    row.className = 'xfer';
    row.innerHTML = `
      <div class="xsrc"><b>${p.name}</b><em>${p.waypoints} wp · ${p.detail}</em></div>
      <div class="xarrow">→</div>
      <div class="xdst"><b>${shortId(t.id)}</b><em>replaces ${t.waypoints ?? '?'} wp from ${when(t.mtime)}</em></div>`;
    box.append(row);
  }
  box.insertAdjacentHTML('beforeend',
    `<p class="hint">The ${targets.length === 1 ? 'mission' : 'missions'} being replaced ${targets.length === 1 ? 'is' : 'are'} copied to <code>backups/</code> first.</p>`);
  btn.disabled = state.busy;
  btn.textContent = parts.length > 1 ? `Overwrite ${parts.length} missions` : 'Overwrite this mission';
}

/* ---------- actions ---------- */

// quiet: keep whatever the caller just put in the status line -- after an
// install the result is the thing worth reading, not the slot count.
async function loadSlots({ quiet = false } = {}) {
  if (!state.transport) return;
  if (!quiet) setStatus('reading missions off the controller…');
  try {
    const { slots } = await api(`/api/slots?transport=${encodeURIComponent(state.transport)}`);
    state.slots = slots;
    if (!slots.some((s) => s.id === state.selected)) {
      state.selected = slots.find((s) => s.exists)?.id ?? null;
    }
    const t = state.transports.find((x) => x.id === state.transport);
    if (!quiet) setStatus(`${t?.label ?? 'device'} · ${slots.length} mission folder${slots.length === 1 ? '' : 's'}`, 'ok');
  } catch (e) {
    state.slots = [];
    setStatus(e.message, 'bad');
  }
  renderSlots();
  renderTransfer();
}

async function scan() {
  setStatus('looking for a controller…');
  let info;
  try {
    info = await api('/api/controller');
  } catch (e) {
    setStatus(e.message, 'bad');
    return;
  }
  state.transports = info.transports;
  const sel = $('instDevice');
  sel.innerHTML = '';
  for (const t of info.transports) {
    const o = document.createElement('option');
    o.value = t.id;
    o.textContent = `${t.label} (${t.detail})`;
    sel.append(o);
  }
  sel.hidden = info.transports.length < 2;

  if (!info.transports.length) {
    state.transport = null;
    state.slots = [];
    badge('', '');
    setStatus(info.notes[0] ?? 'no controller found', 'bad');
    renderSlots();
    renderTransfer();
    return;
  }
  state.transport = info.transports.some((t) => t.id === state.transport) ? state.transport : info.transports[0].id;
  sel.value = state.transport;
  badge('●', 'ok');
  await loadSlots();
}

async function go() {
  const parts = sourceParts();
  if (!parts || !state.selected) return;

  state.busy = true;
  $('instGo').disabled = true;
  setStatus('writing…');
  try {
    const { installed, targets } = await writeParts(parts, state.selected);
    const backups = installed.map((r) => r.backup).filter(Boolean);
    // A plan now has a home on this controller, which is what lets Save
    // overwrite it later. A KMZ from disk does not -- there is no plan behind it.
    if (state.planId && !state.file) rememberSlot(state.planId, state.transport, targets[0].id);
    state.busy = false;
    await loadSlots({ quiet: true });
    setStatus(`Installed ${installed.length} mission${installed.length === 1 ? '' : 's'}. `
      + 'Reopen DJI Fly on the controller to see it'
      + (backups.length ? ` — replaced copy saved to ${backups[backups.length - 1]}` : ''), 'ok');
    return;
  } catch (e) {
    setStatus(e.message, 'bad');
  }
  state.busy = false;
  await loadSlots({ quiet: true });
}

// Writing a set of parts into consecutive slots from `first`. The one rule the
// panel above enforces is enforced here too: a plan in three parts needs three
// mission folders from that point on, or it is not installable at all.
async function writeParts(parts, first) {
  const usable = state.slots.filter((s) => s.exists);
  const start = usable.findIndex((s) => s.id === first);
  if (start < 0) throw new Error('that mission is no longer on the controller');
  const targets = usable.slice(start, start + parts.length);
  if (targets.length < parts.length) {
    throw new Error(`${parts.length} parts but only ${targets.length} mission folder(s) from there`);
  }
  const { installed } = await api('/api/install', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      transport: state.transport,
      items: parts.map((p, i) => ({ slot: targets[i].id, b64: b64(p.bytes) })),
    }),
  });
  return { installed, targets };
}

/* ---------- wiring ---------- */

export function initInstall(opts) {
  savedPlans = opts.savedPlans ?? (() => []);
  partsForPlan = opts.partsForPlan ?? (() => null);
  planRoute = opts.planRoute ?? (() => null);
  showRoute = opts.showRoute ?? (() => {});
  badge = opts.badge ?? (() => {});

  // Probe once. No API means this is the static build: the automatic half is
  // noise there, but the by-hand recipe next to it is exactly what is needed.
  fetch('/api/controller').then((res) => {
    if (!res.ok && res.status === 404) throw new Error('no api');
    hasApi = true;
    $('instAuto').hidden = false;
    $('instNoApi').hidden = true;
    renderPlans();
    return res.json();
  }).then(() => scan()).catch(() => {
    hasApi = false;
    $('instAuto').hidden = true;
    $('instNoApi').hidden = false;
    badge('', '');
  });

  $('instScan').addEventListener('click', scan);
  $('instFile').addEventListener('change', async (e) => {
    const f = e.target.files?.[0];
    const label = $('instFileName');
    if (!f) { state.file = null; label.textContent = '…or install a KMZ file instead of the current plan'; }
    else {
      state.file = { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) };
      label.textContent = `${f.name} — click to choose another, or clear the field to go back to the plan`;
    }
    label.parentElement.classList.toggle('loaded', Boolean(state.file));
    renderPlans();
    renderTransfer();
  });
  $('instDevice').addEventListener('change', (e) => { state.transport = e.target.value; loadSlots(); });
  $('instGo').addEventListener('click', go);

  // The cable is usually plugged in after the page is open, so opening the view
  // is as good a moment as any to look again.
  return {
    // Saving, deleting or syncing a plan changes what step 2 can offer.
    plansChanged: () => { if (hasApi) renderAll(); },
    refresh: () => { if (hasApi) scan(); },

    // Has this plan been installed somewhere, and is that somewhere on the
    // cable right now? `connected` is what turns Save into an overwrite.
    slotFor(planId) {
      const known = slotMemory()[planId];
      if (!known) return null;
      const here = state.transport === known.transport
        && state.slots.find((s) => s.id === known.slot && s.exists);
      return {
        ...known,
        short: shortId(known.slot),
        connected: Boolean(hasApi && here),
        waypoints: here ? here.waypoints : null,
      };
    },

    // Save's controller half: the same bytes the panel would write, into the
    // mission this plan already lives in.
    async installPlan(planId) {
      const known = slotMemory()[planId];
      const plan = savedPlans().find((p) => p.id === planId);
      if (!known || !plan) throw new Error('this plan has no mission on the controller yet');
      const parts = partsForPlan(plan);
      if (!parts) throw new Error('this plan will not build — it may be from an older format');
      const { installed, targets } = await writeParts(parts, known.slot);
      await loadSlots({ quiet: true });
      const backup = installed.map((r) => r.backup).filter(Boolean).pop();
      return `Saved, and written to ${targets.map((t) => shortId(t.id)).join(', ')}. `
        + 'Reopen DJI Fly on the controller to see it'
        + (backup ? ` — replaced copy saved to ${backup}` : '');
    },
  };
}
