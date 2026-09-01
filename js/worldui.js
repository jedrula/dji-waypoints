// The obstacles view. It owns the list of boxes standing in the field, the
// clearance you are willing to fly at, and nothing else -- what a plan does
// with them is the app's business, and what they look like on the map is the
// map's.
//
// The list is global: obstacles are not attached to a plan, every plan sees all
// of them, and the whole lot is fetched and drawn whether you are near them or
// not. That is a deliberate simplification. A few hundred boxes is a few tens
// of kilobytes, and the moment obstacles have to be queried by area this stops
// being a thing you can reason about in one file.

import {
  createObstacleStore, normalizeRect, DEFAULT_HEIGHT, DEFAULT_CLEARANCE, describe,
} from './obstacles.js';

const $ = (id) => document.getElementById(id);
const CLEARANCE_KEY = 'dji.clearance';

// No ".0" on a whole number: "12 m" is what the box is, and "12.0 m" claims a
// precision that eyeballing a roof off satellite imagery does not have.
const m = (v) => `${Number.isInteger(v) ? v : v.toFixed(1)} m`;

export function initWorld({
  onChange = () => {}, onSelect = () => {}, onFocus = () => {}, onDraw = () => {},
  setCount = () => {},
} = {}) {
  const store = createObstacleStore();
  let selected = null;
  let report = null;      // the latest collision check, or null
  let syncing = false;
  // One at a time and in order, for the same reason plans are: an edit followed
  // by a delete has to reach the service that way round.
  let queue = Promise.resolve();

  let clearance = DEFAULT_CLEARANCE;
  try {
    clearance = Number(localStorage.getItem(CLEARANCE_KEY)) || DEFAULT_CLEARANCE;
  } catch { /* private window */ }

  // A height being dragged in the 3D view. Held here rather than written,
  // because a pointermove is not a decision: everything downstream sees the
  // dragged height, and nothing is stored or synced until the drag ends.
  let live = null;
  const listNow = () => (live
    ? store.list().map((o) => (o.id === live.id ? { ...o, height: live.height } : o))
    : store.list());

  function status(text, kindClass = '') {
    $('obsStatus').textContent = text;
    $('obsStatus').className = `hint ${kindClass}`;
  }

  /* ---------- the list ---------- */

  function rowFor(o) {
    const hit = report?.obstacles.find((r) => r.id === o.id);
    const row = document.createElement('div');
    row.className = `obsitem${selected === o.id ? ' on' : ''}${hit?.grade ? ` ${hit.grade}` : ''}`;

    const main = document.createElement('span');
    main.className = 'obsmain';
    const name = document.createElement('input');
    name.type = 'text';
    name.value = o.name;
    name.placeholder = 'Name this box…';
    name.addEventListener('change', () => edit(o, { name: name.value.trim() }));
    const meta = document.createElement('em');
    // The number the whole feature exists to produce. Say it even when it is
    // good news -- "clear by 18 m" is the answer to the same question.
    // A row is narrow, so this says the one thing and stops. The plan view has
    // room for the leg counts.
    meta.textContent = !hit ? `${m(o.height)} tall`
      : hit.grade === 'strike' ? `the flight goes through this`
      : hit.grade === 'near' ? `${m(hit.dist)} away — under ${m(clearance)}`
      : `clear by ${m(hit.dist)}`;
    main.append(name, meta);
    main.addEventListener('click', (e) => { if (e.target !== name) pick(o.id); });

    const height = document.createElement('input');
    height.type = 'number';
    height.className = 'obsh';
    height.min = '0';
    height.max = '1000';
    height.step = '0.5';
    height.value = String(o.height);
    height.title = 'Height above the takeoff point, in metres';
    // A number input renders in the browser's locale, so on a machine set to a
    // comma decimal this field SHOWS "25,2" and then refuses a typed comma,
    // handing back an empty string. Number('') is 0, and a silently zeroed
    // obstacle is one the flight is no longer warned about -- so anything that
    // does not parse puts the stored height back rather than becoming a number.
    height.addEventListener('change', () => {
      const v = height.valueAsNumber;
      if (!Number.isFinite(v) || v < 0) {
        height.value = String(o.height);
        status('That height did not read as a number — use a dot, not a comma.', 'bad');
        return;
      }
      edit(o, { height: v });
    });

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'planx';
    del.title = `Delete ${describe(o)}`;
    del.textContent = '×';
    del.addEventListener('click', () => {
      store.remove(o.id);
      if (selected === o.id) selected = null;
      status(`Deleted “${describe(o)}”.`);
      render();
      onChange();
      sync({ quiet: true });
    });

    row.append(main, height, del);
    return row;
  }

  function render() {
    const list = listNow();
    setCount(list.length);
    const box = $('obsList');
    box.innerHTML = '';
    if (!list.length) {
      box.innerHTML = '<p class="hint">Nothing drawn yet. Draw a box over a building, '
        + 'a tree or a mast, give it a height, and every plan gets checked against it.</p>';
    }
    // Whatever the flight comes closest to is what you want at the top; with no
    // plan on screen there is no such order, so fall back to newest first.
    const order = report
      ? [...list].sort((a, b) => rank(a) - rank(b))
      : list;
    for (const o of order) box.append(rowFor(o));

    const r = report;
    const el = $('obsReport');
    el.hidden = !r || (!r.strikes && !r.near);
    if (r && (r.strikes || r.near)) {
      const bits = [];
      if (r.strikes) bits.push(`<b>${r.strikes}</b> the flight passes through`);
      if (r.near) bits.push(`<b>${r.near}</b> within ${m(r.clearance)}`);
      el.innerHTML = `${bits.join(', ')}. Closest approach ${m(r.minDist)}.`;
      el.className = r.strikes ? 'warn bad' : 'warn';
    }
    $('obsSync').disabled = syncing || !store.endpoint();
  }

  const rank = (o) => {
    const hit = report?.obstacles.find((r) => r.id === o.id);
    if (!hit) return Infinity;
    return hit.grade === 'strike' ? -1e6 + hit.dist : hit.dist;
  };

  function edit(o, patch) {
    live = null;
    const next = store.put({ ...o, ...patch });
    status(`Updated “${describe(next)}”.`, 'ok');
    render();
    onChange();
    sync({ quiet: true });
  }

  function pick(id) {
    selected = selected === id ? null : id;
    render();
    onSelect(selected);
    const o = listNow().find((x) => x.id === selected);
    if (o) onFocus(o);
  }

  /* ---------- controls ---------- */

  $('obsDraw').addEventListener('click', () => onDraw());

  const showClearance = () => { $('clearanceOut').textContent = m(clearance); };
  $('clearance').value = String(clearance);
  showClearance();
  $('clearance').addEventListener('input', () => {
    clearance = Number($('clearance').value);
    showClearance();
    try { localStorage.setItem(CLEARANCE_KEY, String(clearance)); } catch { /* private window */ }
    onChange();
  });

  /* ---------- sync ---------- */

  function sync({ quiet = false } = {}) {
    queue = queue.then(async () => {
      if (!store.endpoint()) return;
      if (!quiet) status('syncing…');
      syncing = true;
      render();
      try {
        const { total, pulled } = await store.sync();
        if (pulled) {
          status(`Synced — ${pulled} new from the other device, ${total} in total.`, 'ok');
          onChange({ remote: true });
        } else if (!quiet) {
          status(`Synced — ${total} obstacle${total === 1 ? '' : 's'}, nothing new.`, 'ok');
        }
      } catch (e) {
        status(quiet ? `Saved here, not synced yet — ${e.message}` : e.message, 'bad');
      } finally {
        syncing = false;
        render();
      }
    });
    return queue;
  }
  $('obsSync').addEventListener('click', () => sync());

  if (!store.endpoint()) status('Local only — no sync service configured yet.');
  render();
  sync({ quiet: true });

  return {
    list: listNow,
    clearance: () => clearance,
    selected: () => selected,
    select: (id) => {
      selected = id;
      render();
      onSelect(id);
      // Selecting from the 3D view means the row is the thing you were reaching
      // for, and the list can be long enough to have scrolled it away.
      $('obsList').querySelector('.obsitem.on')?.scrollIntoView({ block: 'nearest' });
    },

    // A box just dragged out on the map. It arrives with no name and the
    // the default height, both of which the row lets you fix -- unless it came
    // from a walk, where you gave the height standing next to the thing and
    // there is nothing left to correct.
    add(rect, { height = DEFAULT_HEIGHT, quiet = false } = {}) {
      const o = store.put({ ...normalizeRect(rect), name: '', height });
      selected = o.id;
      if (!quiet) {
        status(`Added a box, ${height} m tall — set its real height by typing it, `
             + 'or by dragging the top of it in the 3D view.', 'ok');
      }
      render();
      onSelect(o.id);
      onChange();
      sync({ quiet: true });
      return o;
    },

    // Moved or resized on the map. Same write as any other edit; it just did
    // not come from a text box.
    reshape(id, rect) {
      const o = store.list().find((x) => x.id === id);
      if (!o) return;
      live = null;
      store.put({ ...o, ...normalizeRect(rect) });
      render();
      onChange();
      sync({ quiet: true });
    },

    // The top of a box dragged in the 3D view. `done` is the mouse coming up,
    // and it is the only one of these that reaches storage or the service.
    setHeight(id, height, { done = false } = {}) {
      const o = store.list().find((x) => x.id === id);
      if (!o) return;
      const h = Math.round(Math.max(0.5, Math.min(1000, height)) * 2) / 2;
      if (!done) {
        if (live?.id === id && live.height === h) return;
        live = { id, height: h };
        selected = id;
        render();
        onChange({ live: true });
        return;
      }
      live = null;
      if (h === o.height) { render(); return; }
      edit(o, { height: h });
    },

    // Put the list back the way a snapshot remembers it. Every difference is
    // written as a fresh edit rather than by rolling timestamps back, because
    // the other device merges by last-write-wins: an undo that restored the old
    // timestamp too would lose to the very edit it was undoing, and the box
    // would spring back on the next sync.
    restore(records) {
      const now = store.list();
      const want = new Map(records.map((r) => [r.id, r]));
      let changed = false;
      for (const o of now) {
        if (!want.has(o.id)) { store.remove(o.id); changed = true; }
      }
      for (const r of records) {
        const cur = now.find((o) => o.id === r.id);
        const differs = !cur || ['name', 'height', 'north', 'south', 'east', 'west']
          .some((k) => cur[k] !== r[k]);
        if (differs) { store.put(r); changed = true; }
      }
      live = null;
      if (selected && !want.has(selected)) selected = null;
      render();
      if (changed) sync({ quiet: true });
      return changed;
    },

    // The app hands back what the collision check found, which is the only way
    // a row can say how close the flight gets.
    setReport(r) { report = r; render(); },
    render,
    sync,
  };
}
