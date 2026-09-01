# TODO

## First thing to do with a real device

Generate a waypoint mission in DJI Fly on the Mini 5 Pro, pull that KMZ off the
controller, and run:

```
npm run check -- theirs.kmz          # what does DJI actually write?
npm run check -- ours.kmz theirs.kmz # what do we write that they do not?
```

That single diff settles most of the open questions below — the drone enum, any
required element we are missing, and whether the namespace guess is right.

## Needs a real flight to confirm

Everything here is written to spec but unverified on hardware. Test in an open
area with RTH set sensibly.

- [ ] **`droneEnumValue` 68 / sub 0 on the Mini 5 Pro.** That is what DJI Fly
      writes on the Mini 4 Pro; DJI publishes no enum for consumer drones. If a
      mission is rejected, unzip one DJI Fly generated itself and compare, then
      fix `PROFILES` in `js/wpml.js`.
- [ ] **Distance-interval shutter (`multipleDistance` trigger).** In the spec,
      confirmed mostly on enterprise builds. It is ~10x cheaper in waypoints, so
      it is worth knowing. Currently labelled "unverified" in the UI and never
      auto-proposed unless waypoint mode cannot fit. Test: fly a small grid in
      interval mode, count the images on the card.
- [ ] **Frames per stop = 3 (pitch fan).** Emits 3 `gimbalRotate` + 3 `takePhoto`
      actions in one waypoint's action group. Unknown whether DJI Fly caps
      actions per waypoint — if it does, find the cap and clamp the fan.
- [ ] **Does the fan actually help?** Compare a single-frame capture against a
      3-frame capture of the same subject through the same 3DGS pipeline. The
      prediction is that it improves facade/roofline coverage but not geometry,
      since rotating about the optical centre adds no parallax.
- [ ] **Copy the 27–28 Aug flights off the aircraft and delete the 81
      duplicates.** Blocked on the USB link: reads fail with `Input/output error`
      after a few MB and the aircraft drops off the bus entirely within a minute
      or two. There is no card to pull — it is internal storage behind a USB
      mass-storage gadget. `tools/pull-media.py` retries around it and resumes,
      but QuickTransfer over Wi-Fi is probably the saner route. Copy
      `docs/2026-08-28-keep.txt` into `captures/`, verify the images decode, then
      delete `docs/2026-08-28-duplicates.txt`. Full detail in
      `docs/2026-08-28-duplicate-frames.md`.
- [ ] **Confirm the Timed Interval hypothesis on the controller.** The 28 Aug
      flight fired a ~1.4 s shutter straight through two hovers, 41% of the card
      wasted. That is a timed interval in the DJI Fly camera UI, not the
      mission's own trigger — but nobody has checked what the camera was actually
      set to, or whether that flight used a KMZ from here at all. Full write-up
      and the questions to ask in `docs/2026-08-28-duplicate-frames.md`.
      Until it is confirmed, the mitigation is only the pre-flight warning in
      `js/app.js`; there may be a KMZ-side fix that forces single-shot, but the
      WPML spec offers no obvious camera-mode action on the Mini series.
- [ ] **AEB / exposure bracketing.** Probably the biggest photorealism lever and
      it may need no KMZ change at all — set the camera to AEB in DJI Fly before
      the flight and see whether waypoint `takePhoto` fires the whole bracket.
      Clipped highlights poison the spherical-harmonics fit.

## Under-canopy capture (playground)

Supported via the orbit pass alone: altitude down to 3 m, negative orbit offset
to tighten the ring, and multiple rings for vertical parallax. Obstacle
avoidance stays active during a waypoint mission but only ever **brakes** — it
will not route around anything, and a brake mid-mission stops the flight.

- [ ] Confirm the drone holds a waypoint line under this particular canopy at
      all. GNSS is the real limit, not the planner.
- [ ] Walk the ring on foot first and check nothing thin (branches, swing
      chains, netting) crosses it — vision sensing is known to miss those.
- [ ] Check whether the ring altitude clears the equipment itself, not just the
      canopy.

## Coverage scorer

Geometric only, and deliberately so — it needs no renderer, GPU or training.
What it cannot tell you:

- [ ] **Whether coverage predicts reconstruction quality.** The obvious next
      step is the render loop: Blender or a splat renderer produces frames along
      a planned trajectory, COLMAP plus a trainer rebuilds it, and the result is
      compared against ground truth. Then calibrate the fast scorer against the
      slow one. Beware: SfM behaves differently on synthetic imagery, and
      rendering from a splat favours trajectories like the one that made it.
- [ ] **Thin structures.** The proxy is boxes. Chains, bars and netting are
      where real playground captures actually fail, and a box proxy says nothing
      about them.
