// The left pane holds three unrelated jobs -- planning a flight, the plans you
// keep, and a controller on the end of a USB cable -- and stacking them in one
// scroll made each look like a step of the next. Each is a view now, and this is
// the switch that drives them: one button per view, one pane visible at a time.
//
// Views are declared by the app; this module only knows about `#menu` and a
// `#pane-<id>` per view, so a new view is a button and a div.

const $ = (id) => document.getElementById(id);

export function createMenu(views) {
  const nav = $('menu');
  const buttons = new Map();
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
    if (!view || id === current) return;
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

  show(views[0].id);
  return { show, badge, current: () => current };
}
