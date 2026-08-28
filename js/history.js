// Undo and redo over whole application states.
//
// A command pattern -- one object per action, each knowing how to reverse
// itself -- is the usual answer, and it is the wrong one here. Actions in this
// app are not independent: dropping a box re-proposes the altitude, the ring
// count and the pass mix all at once, and moving one slider discards heights
// pinned in the 3D view. Writing an inverse for each of those is writing the
// planner backwards, and any one of them getting it slightly wrong is an undo
// that lands somewhere you have never been.
//
// So the unit is a snapshot: the rectangle, the control values, and the
// obstacle list. Together those are a few kilobytes and they determine
// everything else, because the plan is a pure function of them. Restoring one
// cannot drift, because nothing is being replayed.

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function createHistory({ snapshot, restore, rebase = null, limit = 40 }) {
  let present = snapshot();
  const past = [];
  const future = [];

  return {
    // Something happened that a person would expect cmd+Z to take back. Called
    // AFTER the change, because `present` is still the state before it.
    //
    // Returns false when nothing actually moved. That matters more than it
    // looks: a slider gets a change event when you click it without dragging,
    // and a stack full of entries that undo to the same place is a cmd+Z that
    // appears not to work.
    commit() {
      const now = snapshot();
      if (same(now, present)) return false;
      past.push(present);
      if (past.length > limit) past.shift();
      present = now;
      // A new action is a new branch; whatever was undone is not coming back.
      future.length = 0;
      return true;
    },

    // State changed, but not because of anything the person at this keyboard
    // did -- a box arriving from the other device, say. Not theirs to undo,
    // and leaving `present` stale would make the NEXT undo revert it by
    // accident.
    //
    // Updating `present` alone is not enough, though. Every snapshot already on
    // the stack was taken before that box existed, so undoing past it would
    // delete it -- silently throwing away work done on the phone, which is the
    // exact thing undo is supposed to make impossible. `rebase` folds the
    // arrival into the stored snapshots, so as far as the stack is concerned it
    // was always there.
    refresh() {
      const next = snapshot();
      if (rebase) {
        for (let i = 0; i < past.length; i++) past[i] = rebase(past[i], present, next);
        for (let i = 0; i < future.length; i++) future[i] = rebase(future[i], present, next);
      }
      present = next;
    },

    undo() {
      if (!past.length) return false;
      future.push(present);
      present = past.pop();
      restore(present);
      return true;
    },

    redo() {
      if (!future.length) return false;
      past.push(present);
      present = future.pop();
      restore(present);
      return true;
    },

    canUndo: () => past.length > 0,
    canRedo: () => future.length > 0,
    depth: () => ({ past: past.length, future: future.length }),
  };
}
