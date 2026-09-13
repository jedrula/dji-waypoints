# Planning a capture over five hectares

**Written** 2026-09-11, after Plac Staszica — 785 stills over 5.5 ha, five
reconstruction arms, and two failures that no amount of processing fixed. Every
number here is either measured on that capture or computed from this planner's
own geometry with `tools/`-style scripts. Where a claim is an argument rather
than a measurement it says so.

This is about a **site**, not a subject: a park, a plaza, a block. The planner's
per-object domes are the right answer for a statue in a courtyard and the wrong
answer here — sixteen trees are sixteen domes and no battery.

---

## The short version

| | |
|---|---|
| Grid altitude | 100 m AGL (check the zone first — see Airspace) |
| Passes | nadir −90, oblique −45, **shallow −20 at 40 m**, context ring, surround ring |
| Overlap | 80/70 on the two high grids, **60/40 on the shallow band** |
| Waypoints | ~300, so two DJI Fly missions |
| Flight | ~5.7 km, ~37 min, **three batteries** |
| The one thing people skip | the shallow band. It is worth more than every other addition combined. |

---

## What actually decided the outcome at Staszica

Ranked by how much they moved the result, largest first. Three of the five are
capture-planning decisions and none of them are processing decisions.

1. **Whether a surface was ever photographed from below 40° elevation.**
   31% of ground samples had *zero* such views, and that is the whole reason the
   trees render worse than the photographs look. Nothing in PSNR, track length
   or registered-image count shows it.
2. **Whether the altitude bands chain together.** The walk-height pass at 0–5 m
   registered at 22%. It did not fail for want of proposed pairs — exhaustive
   matching offered all 307,720 and moved the band by three cameras.
3. **Whether the view graph is connected enough per frame.** Below roughly
   10 verified pairs per frame a band dies as a component. Above it, it lives.
4. Matcher choice. Spatial matching from the EXIF GPS: same quality, 41% faster
   SfM, 41% fewer floaters. Free, and worth taking, but it is a tenth of item 1.
5. Trainer capacity. Growth-stop full over dense init: **+0.09 dB for +51%
   primitives**. A null result. Do not spend planning effort here.

**What did not decide it:** resolution (the 12 MP stills cost only decode time),
memory (3.5 GB peak on an 8 GB card), or the choice of feature detector. ALIKED
registered 87 more cameras than SIFT and was *still* the worst arm, because it
welded the mission blocks together at three different scales. Registered-image
count is not a quality metric.

---

## The pass set

Flown in this order, so that if the weather closes in you have lost the least
valuable pass rather than the most.

| # | Pass | Altitude | Gimbal | Overlap | wp | What it is for |
|---|---|---|---|---|---|---|
| 1 | Nadir grid | 100 m | −90° | 80/70 | 72 | The metric backbone. Consistent scale, and the down-angle data a splat needs or it breaks under a low camera. |
| 2 | Oblique cross-grid | 100 m | −45° | 80/70 | 84 | Lines perpendicular to the nadir grid, so the two together give four azimuths. |
| 3 | **Shallow band** | 40 m | **−20°** | **60/40** | 120 | The sides of vertical things. The pass this document exists to argue for. |
| 4 | **Context ring** | 100 m | −24° + −50° | — | 26 | Outward, tight, in the middle. The horizon and the city. |
| 5 | Surround ring | 100 m | −24° | — | ~28 | Outward, at the perimeter. The wide baseline the context ring has not got. |

Total ≈ 300 waypoints, 5.7 km, 37 minutes, three batteries. That is two DJI Fly
missions at the 200-waypoint cap; split on a pass boundary, never mid-leg.

### Why the shallow band, with the numbers

Held the surfaces fixed — sixteen 12 m trees on a lattice across a 235 m square —
and varied only the flight. "Zero low-angle" is the Staszica metric: the share of
vertical surface samples that never appear in a single frame from below 40°
elevation. It is `100 − summary.byKind.wall.low` from `js/coverage.js`, and
`npm run compare` prints its site-wide form as the `low%` column, so every number
in this section is reproducible without leaving the repo.

