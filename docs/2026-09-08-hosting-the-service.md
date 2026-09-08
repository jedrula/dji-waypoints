# Hosting `server/` — what was written, and what was actually true

**Written** 2026-09-08 as a ticket for the home Linux box. **Done** the same
day. Kept because most of it is still the reasoning, and because two of its
central assumptions were wrong in ways worth recording.

`server/` is live at **https://drone.topomatch.com**.

## What it runs on

A second hostname on the Cloudflare tunnel that already fronts
`api.topomatch.com` — the *same* tunnel and the same connector, one more
`ingress:` entry in `~/.cloudflared/config.yml` and one DNS record on a zone we
already own. Not a second tunnel, and nothing to pay for.

The service itself is pane 8 of `topomatch-orchestration/start-dev.sh`, next to
the pane that starts the tunnel. That script kills and recreates its whole tmux
session on every run, so re-running it drops this service for a few seconds —
already true of `api.topomatch.com`, which the same script has always owned.

`DATA_DIR` is unset, so data lands in `server/var`. There is exactly one volume
on that box; pointing the knob at another path on the same disk would have been
ceremony.

## The ticket said nginx. There is no nginx.

It claimed "nginx already terminating TLS in front of several other services".
Nothing on that box has nginx installed, and the string appears nowhere in its
work tree except in this file. Services there are reached through the tunnel,
and the tunnel's origin is a **FastAPI gateway on :8000** that proxies by path
prefix to :8001, :8002, :8080 and :8009. That is the reverse proxy; it is just
not the one the ticket imagined.

So the ticket's whole nginx section — `proxy_read_timeout`, `auth_request`, the
warning about a second `Access-Control-Allow-Origin` — was answering a question
nobody had. Two of its conclusions survive translated:

- **Do not hold a multi-minute request open.** Cloudflare cuts an origin
  response at ~100 s, so a cold `/v1/tile?wait=1` cannot work through the
  tunnel. The client never sends `wait=1`; it polls the 202. The viewer page
  does send it, and a cold scene through the tunnel will be cut off.
- **CORS still must not be set twice.** Which is why the gateway was measured
  rather than assumed, below.

## Why it is not behind the gateway on :8000

Following the box's own pattern — a `/heights` prefix proxied to :8130 — was
the obvious move and was rejected on a measurement. Replicating the gateway's
exact shape (`CORSMiddleware(allow_origins=["*"])` plus a proxy that relays the
upstream's response headers) in front of the real service:

    through the gateway shape:  access-control-allow-origin: *
    the second hostname:        access-control-allow-origin: https://jedrula.github.io

There is no duplicate header — Starlette's middleware *overwrites* rather than
appends, so the browsers-reject-both failure never happens. What happens
instead is quieter: `ORIGIN_OK` in `server/src/server.js` becomes decorative,
because every response claims `*` whatever the origin sent. The sync routes
still refuse a bad origin server-side, so it is the `/v1/*` reads that open up.

`X-Sync-Key` does survive the gateway hop, for the record — it strips only
hop-by-hop headers and `host`.

## The blocker, and the half of it the ticket missed

Only `POST /sync` and `/obstacles` checked the key; every `/v1/*` route was
open. Fixed by lifting the check above the route table, with the duplicated
copy inside the list routes deleted.

The ticket presented this as a server-side edit. It was not: `js/heights.js`
and `js/lines.js` sent no key at all on their four `/v1` fetches, and neither
did `server/public/scene.html`. So the key moved to `js/service.js` — it is how
you talk to the service, not how you sync — as `SERVICE_KEY` plus a
`serviceHeaders()` helper that every call site now uses. `SYNC_KEY` and its
re-export through `plans.js` are gone.

Two things fell out of doing it:

- **The viewer page is exempt**, because a browser navigating to a URL cannot
  send a header. It reads no LiDAR; its own fetches are gated like everything
  else.
- **`<img src>` cannot carry a header either.** `scene.html` pulled the
  orthophoto that way, so it now fetches the JPEG as a blob and loads the
  object URL. The WMTS tiles it fetches from GUGiK are a third party and stay a
  plain `<img>`.

The check is on the *shape* of the header, `[A-Za-z0-9_-]{16,128}`, never a
value — there is no list of valid keys, and for the two lists the key is also
the name the records are stored under. A key inside a public app is a name, not
a secret.

## Disk: the ticket's numbers were per-visit, not per-tile

It said "~67 MB each" and 1.8 GB of `var/laz` on the dev laptop. Measured by
`HEAD` on tile 724/724 (central Wrocław) on 2026-09-08:

    51.2 MB  52.1 MB  60.0 MB  59.9 MB   = 223 MB for ONE 500 m tile, 4 sheets

But that is the *first* tile at a fresh site, not the marginal cost of the next
one. Over a 4×4 block of tiles — 2×2 km — the union is 25 distinct sheets and
1695 MB, so:

    ~106 MB per 500 m tile, amortised
    ~424 MB per km²

A GUGiK sheet is ~562 × 594 m, barely larger than a height tile, so there is
much less reuse between neighbours than "one download serves many tiles" would
suggest. Size the disk on the km² you expect to fly, not on tile count.

The box was at **5.2 GB free of 582 GB, one volume, 100% used** when this
started — about 12 km² of flying. Clearing caches, re-downloadable model
weights, and 490 `.ply` splat exports that had a compressed sibling took it to
**87 GB free**, or roughly 200 km².

**Still open: there is no eviction policy.** `var/laz` grows with wherever you
fly and nothing ever deletes it, because `src/scene.js` re-reads the point
cloud to build the rough model. 87 GB is a reprieve, not a decision. The
choices remain: leave it and watch, a timer that deletes `var/laz` files older
than N days (costing a re-download, never correctness), or drop the scene
feature and stop keeping LAZ at all — which would take `var/` down to
megabytes, since nothing but the viewer page consumes `/v1/scene`.

## Operational note, learned the hard way

**`SIGHUP` does not reload cloudflared 2026.3.0 — it kills it.** Sending one to
pick up the new ingress rule took `api.topomatch.com` down for 70 seconds. To
change ingress, restart the process in its tmux pane; there is no reload.

## Data

**There was none to migrate, deliberately.** The Cloudflare KV store's 5 junk
records and 795 tombstones were abandoned. The lists started empty.

## Verified

- Both suites pass; four tests added covering the gate, including that the
  viewer page loads without a key.
- Over the public hostname: `/v1/health` 401 unkeyed and 200 keyed, TLS valid,
  HTTP/2, `access-control-allow-origin: https://jedrula.github.io` (not `*`),
  `/v1/coverage` reaching GUGiK, and `POST /obstacles` round-tripping.

## Related

- `server/README.md` — what the service is, the LiDAR and BDOT details.
- `README.md`, "Saved plans, and sync between devices".
