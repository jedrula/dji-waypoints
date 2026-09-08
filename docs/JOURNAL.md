# Journal

One line per working day, newest first. This is for what **happened** — what was
learned, what broke, what state something was left in. What *changed in the code*
is already in `git log` and does not belong here twice; what is still open is in
`TODO.md`. A line earns its place if you would not find it in either.

## 2026-09-09

Every install makes up its own sync key now. It was one constant compiled into
the app, which was correct for exactly one person and quietly catastrophic for
two: the key *is* the namespace, so a second user would have read and written
the first's plans — and `mergeRecords` applies the 500 cap to the *merged*
list and keeps the newest, so an active user's plans would have evicted a quiet
user's for good, with no tombstone and nothing said. That is the bug this
closes, ahead of anyone actually arriving.

The server needed no part of it: it checks the shape of a key and never a
value, so isolation was entirely a client change. The shape moved into
`sync/protocol.js` as `KEY_OK` — both ends have to agree about it, which is
what that file is for, and it was spelled out at each end before.

Cost: sharing a library between your own two devices is now a key copied once,
shown in the Plans panel. That is the thing the hardcoded constant was buying,
and it was worth giving up.

Also, the 3D viewer is reachable from the app (Advanced → *Look at the ground
in 3D*), and was quietly broken by hosting before that — its `.json` and
geometry requests both blocked until the scene was built, minutes, against
Cloudflare's ~100 s cap. Everything answers 202 and the page polls now, and a
build that fails after its request is gone carries the reason to the next poll
rather than letting the poller time out and blame the wait.

**Not done, and now the top of the list:** nothing rate-limits the LiDAR
routes. Any key can trigger unlimited 223 MB downloads from GUGiK, and
`BUILD_CONCURRENCY 2` is one global queue with no fairness — one person
importing a wide area blocks everyone else past the client's 150 s budget.
That, and `var/laz` still has no eviction policy.

## 2026-09-08

`server/` is hosted, at **https://drone.topomatch.com** — a second hostname on
the Cloudflare tunnel that already fronts another service on the home Linux
box, and pane 8 of that box's `start-dev.sh`. The deployed app therefore
measures imported obstacle heights and syncs between devices for the first
time; both were the same single edit, `DEFAULT_URL` in `js/service.js`.

The ticket that planned this was wrong twice, which was most of the work. It
assumed nginx fronted that box: nothing there has nginx, and the tunnel's
origin is a FastAPI gateway proxying by path prefix. Routing through that
gateway was the natural-looking option and lost on a measurement — it sets
`Access-Control-Allow-Origin: *` over whatever the origin sent, which does not
duplicate the header (Starlette overwrites) but does quietly make `ORIGIN_OK`
decorative. The second hostname keeps the allowlist.

It also called the auth blocker a server-side edit. `js/heights.js`,
`js/lines.js` and `scene.html` sent no key on any `/v1` fetch, so the key moved
to `js/service.js` as `SERVICE_KEY` — it is how you talk to the service, not
how you sync — behind a `serviceHeaders()` helper. `SYNC_KEY` is gone. An
`<img src>` cannot carry a header, so the viewer page fetches the orthophoto as
a blob now.

Two numbers worth keeping. A cold `/v1/tile` pulls **223 MB** of LiDAR (tile
724/724, four sheets), but that is the first tile at a site, not the marginal
one: over a 2×2 km block it amortises to ~106 MB per tile, **~424 MB per km²**,
because a GUGiK sheet is ~562 × 594 m and barely spans more than one tile. And
the box was at **5.2 GB free, 100% full**, or about 12 km² of flying; clearing
caches, re-downloadable weights and 490 `.ply` exports that had a compressed
sibling took it to 87 GB. There is still no eviction policy for `var/laz`.

Cost 70 seconds of `api.topomatch.com`: **`SIGHUP` kills cloudflared 2026.3.0
rather than reloading its config.** Restart it in its pane instead.

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