- [ ] **The real site.** The proxy is still a guess at the layout. Obstacles
      drawn on the map now occlude, so the score knows what it cannot see
      through — but the surfaces being *scored* remain the generic cluster.
      Letting a drawn box stand in as the subject, or importing a mesh, would
      make the score specific to the place. Left out on purpose for now: it
      changes what the Coverage percentage means, and a number that quietly
      changes meaning is worse than a number that is only a guess.

- [ ] **Nothing gets under an overhang.** With rings and cross passes, low-wall
      coverage plateaus around 85%; the remainder is surface at the bottom of
      narrow gaps that only a camera inside the gap would see. Tighter cross
      passes, or lines aligned to the gaps rather than to the box axes, are the
      obvious next thing to measure.

## Surround ring

The outward-facing pass. On by default, and the first thing auto-fit drops.

- [ ] **The far field is a panorama, not measured geometry.** Two stations on
      opposite sides of the ring look along opposite azimuths and share no view,
      so nothing distant is triangulated by this pass alone. What gives it depth
      is the inward orbit looking over the box at the same landscape from the
      far side of the ring — which means the ring is worth much less with the
      orbit switched off, and nothing in the app says so. Whether the background
      gaussians actually land at a sensible depth is a question for the render
      loop, not for the geometric scorer.
- [ ] **The connection to the rest of the capture is indirect, and conditional.**
      A surround frame contains none of the subject — the camera points away from
      it — so nothing ties this image set to the others directly. What ties it is
      the inward orbit looking *over* the box at the same distant landscape from
      the far side of the ring, which only happens while the orbit's tilt is
      shallow enough to put the horizon inside its frame (top edge = orbit pitch
      + 28.4°). Measured on what the planner actually proposes: a playground at
      12 m clears it by 6–19°, a house at 28 m by 15° on the top ring, and a
      200 x 150 m site at 116 m misses it by 11°. The last of those is also where
      auto-fit drops the ring for flight time, so the two coincide today — but
      that is luck, not design. Nothing warns you if you force the ring on under
      a steep orbit, where it may reconstruct as a disconnected component.
- [ ] **The ground just outside the ring is only ever seen edge-on.** The frame
      is tilted so its top edge is at the horizon, which puts its bottom edge on
      the ground roughly `altitude / tan(53°)` metres *beyond* the drone — 30 m
      out at 40 m altitude. The grids stop at the box. The annulus between them
      falls to the orbit frames looking across from the opposite side of the
      ring, at more than twice the range and at a grazing incidence the coverage
      scorer would reject on a wall. A second, steeper fan angle would fill it
      properly, at double the frames; whether that ground matters depends on the
      site.
- [ ] **The coverage score cannot see the point of it.** The scorer measures the
      proxy subject, and this pass is aimed away from it, so switching the ring
      on moves Coverage by exactly zero while the waypoint and time counts climb.
      That is honest but it reads like a bug. Scoring the surroundings needs a
      model of the surroundings, which is the same missing piece as
      "the real site" under the coverage scorer above.
- [ ] **A mission read back off the controller does not know the ring is a
      ring.** `inferPass` in `js/route.js` guesses from pitch and heading mode;
      a surround waypoint looks exactly like an oblique one, so a read-back
      route draws it in the wrong colour. Outward yaw relative to the route
      centroid would identify it.

## Walking the site

- [ ] **A phone fix is the whole ballgame, and it is worst where this matters.**
      Under the canopy that makes walking worth doing, a phone routinely reports
      ±15 m and worse. The box is grown to match and a fix past ±25 m is refused,
      but a grown box is a blunter instrument than a drawn one, and enough of
      them will push the altitude up for no reason. Nothing yet averages several
      seconds of fixes at one stop, which is the obvious next lever.
- [ ] **A stop is a square, and the thing is not.** Same limitation as every
      other obstacle here, but felt harder: you are standing beside a hedge or a
      row of trees and there is no way to say "this, for thirty metres that
      way". Two stops at either end of a line obstacle would model it, and that
      is the same two-point-with-sag primitive the obstacle notes already want.
- [ ] **Heights are above the takeoff point, not above where you are standing.**
      On a slope those are different numbers and nothing in the app knows the
      difference. Walking a sloped site is exactly when you would not notice.
- [ ] **The walk cannot correct itself.** Undo takes back the last stop; there
      is no way to fix the height of stop 2 from the Walk pane. The Obstacles
      list can do it, which means switching panes mid-walk.

## Known limitations

- [ ] **3D view shows only the world you drew.** Obstacles now appear as solids
      and the legs that hit them are struck in red, but nothing is there unless
      you drew it — no terrain, and no trees you did not box. A flight can still
      look perfectly clear and be blocked by something nobody told it about.
