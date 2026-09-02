// A plan is not a tab, it is what you are on. This owns that: which saved plan
// is loaded, whether you are looking at it or changing it, and the two doors
// between those -- the pencil in, Save or Cancel out.
//
// The mode is derived, not tracked, because a tracked one drifts: the app would
// have to remember to say "now you are editing" at every place a plan can
// change, and the one place it forgot would be the bug. A plan on screen that
// differs from the plan on disk IS an edit in progress, and `getCode()` is
// already the exact comparison -- the same string the library stores and a
// shared link carries. The one thing a comparison cannot know is that you
// pressed the pencil and have not typed anything yet, so that is the single
// latch here.
//
// Editing takes the other views away. Not to be strict about it: the panel is
// one column, so Saved, Walk and Controller are each a different subject
// entirely, and coming back from one to a half-finished plan with no idea what
// state it is in is worse than being asked to finish. Obstacles stays -- the
// clearance check and the coverage score both read it, so a box you forgot is
// part of this plan, not a different job.

const $ = (id) => document.getElementById(id);

// The views that are not part of finishing a plan. Obstacles is not among
// them: the clearance check and the coverage score both read the boxes, so one
// you forgot to draw is part of this plan rather than a different job.
const ELSEWHERE = ['saved', 'walk', 'device'];

export function initPlanMode({
  menu, getCode, applyCode, hasPlan, describe, clearPlan,
  plans, device, onSession = () => {},
}) {
  // What is loaded, and the code it had when it was loaded or last saved.
  // `code` is taken from the UI rather than from storage on purpose: a slider
  // that snaps to its step would otherwise make a plan read as edited the
  // instant it opened.
  let session = { id: null, name: null, code: null };
  let editing = false;

  function status(text, kind = '') {
    $('saveStatus').textContent = text;
    $('saveStatus').className = `hint ${kind}`;
  }

  // Changing which plan you are on is not an action to undo -- it happens
  // alongside one, or instead of one -- but leaving it out of the stack's idea
  // of the present would make the next undo revert it by accident.
  function setSession(next) {
    session = next;
    editing = false;
    $('planName').value = session.name ?? '';
    refresh();
    onSession();
  }

  const dirty = () => hasPlan() && getCode() !== session.code;

  function mode() {
    if (!hasPlan()) return 'new';
    return editing || dirty() ? 'edit' : 'view';
  }

  // What the controller line under the name says, and what Save is going to do.
  function target() {
    return session.id ? device.slotFor(session.id) : null;
  }

  function refresh() {
    const m = mode();
    const name = session.name ?? 'New plan';
    const slot = target();

    menu.setLabel('plan', m === 'new' ? '+ New plan'
      : m === 'edit' ? `${name} · editing`
      : name);
    // The menu never takes away the view you are standing in. Walking a site
    // is why: each stop grows the box, which makes the plan an edit in
    // progress, and hiding Walk at the first stop would throw you out of the
    // survey you are half way through. Leave that view and the gate closes
    // behind you.
    const gated = m === 'edit' && !ELSEWHERE.includes(menu.current());
    menu.setVisible(ELSEWHERE, !gated, 'plan');

    $('planHead').hidden = m === 'new';
    $('planTitle').textContent = name;
    $('planEdit').hidden = m !== 'view';
    $('planNew').hidden = m !== 'view';
    $('planWhere').textContent = m === 'edit'
      ? 'Editing. Save or cancel to get the rest of the app back.'
      : slot ? `On the controller · mission ${slot.short}` : '';

    // Viewing a plan is reading it: what it is, how long it flies, what it
    // collides with. The controls that would change it are the thing the
    // pencil is for.
    $('step-area').hidden = m === 'view';
    $('step-params').hidden = m === 'view';
    $('editBar').hidden = m !== 'edit';
    $('pane-plan').classList.toggle('viewing', m === 'view');

    if (m === 'edit') {
      $('planCancel').textContent = session.id ? 'Cancel' : 'Discard';
      $('planSave').textContent = slot?.connected
        ? 'Save & overwrite on controller'
        : 'Save plan';
    }
  }

  $('planEdit').addEventListener('click', () => {
    editing = true;
    status('');
    refresh();
  });

  $('planNew').addEventListener('click', () => {
    plans.select(null);
    // Clearing first, because that is what pushes the undo step, and the step
    // has to remember the plan you were on rather than the nothing you are
    // about to be on -- otherwise cmd+Z brings the box back orphaned.
    clearPlan();
    setSession({ id: null, name: null, code: null });
    status('');
  });

  $('planCancel').addEventListener('click', () => {
    if (session.id && session.code) {
      applyCode(session.code);
      setSession({ ...session });
      status(`Back to the saved “${session.name}”.`);
    } else {
      clearPlan();
      setSession({ id: null, name: null, code: null });
      status('');
    }
  });

  // Saving is one act with two halves. The plan goes into the library always;
  // the controller half only happens for a plan that has already been installed
  // somewhere, because that is the only case where "overwrite" names a mission
  // rather than asking you to choose one.
  $('planSave').addEventListener('click', async () => {
    const code = getCode();
    if (!code) { status('Draw a box first — there is no plan to save.', 'bad'); return; }
    const name = $('planName').value.trim() || session.name || describe() || 'Untitled plan';
    const saved = plans.save({ id: session.id, name, code });
    plans.select(saved.id);
    setSession({ id: saved.id, name: saved.name, code });

    const slot = target();
    if (!slot) { status(`Saved “${saved.name}”.`, 'ok'); return; }
    if (!slot.connected) {
      status(`Saved “${saved.name}” — still the ${slot.short} mission, but the controller is not plugged in.`, 'warn');
      return;
    }
    status(`Saved. Writing to ${slot.short}…`);
    $('planSave').disabled = true;
    try {
      status(await device.installPlan(saved.id), 'ok');
    } catch (e) {
      // The library already has it, so this is never lost work -- say that,
      // rather than leaving "Save" looking like it failed outright.
      status(`Saved “${saved.name}”, but writing to the controller failed — ${e.message}`, 'bad');
    }
    $('planSave').disabled = false;
    refresh();
  });

  return {
    refresh,
    mode,
    // Loading one from the library, or from a link: it is the plan you are on
    // now, and you are looking at it rather than part-way through changing it.
    load(plan) {
      setSession({ id: plan?.id ?? null, name: plan?.name ?? null, code: getCode() });
      status('');
    },
    // Undo restores a rectangle and the controls that made it. Which plan
    // those belong to is not derivable from either, so it rides along in the
    // snapshot and comes back through here -- otherwise cmd+Z quietly detaches
    // you from the plan you were editing, and the next Save forks a copy of it.
    restore(sess) {
      session = sess ? { ...sess } : { id: null, name: null, code: null };
      editing = false;
      $('planName').value = session.name ?? '';
      refresh();
    },
    // A plan deleted underneath you is no longer the thing Save would overwrite
    // -- and it is no longer a saved plan at all, so keeping its name in the
    // header would claim a library entry that is gone. What is left on screen
    // is an unsaved plan, which is what it now says.
    forget(id) {
      if (session.id !== id) return;
      setSession({ id: null, name: null, code: null });
    },
    current: () => session,
  };
}
