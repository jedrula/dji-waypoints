# 3DGS Mission Planner — DJI Mini 5 Pro

**Live: https://jedrula.github.io/dji-waypoints/**

Draw a rectangle, get a proposed autonomous capture flight, export it as a KMZ
that DJI Fly can execute. No accounts, no build step, no dependencies.

Works on a phone, which is the point: a laptop has no GPS and positions itself
from cached Wi-Fi scans (measured 32 minutes stale here). A phone has a real
receiver, so **Where I am** actually lands on the subject. On mobile the panel
stacks above the map and the box is sized by typing metres rather than by
dragging.

```
npm start          # http://localhost:8123
npm test           # 175 assertions: geometry, poses, coverage, KMZ read+write, codes, plans, sync, bridge
npm run compare    # score capture configurations against each other
npm run bridge     # what controller can this machine see?
```

**Where I am** puts a 30 m box at your GPS position with an accuracy circle, so
you can plan standing on site. If a box already exists it keeps its size and
just moves.

## What it plans

Gaussian splatting wants many views of each surface from many angles, which a
plain nadir mapping grid does not give you. The proposal is three passes:

| Pass | Camera | Why |
|---|---|---|
| Nadir grid | −90° | metric backbone, consistent scale, and the down-angle data |
| Oblique cross-grid | −45° | lines run perpendicular to the nadir grid, so the two together cover four azimuths |
| Perimeter orbit | aims at subject | rings form a dome around the site; catches facades and edges the grids miss |
| Cross passes | side-on | lines flown *through* the site, camera 90° off travel — the only pass that sees into gaps |

Published capture guidance the pass set follows: every visible surface should
appear in **at least three** overlapping frames; orbit at **three or more
elevations**, not one; vary the **distance** as well as the height; and do not
under-cover the **down angle** — a surface never photographed from above has no
data for that direction and the splat breaks under a low camera.

### Why cross passes exist

An orbit only ever sees a site's outside. Anything tucked between structures, or
facing inward, is occluded from every point on the ring. Cross passes fly lines
through the middle with the camera **90° off the direction of travel**, which is
what gives lateral parallax as you sweep past — a forward-facing camera barely
changes view direction as it advances, so it adds frames without adding
information. The serpentine reverses each line, so one grid covers both flanks,
and running both axes gives four azimuths.

### Where height diversity comes from

**Subject height** drives it, and it defaults to **3 m** — almost everything
worth splatting has height, so flat ground is the unusual case. Drawing a box
and touching nothing else on a 69 x 49 m site gives:

| Height | Waypoints | Tilts | Passes |
|---|---|---|---|
| 17.0 m | 32 | −15.1° | orbit |
| 25.5 m | 32 | −23.8° | orbit |
| 34.0 m | 135 | −90°, −45°, −33.1° | nadir, oblique, orbit |

Set subject height to 0 and the same box collapses to a single 30 m ring,
because over flat ground every pass points down and there is nothing to see
from several elevations.


Only the **orbit** varies altitude. The nadir and oblique grids fly one height
each — conventional, and their diversity comes from tilt and direction. Cross
passes also default to one height, and that was measured rather than assumed:

| Cross-pass levels | Alone | With 2 orbit rings |
|---|---|---|
| 1 | 45% coverage, 9% low walls | 85% low walls |
| 2 | 50% coverage, 12% low walls | 85% low walls |
| 3 | 54% coverage, 14% low walls | — |

On their own, extra levels help. Alongside a multi-ring orbit they are
redundant: the low ring already flies near-horizontal and sees the bottoms of
things from 360°, so a second cross-pass height buys 0.2 extra views per low
wall sample. `transectLevels` exists in the planner if you want it; it is not
in the UI because there is no configuration a person would actually fly where
it earns its waypoints.

### Why the orbit is a dome

Multi-ring orbits pull in as they rise, holding a constant slant range to the
subject. That keeps framing and ground resolution even across rings, and sweeps
the tilt from near-level at the bottom to a real down-angle at the top. Frames
per ring are bounded to a 7.5–15° step: past that, extra density adds almost
nothing while starving the waypoint budget that another ring would spend far
better.