| Flight | wp | tree-side good% | unseen% | **zero low-angle%** |
|---|---|---|---|---|
| Nadir only | 72 | 66 | 18 | **100** |
| + oblique −45 | 156 | 75 | 18 | **27** |
| + shallow −20 @ 40 m, 80/70 | 591 | 86 | 5 | **5** |
| + shallow −20 @ 40 m, **60/40** | **276** | **84** | **6** | **7** |
| + cross passes @ 40 m | 196 | 76 | 16 | 21 |

Read the fourth row against the third: **dropping the shallow band's overlap from
80/70 to 60/40 costs two points of tree-side coverage and saves 315 waypoints.**
That is the whole reason this band is affordable. It is not a mapping pass and it
does not need mapping overlap — it is there to supply *directions*, and a
direction does not need to be sampled every three metres.

Read it against the last row too: the planner's side-on cross passes, which look
like they should do this job, buy 6 points where the shallow band buys 17. They
fly *through* the site at one altitude and see each thing from two azimuths; the
band sees everything from four, at a useful elevation, for three times the
waypoints.

**Where the band belongs is measured, not chosen.** Same base, band altitude as
the only variable:

| Band | wp | zero low-angle% |
|---|---|---|
| −20° @ 40 m | 120 | **7** |
| −30° @ 60 m | 66 | 17 |
| −20° @ 70 m | 45 | 25 |
| −20° @ 100 m | 28 | **27 — nothing** |

Flown at the grid's own altitude the band does nothing at all. The elevation
angle at the *surface* is what matters, and that is set by altitude and range
together, not by the gimbal. A −20° camera at 100 m looking at a tree 270 m away
is still looking at it from above. **Fly the shallow band low.**

---

## Parallax: what adds it and what does not

Parallax comes from **moving the camera**, never from turning it. A gimbal
rotation about the optical centre adds a viewing *direction* to the frame and
zero baseline to the reconstruction. Both are worth having and they are not the
same thing, and conflating them is how a capture ends up with plenty of frames
and no geometry.

The photogrammetric floor for reliable depth is a **base-to-height ratio of about
0.35**: to triangulate something D metres away you want the two cameras that see
it roughly 0.35·D apart. That single number settles most planning arguments:

| Baseline available | Depth is real out to |
|---|---|
| A tight ring, 40 m across | **114 m** |
| The 5.5 ha site, corner to corner, 235 m | **671 m** |
| Site plus the surround ring's pad, 275 m | **786 m** |

So the Wrocław skyline at 2–5 km sits at B/H 0.05–0.11. **It will never be
geometry.** It lands as a shell at some plausible radius, and the useful thing to
do about that is want it — see the next section — not fight it.

The corollary for the shallow band: its frames are 40 m up and ~110 m out from
what they photograph, and consecutive frames along a leg at 60% overlap are ~50 m
apart. B/H ≈ 0.45. That band triangulates the thing it looks at. The nadir grid
at 100 m with 80% front overlap puts consecutive frames 22 m apart looking 100 m
down: B/H 0.22, which is why a nadir-only block has soft geometry however many
frames it contains.

---

## The context ring

The pass this document adds, and Andrzej's idea: **a tight circle at the ceiling,
in the middle of the site, camera facing out, all the way round.** Cheap — 26
stations, 52 frames, 120 m of flying, two and a half minutes — and it changes
what the result *is*.

Every other pass photographs the middle of the site, so a splat trained on them
alone is a subject floating in a void: fly a camera through it and there is no
horizon, nothing at any distance, and no sense of where you are. The context ring
is the only pass that answers "what is this place next to".

### What it buys, and what it does not

It does **not** buy distant geometry. Two stations on opposite sides of a 40 m
ring look along opposite azimuths and share no view at all; even for stations a
quarter-turn apart the baseline is 28 m, and by the table above that is depth out
to about 80 m and nothing beyond. **The ring is a panorama with a little parallax
in it**, and the honest description of the far field it produces is a backdrop at
roughly constant radius.

