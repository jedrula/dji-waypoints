# Real walls, instead of guessing them from a heightfield

**Written** 2026-09-09, after the survey view was made to match the service's
own viewer and the remaining gap turned out to be in the *data*, not the
rendering.

## The thing that is wrong, and cannot be fixed by rendering

Both pictures — `js/scene3d.js` and `server/public/scene.html` — draw a **2.5D
heightfield**: one measured height per half-metre cell, with the orthophoto
draped over it. That representation has no walls in it. A building is a
plateau, and the side of the plateau is a cliff one cell wide whose texture is
the roof edge stretched vertically downwards.

So both viewers do the same thing about it: detect the cliff, and paint it as
*unknown* rather than dressing up the smear. Detection is a 1.75 m step between
neighbouring cells, smoothstepped, and it is a heuristic with measured costs:

    Cybulskiego 22, tile 725/724, the 857 x 622 crop the app builds
    19,333 quads marked as wall by "any corner is a wall vertex"
      40.0%  under 1.75 m of vertical extent  -- not a wall
      16.7%  under 0.25 m                     -- flat ground

That measurement killed the per-quad version and is why the surface now runs
the viewer's per-fragment shader (`796c544`). The per-fragment blend hides the
error rather than removing it: the heuristic is still a heuristic, and a
parapet, a chimney and a tree beside a building all still fire it.

**No shader fixes this.** A vertical face has no pixels in a nadir photo and no
geometry in a heightfield. To draw a wall you need a model that has walls.

## What exists, free, over Poland

GUGiK publishes **3D building models in CityGML 2.0**, derived from the same
LiDAR plus BDOT10k footprints we already use, free of charge and free to use:

- **LoD1** — a solid per building, flat roof, correct footprint and eaves
  height. Nationwide as of the 2024 edition, with 2019/2021/2022 editions also
  downloadable.
- **LoD2** — LoD1 plus the roof shape. **10 voivodeships only**, from the CAPAP
  project: kujawsko-pomorskie, lubelskie, małopolskie, mazowieckie, opolskie,
  podlaskie, podkarpackie, śląskie, świętokrzyskie, warmińsko-mazurskie.

Distribution is per-*powiat* CityGML packages from the "Dane do pobrania →
Topografia → Modele 3D budynków" layer on geoportal.gov.pl, plus a WMS at
`integracja.gugik.gov.pl/cgi-bin/ModeleBudynkow3D` with `lod1` and `lod2`
layers. Both layers advertise the whole country in `GetCapabilities`, which is
the service envelope and not the coverage — so coverage was measured instead,
by asking for a 450 m GetMap and looking at the size of the PNG that came back:

    lod2 over Cybulskiego 22 (Wroclaw)   700 bytes   empty
    lod1 over Cybulskiego 22             1688 bytes  covered
    lod2 over the Rynek (Krakow)         1688 bytes  covered

**So: LoD2 for Kraków, LoD1 only for Wrocław.** Which is the awkward half of
this. Wrocław is where most of the flying is, and LoD1 gives a flat-topped box
— *better* than the heightfield at the walls, and *worse* at the roof, which is
the surface the aircraft actually looks down on.

## What it would be worth

The prize is not prettiness. It is that a wall becomes a thing with a known
position instead of a coloured guess, and this app plans flights near walls:

- The clearance check would test against a facade rather than against a cliff
  the step heuristic happened to find.
- The default orbit could stand a known distance off a known facade.
- `surveyCeiling` stays as it is regardless — it answers "the tallest measured
  thing anywhere under this flight", and the raster is still the only source
  that sees a crane or a line of poplars.

## The shape of the work, if it is taken

1. A `/v1/buildings` route on the service: fetch the powiat package once, cache
   it next to `var/laz`, and serve the solids inside a bbox as plain JSON
   (footprint ring + eaves height + ridge height where LoD2 has it).
2. Draw them in `js/scene3d.js` as real extruded prisms. `js/prism.js` already
   holds convex prisms with ear clipping and the distance proof `js/collide.js`
   needs, so the planner side is largely built.
3. Keep the heightfield underneath, for the ground, the trees, and everything
   nobody modelled. The two are complementary: the raster sees everything and
   knows no shapes; the CityGML knows shapes and sees only buildings.
4. Only then decide what to do about the wall heuristic — with real facades in
   the scene, the remaining cliffs are trees and unmapped structures, which is
   a more honest thing for the brown to mean.

**Unmeasured, deliberately:** the size of a powiat CityGML package, and how
long it takes to parse. Measure before promising step 1, given `var/` already
has no eviction policy.

## Related

- `js/scene3d.js` — `wallAt` and `surfaceMaterial`, which carry the heuristic
  and the numbers above.
- `server/public/scene.html` — the shader both views now share.
- `docs/2026-09-08-hosting-the-service.md` — the disk situation `var/` is in.

## Sources

- https://www.geoportal.gov.pl/en/data/other-data/3d-models-of-building/
- http://www.gugik.gov.pl/__data/assets/pdf_file/0011/94691/Instrukcja-pobierania-Modeli-3D.pdf
- http://integracja.gugik.gov.pl/cgi-bin/ModeleBudynkow3D?SERVICE=WMS&REQUEST=GetCapabilities