Line spacing comes from the real footprint of the Mini 5 Pro's camera (24 mm
equiv → 71.6° × 56.8° FOV) at the chosen altitude, times `1 − overlap`.

## Seeing the plan

The map shows the flight path with **live dimensions** on the box while you drag
it, plus a short tick at each station showing where that camera looks — the tick
is a stub for a nadir shot and full length for a horizontal one.

Three basemaps under the Map/Split/3D tabs, and the choice sticks: **Satellite** to
see the actual roof or slab you are planning against, **Streets** to find the
place at all — imagery has no labels, and one courtyard looks much like another
— and **Topo** to see whether the ground under the flight is flat. All three are
Esri, so no API key and no second attribution.

The **3D view** (top-right toggle) is the one that matters once a plan uses more
than one altitude: multi-ring orbits, or comparing pass heights. It draws the
ground grid, the box, the path coloured by pass, and a frustum wedge per camera
so you can see what each shot actually frames. Drag to orbit, scroll to zoom.
**Split** puts the map and the 3D side by side — "where" and "at what height"
come up together often enough that switching tabs between them is the annoying
part. Drag the divider to give either side more room (double-click to even it
up); where you leave it is remembered. Squeeze the map past the width of its own
floating controls and the basemap picker hides rather than landing on the zoom
buttons. On a phone the two stack instead of splitting, because half a phone
screen is not a map, and the divider moves up and down.

An **altitude scale** stands at whichever box corner currently projects furthest
left, ticked at every height the mission flies and labelled with what is up
there — `34 m nadir + oblique + cross + orbit`, `26 m orbit · −24°`,
`17 m orbit · −15°`. The labels are pinned to the left margin rather than hung
off the mast, so orbiting slides the leader lines and leaves the text where you
last read it, and the mast only hops to another corner when that corner is
clearly better.

**Drag a level to move it.** Each labelled height has a grip; pull it up or down
and the plan replans live. The height the grids fly at *is* the altitude, so
dragging that one moves the altitude slider and everything derived from it
follows; dragging a single orbit ring or cross-pass level pins just that one and
leaves the rest of the spread alone. Pinned heights ride along in the plan code,
so a dragged plan reproduces exactly on the other device. Touching any slider —
or an auto-fit — drops the pins and returns the derived spread, which is also
the way back out.
It is a hand-rolled canvas renderer — a few thousand line segments did not
justify pulling in a 3D library.

## Aiming the orbit

The orbit tilt is derived, never hardcoded: it aims at the **middle of the
subject**, so it self-corrects across scales. Set **Subject height** to roughly
how tall the thing you are capturing is.

| Situation | Altitude | Subject height | Resulting tilt |
|---|---|---|---|
| Flat area from above | 55 m | 0 m | −31° |
| Playground equipment | 5 m | 3 m | −13° |
| Same, lower ring | 3 m | 3 m | −5.7° |

That last row is the point: close to a subject with real height, the camera
wants to be near horizontal. Nadir at 3 m sees a 4 m strip of ground and the
tops of things — almost nothing usable for splatting.

## The 200-waypoint problem

DJI Fly refuses missions over 200 waypoints, and a three-pass plan at 40 m blows
past that over anything larger than a courtyard. So drawing a box runs a search
for the **lowest altitude (best GSD) that fits both 200 waypoints and one
battery** and proposes that. Every slider then overrides it; the waypoint counter
turns red when you go over, and an over-budget plan exports as numbered parts you
fly back to back.

Two shutter modes:

- **One waypoint per photo** — a `takePhoto` action at every station. Maximum
  compatibility, burns the waypoint budget fast.
- **Distance interval** — waypoints only at the grid turns plus one
  `multipleDistance` trigger for the whole route. ~10× fewer waypoints. Fewer
  DJI Fly builds are confirmed to honour this, so check the first flight.

## Scoring coverage before you fly

`js/coverage.js` scores a plan geometrically: it builds a rough proxy of the
site, samples every surface, and works out how many cameras actually see each
sample, from how wide a spread of directions, and whether any of them is from
above. That answers most capture questions without rendering a frame or
training a splat.

