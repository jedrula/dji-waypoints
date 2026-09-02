// The left pane holds several unrelated jobs -- the plan you are on, the plans
// you keep, the world it flies through, and a controller on the end of a USB
// cable -- and stacking them in one scroll made each look like a step of the
// next. Each is a view now, and this is the switch that drives them: one button
// per view, one pane visible at a time.
//
// Views are declared by the app; this module only knows about `#menu` and a
// `#pane-<id>` per view, so a new view is a button and a div.
//
// Two things here are not just switching. A label can change, because the first
// slot is no longer a fixed word -- it is whichever plan you are on. And a
// button can be taken away, because editing a plan hides every view that is not
// part of finishing it; a hidden view cannot be shown, so the pane you are
// looking at can never be one the menu is no longer offering.

const $ = (id) => document.getElementById(id);

export function createMenu(views) {
  const nav = $('menu');
  const buttons = new Map();
  const hidden = new Set();
  let current = null;

  for (const v of views) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.view = v.id;
    b.innerHTML = '<span class="mlabel"></span><span class="mbadge"></span>';
    b.querySelector('.mlabel').textContent = v.label;
    b.addEventListener('click', () => {
      show(v.id);
      // On a phone the panel is a block above the map rather than its own
      // scroller, so the top of the new view can be off-screen.
      if (window.scrollY > 0) window.scrollTo({ top: 0 });
    });
    nav.append(b);
    buttons.set(v.id, b);
  }

  function show(id) {
    const view = views.find((v) => v.id === id);
    if (!view || hidden.has(id) || id === current) return;
    current = id;
    for (const v of views) {
      $(`pane-${v.id}`).hidden = v.id !== id;
      buttons.get(v.id).classList.toggle('on', v.id === id);
    }
    $('panel').scrollTop = 0;   // a change of subject starts at the top of it
    view.onShow?.();
  }

  // A badge is the one thing a view may say while you are looking at another
  // one: how many plans are saved, whether a controller is on the cable.
  function badge(id, text, kind = '') {
    const el = buttons.get(id)?.querySelector('.mbadge');
    if (!el) return;
    el.textContent = text ?? '';
    el.className = `mbadge ${kind}`;
  }

  function setLabel(id, text) {
    const el = buttons.get(id)?.querySelector('.mlabel');
    if (el) el.textContent = text;
  }

  // Taking a view away while you are standing in it would leave a pane on
  // screen with no way back to it, so the caller's own view comes forward
  // first. `keep` is that view: the one doing the hiding.
  function setVisible(ids, on, keep) {
    for (const id of ids) {
      const b = buttons.get(id);
      if (!b) continue;
      b.hidden = !on;
      if (on) hidden.delete(id); else hidden.add(id);
    }
    if (!on && hidden.has(current) && keep) show(keep);
  }

  show(views[0].id);
  return { show, badge, setLabel, setVisible, current: () => current };
}
