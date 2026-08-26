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
npm test           # 125 assertions: geometry, poses, coverage, KMZ, validator
npm run compare    # score capture configurations against each other
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

The **3D view** (top-right toggle) is the one that matters once a plan uses more
than one altitude: multi-ring orbits, or comparing pass heights. It draws the
ground grid, the box, the path coloured by pass, and a frustum wedge per camera
so you can see what each shot actually frames. Drag to orbit, scroll to zoom.
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

## Checking a KMZ

```
npm run check -- mission.kmz                    # validate
npm run check -- mission.kmz from-dji-fly.kmz   # validate + diff against a real DJI file
```

The validator enforces the WPML spec: required elements, enum values, speed and
gimbal ranges, contiguous waypoint indices and action ids, action-group ranges
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