The 3D view shows it as a heat map — green good, yellow enough views but no
parallax, orange fewer than three views, red never seen — and the review panel
carries **Coverage** and **Down-angle** percentages.

```
npm run compare                      # 25x17 m site, 3 m subject, 7 m orbit
npm run compare -- 60 40 6 12        # width depth subjectHeight altitude
```

`tools/compare.mjs` scores a dozen configurations side by side and prints the
marginal value of each addition. Measured on a 25 x 17 m site with 3 m
structures:

| Addition | Cost | Coverage | Down-angle |
|---|---|---|---|
| 1 → 2 rings | +48 wp | +7.1 | +2.7 |
| 2 → 3 rings | +48 wp | +0.5 | +2.6 |
| 3 → 4 rings | +48 wp | +0.8 | +0.0 |
| 4 → 5 rings | +48 wp | +0.0 | +1.3 |
| add cross passes | +48 wp | +3.8 | +15.6 |
| add nadir grid | +130 wp | +5.5 | **+56.8** |
| 1 → 3 frames per stop | **+0 wp** | +6.5 | +16.5 |

Three things fall out of that. Rings past the second are nearly free of value.
The **frame fan is the best buy in the table** — it costs no waypoints because
the extra frames live in one waypoint's action group, and it converts surfaces
that were outside the frustum into seen ones. And the **nadir grid is the only
thing that fixes the down angle**; no amount of orbiting substitutes.

It scores coverage, not reconstruction quality. Coverage is necessary but not
sufficient — a well-covered surface still reconstructs badly if it is
textureless or moving, and the box proxy does not model the thin structures
(chains, bars, netting) where real captures usually fail.

## Saved plans, and sync between devices

Plans are saved by name in the browser, and a plan is only its code, so the
whole library is a few kilobytes. **Saved plans** at the top of the panel: name
it, Save, Load it back later. That alone needs no server and no account.

Sync adds the other device, and there is nothing to set up: no login, no key to
copy. Every device runs under one **sync key** hardcoded in `js/plans.js`, and
saving syncs by itself — save on the phone, open the panel on the Mac, the plan
is there. The Sync button is only for a page that was already open. Both devices
push to `sync/worker.js` on Cloudflare, which namespaces storage by the key's
SHA-256 — what is stored cannot be turned back into a key. Merging is
last-write-wins per plan id, with deletions as timestamped tombstones so
removing a plan on the phone removes it on the Mac. Client and Worker run the
same merge on purpose.

The key ships in a public app, so it is a name and not a secret: anyone reading
the source can read and write that plan list. For one person's saved boxes that
is the right trade against copying a key between devices. When there is more
than one person, the key becomes the user id and a real login goes in front of
the same storage; nothing about the shape has to change.

    cd sync && wrangler dev --local    # KV in a local emulator, no account
    wrangler kv namespace create PLANS # then put the id in wrangler.toml
    wrangler deploy

Set `SYNC_URL` in `js/plans.js` to the deployed URL, or `dji.syncUrl` in
localStorage to point one browser somewhere else. With neither, the app says so
and stays local-only.

## Phone, controller, MacBook

The three devices each hold one piece and none of them talk: the phone has a
real GNSS receiver and knows where you are standing, the controller has the
mission folder, and only the MacBook can reach that folder over USB. The KMZ
does not have to make that trip, though — a plan is deterministic, so the same
box and settings rebuild the same file anywhere. What travels is a **plan code**:

```
v1.eyJyIjpbNTAuMDYzNzcsNTAuMDYyNzYsMTkuOTMyNDIsMTku…      (~200 characters)
```

1. On the phone, on site: **Where I am**, size the box, adjust.
2. **Copy plan link** — it copies a link and mirrors it into the page's URL, so
   AirDrop, Messages, or Notes all carry it.
3. On the MacBook: paste it into **Paste a plan code** in step 1, or open the
   link. The box, every slider, the passes and the profile come back exactly.
4. Install onto the controller from step 4.

The code carries the box corners to six decimals (about 10 cm) and the raw
control values rather than derived ones, so a restored plan is the same plan and
not a near miss. The test suite plans both ends and checks the waypoint counts
match.

