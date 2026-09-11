// The saved-plans view. Local list always, and sync on top of it with nothing
// to set up -- this device makes its own key up (js/service.js), so the only
// honest thing for this block to do is sync by itself: on open, and after every
// change. The button stays for the case where the phone saved something while
// this page was already sitting open.
//
// The key is shown here because it is now the only thing standing between two
// libraries, and pasting it into a second device is how they become one.
//
// It owns nothing outside its own pane: the plan count goes out through
// `setCount` (the menu badge wears it) and loading one hands over through
// `applyCode` / `onLoaded`. Saving is not here either -- it belongs to the plan
// you are editing, so js/planmode.js owns the button and calls `save` below.

import { createPlanStore, groupOf, groupPlans } from './plans.js';
import { serviceKey, setServiceKey } from './service.js';

const $ = (id) => document.getElementById(id);

export function initPlans({
  applyCode, exportPlan = null,
  setCount = () => {}, onLoaded = () => {}, onChange = () => {}, onDeleted = () => {},
  isShown = () => false, onToggleShow = null, onShowMany = null, statsFor = null,
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

  // Group headers carry the numbers that decide whether a capture is one trip
  // or three, so they need the missions built, which only the caller can do.
  function groupHeader(head, members) {
    const bar = document.createElement('div');
    bar.className = 'plangroup';
    const title = document.createElement('b');
    title.textContent = head;
    const meta = document.createElement('em');
    let text = `${members.length} missions`;
    if (statsFor) {
      let minutes = 0;
      let waypoints = 0;
      for (const p of members) {
        const s = statsFor(p.code);
        if (s) { minutes += s.minutes; waypoints += s.waypoints; }
      }
      const batteries = Math.ceil(minutes / 18);
      text += ` · ${waypoints} wp · ${minutes.toFixed(1)} min · `
        + `${batteries} batter${batteries === 1 ? 'y' : 'ies'}`;
    }
    meta.textContent = text;
    bar.append(title, meta);

    if (onShowMany) {
      const all = document.createElement('button');
      all.type = 'button';
      const set = () => {
        const on = members.every((p) => isShown(p.id));
        all.className = `planshow${on ? ' on' : ''}`;
        all.textContent = on ? 'Hide all' : 'Show all';
      };
      set();
      all.title = 'Draw every mission in this capture on the map at once';
      all.addEventListener('click', () => {
        onShowMany(members, !members.every((p) => isShown(p.id)));
        render();
      });
      bar.append(all);
    }
    return bar;
  }

  function render() {
    const plans = store.list();
    setCount(plans.length);
    const box = $('planList');
    box.innerHTML = '';
    if (!plans.length) {
      box.innerHTML = '<p class="hint">Nothing saved yet. Draw a box, name it, and it lands here.</p>';
    }

    for (const { head, members } of groupPlans(plans)) {
      if (head) box.append(groupHeader(head, members));
      for (const p of members) renderRow(box, p, head);
    }
    $('syncNow').disabled = syncing || !store.endpoint();
    onChange(plans);
  }

  function renderRow(box, p, head) {
      const row = document.createElement('div');
      row.className = `planitem${selected === p.id ? ' on' : ''}${head ? ' grouped' : ''}`;
      row.innerHTML = `<span class="planmain"><b></b><em>${when(p.updatedAt)}</em></span>`;
      // Inside a group the head is already above the row, so the row wears the
      // half of the name that is actually different.
      row.querySelector('b').textContent = head ? (groupOf(p.name)?.rest ?? p.name) : p.name;

      // Putting a plan on the map is not loading it. A capture is several
      // plans and you want to see them together; loading one would throw away
      // whatever is being edited, which is the opposite of the question.
      const show = onToggleShow && document.createElement('button');
      if (show) {
        show.type = 'button';
        show.className = `planshow${isShown(p.id) ? ' on' : ''}`;
        show.textContent = isShown(p.id) ? 'Hide' : 'Show';
        show.title = 'Draw this plan on the map alongside the others';
        show.addEventListener('click', () => {
          const on = onToggleShow(p);
          show.className = `planshow${on ? ' on' : ''}`;
          show.textContent = on ? 'Hide' : 'Show';
        });
      }

      const load = document.createElement('button');
      load.type = 'button';
      load.textContent = 'Load';
      load.addEventListener('click', () => {
        if (applyCode(p.code)) {
          selected = p.id;
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
        onDeleted(p.id);
        status(`Deleted “${p.name}”.`);
        render();
        sync({ quiet: true });
      });

      row.append(...(show ? [show] : []), load, ...(exp ? [exp] : []), del);
      box.append(row);
  }

  // An id means overwrite the plan you were editing -- including under a new
  // name, because renaming a plan is not the same act as making another one.
  // Without an id it is new, which is what the + New button leaves you with.
  function save({ id, name, code }) {
    const saved = store.save({ id, name, code });
    selected = saved.id;
    status(`Saved “${saved.name}”.`, 'ok');
    render();
    sync({ quiet: true });
    return saved;
  }

  $('syncNow').addEventListener('click', () => sync());

  // Showing the key is most of the feature: a library nobody can name is a
  // library you cannot reach from your other device.
  $('syncKey').value = serviceKey();
  // The field is too narrow to show a whole key and the point of it is to be
  // copied, so touching it selects the lot. It still takes a paste, which is
  // the other half.
  $('syncKey').addEventListener('focus', () => $('syncKey').select());
  $('syncKeyApply').addEventListener('click', () => {
    const wanted = $('syncKey').value;
    if (wanted.trim() === serviceKey()) { status('That is already this device\u2019s key.'); return; }
    try {
      setServiceKey(wanted);
    } catch (e) {
      // Put the working key back: an input left holding something the service
      // would refuse reads as though it had been accepted.
      $('syncKey').value = serviceKey();
      status(e.message, 'bad');
      return;
    }
    $('syncKey').value = serviceKey();
    status('Switched. Syncing this device\u2019s plans into that library\u2026');
    sync();
  });

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
  return {
    render,
    sync,
    save,
    list: () => store.list(),
    select: (id) => { selected = id; render(); },
  };
}
