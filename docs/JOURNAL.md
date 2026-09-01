# Journal

One line per working day, newest first. This is for what **happened** — what was
learned, what broke, what state something was left in. What *changed in the code*
is already in `git log` and does not belong here twice; what is still open is in
`TODO.md`. A line earns its place if you would not find it in either.

## 2026-09-01

Walk mode: survey a site on foot, one stop per obstacle, and the lowest orbit
ring now sits over the tallest thing found rather than at an arbitrary half of
the altitude. Two bugs surfaced while testing it, both older than the feature and
both worse than it: `synced.js` merged a **stale** snapshot after the network
round trip, so a record written mid-sync was silently erased (cost one stop in
five before it was noticed); and the height field was `type=number`, which on a
comma-decimal locale reads `2,5` back as `""` — coerced to `0`, a silently wrong
obstacle height. **The obstacle store is currently empty.** The three that were
in it were deleted on 2026-08-31 15:06, not by this work; four fake obstacles
from the first walk test did reach the live sync Worker at 00:20 and were
tombstoned at 00:23. Both sides now read 7 records, 0 alive.

## 2026-08-31

Surround ring — the orbit circle flown with the camera pointing out, so a capture
has a horizon and something behind the subject. Worth knowing before flying it:
the ring only ties into the rest of the capture while the orbit's tilt is shallow
enough to put the horizon in frame, which holds for everything auto-fit currently
proposes but by coincidence rather than design. Branch `ground-imagery` pushed to
GitHub for the first time, which published all five commits on it, not just that
day's.