If a KMZ reaches the Mac some other way — AirDropped from the phone, exported
last week, sent by someone else — step 4 takes a file directly instead of the
current plan.

Why not just point the phone at the Mac's dev server over Wi-Fi? Because browser
geolocation needs a secure context, and `http://192.168.x.x:8123` is not one, so
the phone would lose the only thing it was brought along for.

## Installing onto the controller

DJI Fly has no import button, and on a controller with its own screen there is
no iPhone Files app to fall back on. Step **4 Install** in the panel does the
copy-rename-overwrite dance over `adb`, and shows the trade before it commits:

```
Planned mission            A1B2C3D4…0002
67 wp · 120 m · 3 passes → replaces 52 wp from 26 Aug, 12:00
```

It is deliberately not one click. Installing destroys a mission that is already
on the controller, so the panel lists every mission folder with its waypoint
count and date, you pick the one to lose, and the replaced file is copied to
`backups/` before anything is written. A KMZ that fails `check.mjs` is refused
rather than written, because a bad file does not fail visibly in DJI Fly — the
mission simply will not open, and you find out on site.

**View** next to a slot draws what is actually in it on the map — white dashes
over your plan — with its waypoint count, heights and drone enum. Overwriting is
destructive, so seeing the route you are about to replace is worth more than
reading the number of waypoints in it. `js/kmzread.js` does the reading:
central-directory zip parsing plus `DecompressionStream`, so a KMZ that DJI Fly
deflated opens in the browser with no dependency and no build step.

The `⤓` next to a slot pulls that mission back off the controller. A mission
DJI Fly wrote itself is the reference that settles what this aircraft expects:

```
npm run check -- ours.kmz pulled-from-controller.kmz
```

One-time setup: `brew install libmtp pkg-config`, and make a few throwaway
waypoint missions in DJI Fly. DJI Fly only lists folders it created itself, so
those throwaways are the slots — there is no way to add a mission, only to
overwrite one. A multi-part plan takes as many consecutive slots as it has
parts. Waypoint is a flight mode, so creating a dummy needs the aircraft
powered on and linked; you do not have to fly it.

Transports, in the order they are tried: **MTP** (a DJI RC), then any `adb`
device, then `Android/data/dji.go.v5/files/waypoint` under `/Volumes` (an SD
card or a mount), then `BRIDGE_DIR` if you set it. The API is loopback-only, so
planning from a phone against this server works but installing does not
(`BRIDGE_ALLOW_LAN=1` if you want it to).

### Why MTP, and why a C file in a repo with no build step

**adb does not work on a DJI RC 2 and never will.** Published work on this
controller (KATMAI, Android 11, Qualcomm QCS5430) found the adb interface held
offline, with key injection, wireless pairing, property toggles and reboot
flows all refused; root needed boot-image patching. The RC does expose a USB
still-image interface — class 6, subclass 1, which is MTP — and DJI leaves
`/Android/data` browsable through it.

Two things stand between that and a working install, and both cost more time to
rediscover than to write down:

**macOS hands the device to Image Capture.** `ptpcamerad` claims any still-image
USB device the moment it is plugged in, and libmtp then gets `LIBMTP PANIC:
Unable to initialize device` from a failed `libusb_claim_interface`. It is
launchd-managed and respawns instantly, so the fix is to kill it immediately
before each MTP command rather than once up front. That is what
`shooAwayImageCapture()` does, and it is the entire reason a controller that
"cannot connect" suddenly can.

**libmtp's own CLI cannot write into a folder.** `mtp-sendfile` takes no parent,
so it aims at the storage root with storage id 0, and the RC answers
`get_suggested_storage_id(): could not get storage id from parent id`. Worse,
MTP object handles are per-session: a folder id read in one process is an
Invalid Object Handle in the next, so resolving a path and writing to it have to
happen inside one connection. `tools/mtptool.c` is fifty lines against the same
library that does exactly that — `ls`, `get`, `put`, `rm`, one session, path
resolved a level at a time. `tools/bridge.mjs` compiles it on demand and
recompiles when the source changes.

