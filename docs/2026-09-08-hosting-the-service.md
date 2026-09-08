# Ticket: host `server/` on the home Linux box

**Written** 2026-09-08. **For** whoever picks this up on the home server —
Linux, nginx already terminating TLS in front of several other services.

## What this is

`server/` is the one backend this app has. It does four jobs:

| route | what it does |
|---|---|
| `GET /v1/tile/{tn}/{te}` | a normalised height model tile, 500 m square, one byte per m² |
| `GET /v1/height`, `/v1/coverage` | one height, and what the survey covers |
| `GET /v1/lines/{tn}/{te}` | overhead power lines from BDOT10k |
| `GET /v1/scene/{tn}/{te}` | a rough textured 3D model of the ground |
| `POST /sync`, `POST /obstacles` | the two synced lists — saved plans, and marked obstacles |
| `GET /v1/health` | tile geometry, so the client never hardcodes it |

Plain Node `http.createServer`, ES modules, no build step, one dependency
(`laz-perf`). `node >= 20`. Entry point `server/src/server.js`; `npm start`.

It used to be two backends: a Cloudflare Worker held the two lists. The Worker
is deleted (commit `8f29dbe`) because this service already spoke its protocol
byte for byte. Do not bring it back.

## Why hosting it matters

The app is at <https://jedrula.github.io/dji-waypoints/>. `js/service.js`
resolves the service address to `http://localhost:8130` only when the *page*
itself is local, and to empty otherwise — so **the deployed app has no service
at all today**. Two consequences, both fixed by the same deploy:

- Imported obstacle heights are never measured. They stay per-class guesses,
  marked with a `~`. On a laptop with the service running they get measured
  from GUGiK LiDAR; on the live site they never do.
- No sync between devices. Every list is local-first, so nothing is lost, but
  the phone and the Mac no longer share anything.

## Blocker: the data routes are unauthenticated

**Do this before exposing it.** Only `POST /sync` and `POST /obstacles` check
the `X-Sync-Key` header (`server/src/server.js`, the `LISTS[url.pathname]`
branch). Every `/v1/*` route is open.

That matters more than it looks. A `/v1/tile` miss makes the service download
**~67 MB of LAZ from GUGiK**, the Polish national mapping agency. From
`server/src/gugik.js`:

> GUGiK is a public agency doing us a favour. Two downloads at a time, and
> every byte kept, so a busy day costs them a few hundred requests and not a
> few hundred thousand.

A public URL with no key on that route is an open pipe pointed at a government
agency, and `BUILD_CONCURRENCY` (default 2) only paces it. CORS does not help:
`ORIGIN_OK` restricts what a *browser* may read, not what `curl` may ask for.

The fix is the check the sync routes already do — lift it above the route table
so it covers everything, or nginx `auth_request`/a header check in the server
block. Note the key is `SYNC_KEY` in `js/synced.js` and ships inside a public
app, so it is a name, not a secret: it stops casual abuse and crawlers, not
someone who reads the source. That is the same trade the lists already make. If
you want more than that, the honest version is a real credential in nginx and
the app asking for it once.

## Shape of the deploy

Everything below is a suggestion from reading the code, not something that has
been run.

**Disk is the thing to think about.** Measured on the dev laptop:

    var/laz     1.8 GB   27 raw LAZ files, ~67 MB each   <- the GUGiK cache
    var/bdot     94 MB   powiat packages for the lines
    var/scene   2.6 MB
    var/tile    1.1 MB   30 built tiles, ~37 KB each     <- what clients fetch
    var/ortho   964 KB

67 MB in, 37 KB out. The raw LAZ is kept on purpose — `src/scene.js` re-reads
the point cloud to build the 3D model — so it is earned, but it means the
volume grows with wherever you fly and has **no eviction policy**. Decide one:
a big enough disk and leave it, a cron that deletes `var/laz` files older than
N days (rebuilding costs a download, not correctness), or drop the scene
feature and stop keeping LAZ at all. Do not put `var/` on a small root volume.

**Config.** `PORT`, `DATA_DIR`, `BUILD_CONCURRENCY` are the only knobs
(`server/src/server.js` top). `DATA_DIR` should point at the big disk.

**systemd + nginx.** A normal unit — `WorkingDirectory=.../server`,
`ExecStart=/usr/bin/node src/server.js`, `Environment=DATA_DIR=/srv/dji/var`,
`Restart=always`, a dedicated user that owns `DATA_DIR`. Then a server block
proxying to `127.0.0.1:8130`. Two things to get right:

- **Timeouts.** A cold `/v1/tile` with `?wait=1` blocks while four LAZ files
  come down from GUGiK — minutes, not seconds. nginx's default
  `proxy_read_timeout 60s` will cut it. Either raise it well past that on the
  `/v1/tile` location, or leave the default and rely on the client's polling
  path: a tile that is not built yet answers `202` and the client keeps asking
  (`js/heights.js`, `fetchTile`, 150 s budget per tile). The polling path is
  the better answer — do not make nginx hold a multi-minute request.
- **Do not touch CORS in nginx.** The service sets its own headers and checks
  `Origin` against `ORIGIN_OK`. A second `Access-Control-Allow-Origin` from
  nginx gives browsers two values and they reject both.

**CORS is already right for the live app.** `ORIGIN_OK` in
`server/src/server.js:236` allows `https://*.github.io` plus localhost. If the
app also ends up served from your own domain, that regex needs the new origin.

**TLS is required, not optional.** The app is served over HTTPS, so a plain
`http://` service is blocked as mixed content. nginx is already doing this for
other services here, which is most of why this box is the right home.

## Turning it on, once it is up

One line: `DEFAULT_URL` in `js/service.js` → the public address. That is the
whole client change, for heights and sync together. Test it first without
touching the source by setting `localStorage['dji.serviceUrl']` in the browser
on the live site — if measured heights start appearing and the `~` marks come
off, it works.

Then deploy the app: GitHub Pages serves `main` from `/`, so it is a
fast-forward and a push. Pages sends `cache-control: max-age=600`, so give it
ten minutes or hard-reload.

## Data

**There is none to migrate, deliberately.** Andrzej: *"i dont care about any
data! if we change architecture we can by lossy"*. The Cloudflare KV store
still holds 5 junk records (imported OSM buildings that leaked into sync from a
build predating `local: isImported`) and 795 tombstones; all of it is being
abandoned. The lists start empty. Do not write a migration.

## Checks before you call it done

- `cd server && npm test` — includes `sync over HTTP`, which starts the real
  server on an ephemeral port and exercises the route contract.
- From another machine: `curl -i https://.../v1/health` returns the tile
  geometry, and the same URL **without** the key on a `/v1/tile` request is
  refused once the blocker above is fixed.
- On the live site with `dji.serviceUrl` set: import obstacles somewhere in
  Poland and confirm the toast says *"N measured"* and that `~` marks come off.
- Watch `var/` size after a few imports and confirm the eviction decision you
  made is actually in place.

## Related

- `server/README.md` — what the service is, the LiDAR and BDOT details, and
  what GUGiK actually publishes.
- `README.md`, "Saved plans, and sync between devices" — the sync protocol and
  why the second backend went away.
- `CLAUDE.md` — how work is done in this repo. Relevant here: no backward
  compatibility, measure before claiming, and degrade to yesterday's behaviour
  rather than to a wrong answer.
