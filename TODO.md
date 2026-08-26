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
- [ ] **The real site.** The proxy is a guess at the layout. Importing a mesh,
      or letting the user place blocks on the map, would make the score specific
      to the place rather than to a generic cluster.

## Known limitations

- [ ] **3D view shows the plan, not the world.** No terrain, no trees, no
      buildings — a flight can look perfectly clear in it and still be blocked.
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
- [ ] **No obstacle awareness.** Nothing knows about trees, masts, or wires.

## Ideas, unprioritised

- [ ] Vertical-face mode for crags and facades (see flat-ground note above).
- [ ] Polygon / freehand area instead of a rectangle only.
- [ ] Save and reload a plan (JSON), so a site can be reflown identically.
- [ ] Export the plan as plain KML to eyeball in Google Earth before flying.