`tools/install.mjs` is the same thing from the command line.

## Checking a KMZ

```
npm run check -- mission.kmz                    # validate
npm run check -- mission.kmz from-dji-fly.kmz   # validate + diff against a real DJI file
```

`test/fixtures/dji-fly-mini5pro.kmz` is a two-waypoint mission created in DJI
Fly on a Mini 5 Pro and pulled off the controller. It is the reference for what
the aircraft actually writes, and the suite asserts the validator accepts it —
it did not, at first. DJI omits `takeOffSecurityHeight` entirely and numbers
action ids from 1, both of which the validator called errors, so it would have
refused a mission the drone itself produced. It also confirms the one value
nobody could verify from documentation: **DJI Fly on a Mini 5 Pro writes
`droneEnumValue` 68, `droneSubEnumValue` 0** — the same pair this planner
exports.

The validator enforces the WPML spec: required elements, enum values, speed and
gimbal ranges, contiguous waypoint indices, unique increasing action ids, action-group ranges
inside the folder, POI coordinates. It reads deflated archives, so you can point
it at a KMZ **DJI Fly generated itself** — and the second argument diffs the two
element vocabularies, which is the only way to find out what DJI includes that
this does not, short of flying it.

## Loading it onto the drone

DJI Fly has no import button. A mission lives as `waypoint/<UUID>/<UUID>.kmz`
and the app only shows folders it created itself, so installing means
overwriting the file inside an existing folder. `tools/install.mjs` does that
without any UUID typing:

```
npm run slots -- --dest /Volumes/<RC>/Android/data/dji.go.v5/files/waypoint
npm run install-mission -- mission.kmz --dest <that path>
npm run install-mission -- part1.kmz part2.kmz --dest <path>   # one slot each
npm run install-mission -- mission.kmz --adb                   # over adb instead
npm run install-mission -- mission.kmz --rename-only -o out/   # just prepare folders
```

With no `--dest` it looks for the waypoint folder under `/Volumes`, then falls
back to adb. It **validates before writing** and refuses anything with errors,
**backs up whatever it replaces** into `./backups/`, and asks before overwriting
unless you pass `--yes`.

You still have to create a throwaway waypoint mission in DJI Fly first — that is
what makes the folder. Restart DJI Fly after installing. On iOS the path is
`DJI Fly/wayline_mission/`.

## Format notes

`wpmz/waylines.wpml` is what the aircraft executes; `wpmz/template.kml` is
ignored by DJI Fly but the KMZ is rejected without it. Two details separate a
DJI Fly file from the enterprise/Pilot 2 files the public spec documents:

- namespace `http://www.uav.com/wpmz/1.0.2`, **not** `www.dji.com`
- `<wpml:author>fly</wpml:author>`, `droneEnumValue` 68 / sub 0

`droneEnumValue` 68 is what DJI Fly writes on the Mini 4 Pro; DJI publishes no
enum for consumer drones. If the Mini 5 Pro turns out to use a different value,
unzip a mission DJI Fly generated itself and change `PROFILES` in `js/wpml.js`.

## Layout

```
js/geo.js       local ENU frame, distances, bearings
js/camera.js    FOV / footprint / GSD from 35mm-equivalent focal length
js/planner.js   pass generation, auto-fit search, 200-waypoint splitting
js/wpml.js      template.kml + waylines.wpml + KMZ assembly
js/zip.js       store-only ZIP writer (a KMZ is a zip)
js/coverage.js  proxy site, surface sampling, visibility and occlusion scoring
js/view3d.js    hand-rolled canvas 3D view with camera frustums + coverage heat map
js/app.js       map, rectangle drawing, wiring
tools/unzip.mjs minimal zip reader (store + deflate) so DJI's own files open
tools/xml.mjs   minimal XML reader
tools/check.mjs WPML validator and structural diff
tools/install.mjs   install into DJI Fly's waypoint folder, with backups
tools/compare.mjs   score capture configurations against each other
tools/serve.mjs     no-cache dev server (stale ES modules are a nasty trap)
test/run.mjs    geometry, coverage, poses, KMZ structure, validator rules
```