- [ ] **Cross passes use `smoothTransition` heading with an explicit yaw.** That
      is how the camera is held side-on. It is in the spec and validates, but it
      is a different heading mode from the other passes — check on the first
      flight that the aircraft actually holds the commanded yaw.
- [ ] **Exposure consistency across a long capture.** Splats bake the lighting,
      and a capture spanning changing light shows a warm-to-cool gradient. Lock
      exposure and white balance; fly multi-part missions back to back, not an
      hour apart.
- [ ] **The shot fan can point at the sky on a low orbit.** The fan is centred
      on the pass pitch, so a near-horizontal orbit at 5 m fans up to ~+16 deg
      and photographs canopy. Either clamp the fan to the aimed pitch or bias
      it downward at low altitude.
- [ ] **Flat-ground assumption.** The planner holds one constant AGL altitude
      over a horizontal rectangle. Terrain that rises inside the box eats the
      clearance, and a vertical subject (a climbing crag, a building facade,
      a quarry wall) is the wrong shape for this pattern entirely — that wants a
      grid in a *vertical* plane with the gimbal near 0 deg, which is a separate
      pass type, not a parameter.
- [ ] **No terrain following.** `executeHeightMode` is `relativeToStartPoint`,
      so altitude is relative to takeoff, not to the ground below. Fine for flat
      sites, dangerous on slopes.
- [ ] **Split missions restart mid-line.** Over 200 waypoints the plan is cut
      into equal chunks, which can land a boundary in the middle of a grid leg.
      Splitting on pass boundaries would be tidier.
- [x] **No obstacle awareness.** ~~Nothing knows about trees, masts, or
      wires.~~ Boxes drawn on the map are measured against every leg of the
      flight (`js/collide.js`). What is still missing:
- [ ] **Obstacles are boxes and the world is not.** A box encloses a tree, which
      errs safe; it badly misjudges a gable roof if you typed the eaves height,
      and it says nothing about a wire between two masts — which is the thing
      most likely to actually take the aircraft down. A two-point line obstacle
      with a sag would model that properly.
- [ ] **Adjust has two knobs, and the site may need a third.** Altitude and
      orbit offset are what it searches. Dropping a pass, shrinking the box or
      moving it are all real fixes it will never suggest, and it says "move the
      box" rather than pretending otherwise. Searching over pass selection is
      the obvious next one, but it changes what the capture IS, which is a
      different kind of suggestion from changing a number.
- [ ] **Ground imagery is flat, and the world is not.** Tiles are painted on
      z = 0. Roofs lean away from nadir so they land beside their own walls, and
      on a slope the imagery is level while the ground is not. It is context,
      never a clearance check -- which is why it is off by default. Draping over
      a terrain mesh would fix the slope half; nothing cheap fixes the lean.
- [ ] **One zoom for the whole ground.** A single zoom is chosen for the whole
      patch, so a plan spanning a large area gets coarser imagery everywhere
      rather than finer tiles near the camera. Per-tile zoom by screen size is
      the usual answer if it ever matters.
- [ ] **The URL carries the view, not the whole app state.** Pane, basemap,
      centre, zoom and the plan are in the address bar; the selected obstacle,
      the split-divider position and the obstacle list are not. Going further --
      one state object, URL as the only source of truth, every render derived --
      is a rewrite of app.js rather than an addition to it, and the payoff over
      what is there now is small. Worth doing if the wiring ever starts
      disagreeing with itself; not worth doing pre-emptively.
- [ ] **A press on an obstacle drags the obstacle, never the capture area.**
      Obstacles sit above the area so they stay clickable inside it, which means
      the area cannot be grabbed through one. Undo covers the mistake, but a
      modifier key, or dragging the area only by its edges, would avoid it.
- [ ] **Undo does not cover saved plans.** Deleting one from the library is
      still permanent. The obstacle list and the plan on screen are undoable;
      the library is a separate store and was left alone deliberately, but the
      asymmetry will surprise someone.
- [ ] **The check ignores the climb out and the return.** It measures the
      planned path between waypoints. Takeoff, the flight to the first waypoint
      and RTH are all unmodelled, and RTH in particular flies a straight line at
      a set altitude across ground nobody checked.
- [ ] **Rectangles only, axis-aligned.** A building at 30 degrees to north needs
      an over-sized box to enclose it, which then reports strikes that are not
      real. A rotation handle would fix it; so would drawing a polygon.

## Ideas, unprioritised

- [ ] Vertical-face mode for crags and facades (see flat-ground note above).
- [ ] Polygon / freehand area instead of a rectangle only.
- [ ] Save and reload a plan (JSON), so a site can be reflown identically.
- [ ] Export the plan as plain KML to eyeball in Google Earth before flying.