It **does** buy three things:

- **Azimuthal completeness at the horizon.** 360° of the skyline, at consistent
  exposure, in two and a half minutes of flying.
- **The mid-distance annulus** — the ground just outside the site, which the
  grids stop at and which every other pass sees only edge-on from the far side.
- **A very strong internal view graph.** Consecutive outward frames overlap
  hugely and match trivially, so the pass never starves. That is the opposite of
  the walk-height pass's problem.

The wide baseline on anything genuinely distant comes from the **surround ring**
at the perimeter and from the grids, which see the same far field from opposite
ends of the site. **Fly both.** The context ring without the perimeter passes is
a panorama that will float.

### The geometry rule, which is not optional

Tilt so the horizon sits just under the top of the frame — 4° of sky, no more.
For the Mini 5 Pro (71.6° × 56.8°) that is a gimbal pitch of **−24.4°**, and it
does not change with altitude: the horizon is at eye level from 5 m and from
100 m alike. Keep the sky out because 3DGS reliably spends its largest gaussians
on it, and those are the floaters.

The bottom of that frame lands on the ground at **0.76 × altitude** from the
aircraft. Which gives the rule:

> A context ring at altitude A and radius r sees no ground closer than
> `0.76·A − r` from the site centre. If that is larger than the site's own
> radius, **the ring photographs nothing the rest of the capture has ever
> seen**, and it will reconstruct as a disconnected component.

| Site radius | Highest context ring that still frames the site (r = 20 m) |
|---|---|
| 15 m (playground) | 46 m |
| 50 m | 92 m |
| 100 m | 158 m |
| 166 m (5.5 ha square) | 245 m |

At 5.5 ha there is no conflict — 100 m is comfortably inside the limit, and the
ring's near edge lands 56 m from centre, well inside the nadir grid. **On a small
site there is a conflict, and the ring must come down.**

### The second shot is the tie-in

Take **two frames at every context station**: the horizon frame at −24.4°, and
a steeper one derived from the ring itself — `atan(altitude / radius) − v/2`,
which is **−50.3°** at 100 m over a 20 m radius. That is the shallowest tilt
whose near edge still falls inside the ring, so it overlaps the nadir grid at one
edge and the horizon frame at the other, from the same optical centre. That is what stitches
the context ring into the rest of the capture rather than leaving it as a
panorama bolted on the side. It costs a gimbal move and a shutter, not a stop.

This is also the general form of the lesson from item 2 at the top: **a band that
does not overlap its neighbours does not join, and no matcher will join it.**

---

## The altitude cliff, and the bridging ramp

Staszica's walk-height flight — 94 frames at 0–6 m — registered 22%, and the
diagnosis is worth repeating because it is counter-intuitive and it cost a day.

A camera at 2 m sees facades, benches and tree trunks. A camera at 36 m pointing
down sees roofs and paving. **They are not looking at the same surfaces**, so
there is nothing to match, and this is not a software problem: hand-picked
ground↔aerial pairs gave SIFT 3–8 inliers and ALIKED+LightGlue 4–7, against
421–560 on ordinary pairs of the same capture. Offering more pairs does not help;
exhaustive matching proved that.

**If you want ground-level detail, fly a ramp.** Climb from 2 m to 25 m over a
couple of hundred metres while tilting the gimbal from horizontal to −45°,
shooting throughout, so that consecutive frames always share surfaces and the
altitude bands chain. One ramp on each of two sides of the site is enough to tie
a ground pass in.

**If you are not going to fly the ramp, do not fly the ground pass.** At Staszica
it cost eleven minutes of matching and returned fourteen registered frames.

---

## Airspace, and what the ceiling really is

The Open category ceiling is 120 m AGL, and this planner's `establishPass` uses
120 as its ceiling constant. **Inside a CTR the real number is lower.** Around
Wrocław, the outer CTR ring (DRA-RH, beyond 6 km from the airport) is 100 m AGL
with a DroneTower check-in and no wait for approval; the inner ring (DRA-RM,
1–6 km) drops to 30 m AGL for sub-900 g aircraft, which is below the grid
altitude this document recommends and changes the whole plan.

