# Plan to a battery budget, and say what it bought

**Written** 2026-09-11, after planning Park Staszica by hand eleven different
ways in one session. Andrzej, at the end of it:

> in the long run if this works out i think this is how we wanna proceed — we
> will want to select some area, get suggested battery budget needed for that
> and then plan according to that budget. sth like that. i mean you say — i got
> 2 batteries and i want this captured and you get a plan and maybe a note if
> its under captured or maybe that you dont even need 2 batteries for such thing

That is the whole idea and it is worth writing down while the evidence for it
is fresh, because the evidence is this session: every number below was measured
against 4.4 ha of Wroclaw and the national LiDAR over it, not reasoned about.

## What the app asks for today, and what it should ask for

Today: a site, an altitude, overlaps, a speed, a ring count, a shutter mode,
and six pass checkboxes. Auto-fit then searches altitude and rings for
something that fits ONE battery and DJI Fly's 200 waypoints.

What a person actually brings is a place and how many batteries are in the bag.
Everything else in the list above fell out of those two over Staszica — and
where it did not fall out, it fell out of the survey. Nobody chose 36 m; the
tallest measured tree is 26 m and 10 m is the margin worth holding. Nobody
chose 4.4 m/s; 75% front overlap at 36 m puts a frame every 9.7 m and the
camera will not sustain better than about 2.2 s between 50 MP frames.

So: pick the area, say how many batteries, get an ordered set of missions and a
sentence about what that budget bought.

## The three things a budget search has to know, which today's auto-fit does not

**1. More batteries buy altitude by SPLITTING passes, not by flying longer.**
This was the surprise. One battery over the park forces 48 m, because the nadir
and the oblique grid both have to fit in one flight. Give each its own battery
and the same site flies at 36 m:

    1 battery    48 m   0.85 cm/px   427 photos
    2 batteries  38 m   0.67 cm/px   603 photos   (nadir | oblique)
    3 batteries  36 m   0.63 cm/px   690 photos + 4 domes

Nothing in the app can express that, because the unit is one plan = one
mission, and splitMission only cuts on the waypoint cap.

**2. Lower is slower, twice over.** Overlap is a fraction of the footprint, so
dropping the altitude tightens the shot spacing, which caps the speed, which
lengthens the flight on top of the extra lines. Measured, whole park,
cadence held at 2.2 s:

    alt   gsd     max speed   nadir     oblique
    30 m  0.53    3.7 m/s     17.9 min  18.0 min
    36 m  0.63    4.4 m/s     12.8 min  12.5 min
    48 m  0.85    5.9 m/s      7.5 min   7.5 min

Below about 34 m the flight grows faster than the resolution improves. A budget
search has to carry the shutter cadence as a constraint alongside waypoints and
minutes -- it decided every altitude in this session and it is invisible in the
UI.

**3. The floor is the survey, not the slider.** 26 m of tree, 10 m of margin,
and a 1.6 m relief across the whole park (GUGiK NMT) so one barometric altitude
is honest here. On a sloped site it would not be, and the search has to know
the difference.

## The verdict is half the feature

A plan that fits is not the same as a plan worth flying, and the app already
holds the number that says so and never says it. Every grid-only configuration
over this park scored **0% on low surfaces** -- the two pitches are -90 and -45,
so trunks, benches, the undersides of crowns and the ground between them are
seen by nothing. Adding one 12 m ring in a clearing takes that patch to 100%
walls and 28 mean views. That is exactly "under-captured", and it was sitting
in `scoreCoverage`'s output being ignored by a human four times in a row.

Sentences the search should be able to write:

- *"2 batteries: whole park at 0.67 cm/px, nadir and oblique. No near-horizontal
  views anywhere -- low surfaces 0%. A third battery buys four low rings."*
- *"1 battery is enough for this: 0.6 cm/px over 0.8 ha with room to spare.
  Two would mean flying the same lines twice."*
- *"3 batteries asked, 2 used. The third would add 11 minutes of rings over
  ground the grids already cover from four angles."*

## What the budget must not quietly leave out

Planned mission time is not battery time. Over Staszica the honest arithmetic
per battery was ~15.5 minutes planned, leaving about 3 for climb, transit to
the first waypoint and RTH. And a battery holding several domes needs a manual
hop above the canopy between them, because each mission's
`takeOffSecurityHeight` is derived from its own altitude and comes out at 20 m
under a 26 m canopy. Both belong in the estimate rather than in a message
somebody wrote afterwards.

## The shape of it, smallest first

1. **A capture is the saved unit**: one site, one budget, an ordered list of
   missions. The Plans pane already groups by the name before the first "·" and
   draws the whole set on the map and in both 3D views; what it cannot do is
   produce one.
2. **The budget search**: widen proposePlan from "does this fit one flight" to
   "how do I spend N flights", with splitting passes across batteries as the
   first lever and the shutter cadence as a hard constraint.
3. **The verdict**, from the scorer the repo already has, in the sentences
   above.
4. **Dome siting from the survey.** The four low-ring sites in this park were
   found with a scratchpad script over the same nDSM tile the app downloads:
   every disc that can hold a ring with nothing tall under it. 189 m2 of 43,500
   qualify at 12 m radius -- not something anyone finds by eye on imagery, and
   the low rings are where the capture's richness turned out to be.

One trap found the hard way, twice: **the ring radius is not a constant.**
`objectPass` sets it from the camera's framing distance, which grows with the
tap height, so a screen over a fixed disc promises nothing -- a 12 m tap pushed
a ring out to 25 m, over trees the screen never looked at, and the clearance
sweep caught it at 2 m. Sites have to be fitted by measurement: raise the rings
until the sweep clears, or give the site up.

## What this is not

Not a mission editor with a timeline. The three presets exist because "what
should I fly" is a recipe and not a slider, and the same argument says the
answer to "how do I fly a big site" is a budget and not a drag-and-drop
sequence. The person picks the place and counts their batteries; everything
else is measurement.
