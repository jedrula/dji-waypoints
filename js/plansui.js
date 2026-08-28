// The saved-plans view. Local list always, and sync on top of it with nothing
// to set up -- the key is hardcoded (js/plans.js), so the only honest thing for
// this block to do is sync by itself: on open, and after every change. The
// button stays for the case where the phone saved something while this page was
// already sitting open.
//
// It owns nothing outside its own pane: the plan count goes out through
// `setCount` (the menu badge wears it) and loading one hands over through
// `applyCode` / `onLoaded`.

import { createPlanStore } from './plans.js';

const $ = (id) => document.getElementById(id);

export function initPlans({
  getCode, applyCode, describe, exportPlan = null,
  setCount = () => {}, onLoaded = () => {}, onChange = () => {},
}) {
  const store = createPlanStore();
  let selected = null;
  let syncing = false;
  // One at a time and in order: a save followed by a delete has to reach the
  // service in that order, or the delete is the one that gets lost.
  let queue = Promise.resolve();

  const when = (t) => new Date(t).toLocaleString(undefined,
    { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

  function status(text, kind = '') {
    $('planStatus').textContent = text;
    $('planStatus').className = `hint ${kind}`;
  }

  // Saving happens from the plan view, so that is where the answer has to
  // appear -- the list's own status line is a pane away.
  function saveStatus(text, kind = '') {
    const el = $('saveStatus');
    if (!el) return;
    el.textContent = text;
    el.className = `hint ${kind}`;
  }

  function render() {
    const plans = store.list();
    setCount(plans.length);
    const box = $('planList');
    box.innerHTML = '';
    if (!plans.length) {
      box.innerHTML = '<p class="hint">Nothing saved yet. Draw a box, name it, and it lands here.</p>';
    }
    for (const p of plans) {
      const row = document.createElement('div');
      row.className = `planitem${selected === p.id ? ' on' : ''}`;
      row.innerHTML = `<span class="planmain"><b></b><em>${when(p.updatedAt)}</em></span>`;
      row.querySelector('b').textContent = p.name;

      const load = document.createElement('button');
      load.type = 'button';
      load.textContent = 'Load';
      load.addEventListener('click', () => {
        if (applyCode(p.code)) {
          selected = p.id;
          $('planName').value = p.name;
          status(`Loaded “${p.name}”.`, 'ok');
          render();
          onLoaded(p);
        } else {
          status('That saved plan will not decode — it may be from an older format.', 'bad');
        }
      });

      // A saved plan is a whole flight; exporting it should not mean loading it,
      // overwriting whatever is on screen, and finding your way back.
      const exp = exportPlan && document.createElement('button');
      if (exp) {
        exp.type = 'button';
        exp.textContent = 'Export';
        exp.title = 'Download this plan as KMZ without loading it';
        exp.addEventListener('click', () => {
          const n = exportPlan(p.code);
          status(n
            ? `Exported “${p.name}” — ${n} file${n === 1 ? '' : 's'}.`
            : 'That saved plan will not decode — it may be from an older format.',
          n ? 'ok' : 'bad');
        });
      }

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'planx';
      del.title = 'Delete this plan';
      del.textContent = '×';
      del.addEventListener('click', () => {
        store.remove(p.id);
        if (selected === p.id) selected = null;
        status(`Deleted “${p.name}”.`);
        render();
        sync({ quiet: true });
      });

      row.append(load, ...(exp ? [exp] : []), del);
      box.append(row);
    }
    $('syncNow').disabled = syncing || !store.endpoint();
    onChange(plans);
  }

  $('planSave').addEventListener('click', () => {
    const code = getCode();
    if (!code) {
      const msg = 'Draw a box first — there is no plan to save.';
      saveStatus(msg, 'bad');
      status(msg, 'bad');
      return;
    }
    const name = $('planName').value.trim() || describe() || 'Untitled plan';
    // Saving over the plan you loaded is the common case; a new name is a new plan.
    const existing = store.list().find((p) => p.id === selected && p.name === name);
    const saved = store.save({ id: existing?.id, name, code });
    selected = saved.id;
    $('planName').value = saved.name;
    saveStatus(`Saved “${saved.name}” — it is in Saved plans now.`, 'ok');
    status(`Saved “${saved.name}”.`, 'ok');
    render();
    sync({ quiet: true });
  });

  $('syncNow').addEventListener('click', () => sync());

  // `quiet` is a sync nobody asked for -- after a save, or on open. It reports
  // what arrived and what went wrong, and otherwise says nothing, because
  // overwriting "Saved “Zablocie yard”" with "nothing new" reads as a failure.
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
        } else if (!quiet) {
          status(`Synced — ${total} plan${total === 1 ? '' : 's'}, nothing new.`, 'ok');
        }
      } catch (e) {
        // Saving already happened locally, so this is never lost work -- the
        // next sync sends it. Say so rather than looking like the save failed.
        status(quiet ? `Saved here, not synced yet — ${e.message}` : e.message, 'bad');
      } finally {
        syncing = false;
        render();
      }
    });
    return queue;
  }

  if (!store.endpoint()) {
    status('Local only — no sync service configured yet.');
  }
  render();
  sync({ quiet: true });
  return { render, sync, list: () => store.list() };
}