**Check DroneTower for the actual site before fixing an altitude**, not after.
The 100 m used throughout here is the DRA-RH figure and is not a general answer.

---

## Exposure, light and timing

Measured on all 785 Staszica frames: 1/1000 s, ISO 100, **0.00% clipped at either
end**, mean level 69/255. The photographs were not the problem — but they were
about a stop darker than they needed to be, and a splat bakes whatever light it
was given.

- **Lock exposure and white balance** before the first mission and do not touch
  them. A capture spanning an hour of changing light reconstructs with a
  warm-to-cool gradient across the site.
- **Shoot a stop brighter** than the meter wants, as long as nothing clips.
  Clipped highlights poison the spherical-harmonics fit and there is no
  recovering them.
- **Fly the missions back to back**, not an hour apart. This is also why the pass
  order above matters.
- **Overcast and low wind.** Moving vegetation is the one subject that violates
  the static-scene assumption everything downstream makes, and hard sun puts
  black shadows under exactly the canopies you are trying to see the sides of.
- Sharpness at Staszica was fine — median variance-of-Laplacian 713 at 1600 px,
  and the nadir grid was the *sharpest* mission of the nine. A 3–6 s shot
  interval sets overlap, not blur. Do not go hunting for motion blur before
  checking the view geometry.

---

## Before you fly

- [ ] DroneTower: what is the actual ceiling here? Re-plan if it is not 100 m.
- [ ] Walk or look at the site: what is the tallest thing, and where?
- [ ] Set the grid altitude, then check the shallow band clears the canopy.
- [ ] Check the context ring rule: `0.76·A − r` smaller than the site radius.
- [ ] Lock exposure and white balance. Single-shot, not timed interval —
      a timed interval wasted 41% of the card on the 28 Aug flight.
- [ ] Batteries: three, charged, and the missions split on pass boundaries.
- [ ] Originals stay on the card until the copy is md5-verified.

## After you fly, before you train

Run `drone_captures/capture_quality.py` on the folder. It reports sharpness,
exposure, gimbal distribution and — the metric that predicted the Staszica tree
failure — **the share of ground samples with zero views below 40° elevation**. If
that number is above about 10%, the vertical surfaces will be soft and no
trainer setting will fix it. Fly the shallow band again before spending GPU time.

Then, after SfM and before believing anything:

- **% of cameras within 5 m of their EXIF GPS.** Healthy arms scored 96–99.7% at
  ~2.4 m median. The arm that welded blocks at three different scales scored
  29.6%, and its PSNR and its renders both looked fine.
- **Per-block scale spread.** One number per mission block, fitted robustly to
  GPS. A healthy capture holds one scale across all of them.
- **Verified pairs per frame, bucketed by altitude.** Below ~10 is a band about
  to die.

None of those three are in `pod.json` yet and all three are cheap.

---

## What this document does not know

- **Whether geometric coverage predicts reconstruction quality.** The scorer in
  `js/coverage.js` measures views, incidence, angular spread and — since this
  document — low-angle coverage, against a proxy.
  It is necessary, not sufficient, and it has never been calibrated against an
  actual trained result. The table in "Why the shallow band" is a coverage
  argument, and the Staszica vegetation finding is the one piece of evidence that
  the metric it is built on corresponds to something real.
- **What the context ring actually reconstructs.** It is now a pass in the
  planner — `context`, on by default, with its own tests — but every claim in
  that section is still geometry and literature. Nobody has flown one. The first one flown should be
  looked at specifically for whether the far field lands as a coherent shell or
  as a cloud of floaters — and the coverage scorer cannot answer that, because it
  scores the subject and this pass points away from it.
- **Thin structures.** Branches, wires, netting. The proxy is boxes and boxes say
  nothing about them, and they are where real captures fail.
- **Trees as subjects.** The whole low-angle argument models a tree as a box with
  four vertical sides. A canopy is not that, and the direction of the error is
  not obvious.
