# Measured heights, on demand

The app can plan a flight from OpenStreetMap alone. Where a building has no
`height` tag it assumes 24 m, and 24 is not a guess -- it is the p90 of real
LiDAR returns over a Wroclaw tile (`tools/lidar-spike.py`). But a p90 is a
statement about a neighbourhood, and clearance is a statement about the
building in front of you. At Cybulskiego 22 the assumption says 24 and the
roof is at 29.

This service closes that gap for anywhere in Poland, for someone who has never
been there, without asking them to install anything.

## What it does

GUGiK publishes the national LiDAR survey free and unrestricted. It is
extraordinary data and it is completely unusable from a phone: the four tiles
covering one 500 m square are **192 MB**. So the crunching happens here, once,
and what crosses the network is the answer:

```
in    4 LAZ tiles, 192 MB, 27.6M points, 12 pts/m2, flown 2024
out   a 500 x 500 byte height raster -- 244 kB, 57 kB gzipped
```

One byte per square metre: how far above local ground the tallest thing in
that metre stands. A survey flown in 2024 will not change its mind, so every
tile is built once in the life of the service and served from disk after that.

```
first request for a tile    ~70 s   (52 s downloading, 18 s decoding)
every request after that     1.4 ms
```

The first person to fly a new field waits. Nobody else ever does.

## Running it

```sh
npm install && npm start          # :8130, data in ./var
npm test                          # offline, no network, ~1 s
```

`PORT`, `DATA_DIR` and `BUILD_CONCURRENCY` are the only knobs. The default
concurrency is 2, deliberately: GUGiK is a public agency doing us a favour,
and every byte we take is cached so we never ask twice.

## Trying it

Two servers: the app on 8123 as usual, this one on 8130.

```sh
cd server && npm install && npm start
```

That is all the wiring there is. The app turns measurement on by itself when
the page is on localhost, so open the app, pan to somewhere in Poland, and
press **Import what is here** under Obstacles > Advanced. To point it at a
service running anywhere else:

```js
localStorage['dji.heightsUrl'] = 'https://heights.example.com'   // '' to switch off
```

The first import over new ground is slow and says so -- the button counts
tiles, and a toast warns that the survey is coming down. Over Cybulskiego at
zoom 18 that was four tiles, 91 obstacles, **51 of them measured** where
before every one of the 51 was an invented 24 m. Heights came back spread
from 3 m to 40 m. The second import over the same ground is instant.

## The API

```
GET /v1/coverage?lat=&lon=     what survey exists here, without downloading it
GET /v1/tile/{tn}/{te}         the raster; 202 while building, add ?wait=1 to block
GET /v1/height?lat=&lon=       one height, for "how tall is that"
GET /v1/health
POST /sync  POST /obstacles    the plan and obstacle lists (see "The Worker" below)
```

Tile addresses are PUWG92 500 m grid indices, so a URL is stable forever and
`immutable` is an honest cache header. `/v1/tile` responses carry their
metadata in `X-Tile-Meta`: the source years and densities, point counts, class
histogram, and coverage.

### Reading a tile

500x500 bytes, row 0 is the **north** edge, so it draws onto a canvas without
flipping. Byte value is metres above local ground, and `255` is **no data**.

```js
const res = await fetch(`${SERVICE}/v1/tile/${tn}/${te}`);   // browser gunzips
const h = new Uint8Array(await res.arrayBuffer());
const height = h[row * 500 + col];
```

**`255` means unknown, never clear.** Roughly a fifth of a city tile comes back
blank and it is nearly all water -- 52% of blank cells sit within 6 m of a
water-classified return, and water mostly returns nothing at all, which is
precisely why it is blank. But an unsurveyed patch is blank in exactly the same
way, so a client that reads 255 as zero is a client that flies into whatever
the laser missed. Fall back to the OSM estimate there.

## The rough model

`/scene` is the other thing this data is good for. Open it and you get a
textured 3D model of the place, built from the point cloud already on disk plus
GUGiK's orthophoto -- **25 cm a pixel, open, national**, sharp enough to read
individual cars.

```
geometry   1000 x 1000 at 0.5 m, uint16 cm above base + one class byte
colour     2048 x 2048 JPEG, ~24 cm/px
together   about 2.1 MB for a 500 m square
```

It is deliberately a worse model than the one you are going to fly for. That is
what makes it useful: it is the **init**. Massing, roof heights, tree canopy and
ground are right to within a metre before anyone leaves the house, and the
class byte means it is a *semantic* init -- building, vegetation, ground and
water are separated, not one undifferentiated mesh.

**What it cannot know is walls.** Every return in it was measured from an
aircraft looking straight down, and the orthophoto was taken the same way. The
two datasets are blind in exactly the same direction. A 2.5D surface renders
vertical faces as smeared roof-edge pixels, so rather than dress that up the
grid marks them and the viewer paints them blank. The brown faces in the render
are a picture of precisely what the drone is being sent to collect.

Water is the other honest gap. It returns almost nothing to a laser, so the
river arrives as a hole; it is filled from its rim and flattened, and those
cells keep class 0 so nothing downstream mistakes the fill for a measurement.

### Colour: WMTS, not WMS

GUGiK publishes the orthophoto through two services and only one of them is
national. `ORTO/WMS/HighResolution` advertises the whole country and covers the
towns; over a forest it returns a blank white JPEG. `ORTO/WMTS/StandardResolution`
is the one with national coverage, at 26 cm a pixel, and it is what the viewer
uses.

Its tile matrix is **EPSG:2180** -- the same grid the geometry is on -- so the
tiles drop into place with arithmetic instead of a reprojection, and the viewer
never has to leave the projection it was handed. A 500 m scene is 25 tiles.
It sends `Access-Control-Allow-Origin: *`, so the browser fetches them directly.

Do not reach for a third-party basemap here. Esri's World Imagery is reachable
without a key and is not open data: its terms say the layer "is not intended to
be used to export tiles for offline use", which is exactly what compositing it
into a stored texture amounts to. GUGiK's is open, redistributable, higher
resolution, already in the right projection, and needs a fifth as many requests.

### The old blank-photo check

GUGiK's "HighResolution" orthophoto advertises the whole country and covers the
towns. Ask it for a forest in Zachodniopomorskie and it returns a **perfectly
valid JPEG that is blank white** -- JPEG has no alpha, so no-data has to look
like something, and stored unchecked that becomes a tile whose photo washes the
whole model out. A blank one compresses to 0.027 bytes a pixel where Wroclaw
runs 0.24, so that is the test, and it distinguishes absence (never retried)
from a transient failure (always retried).

Where there is no national photo the viewer falls back to the same Esri imagery
the planner's map uses, warped from Web Mercator onto the PUWG92 grid per
output pixel. Pasting it instead of warping puts every roof a couple of metres
from its own outline.

```
Cybulskiego 22, Wroclaw    GUGiK 25 cm       12 pts/m2   38% unmeasured (a river)
Lesna Polana 2, Dominikowo Esri z19          4 pts/m2    12% unmeasured
```

The rural tile is a third the point density and still resolves individual tree
crowns along the forest edge, which is the thing you actually want to know
about before flying there.

```
/scene                       the viewer, default Cybulskiego 22
/scene?lat=..&lon=..         anywhere in Poland with coverage
/v1/scene/{tn}/{te}          the grid, gzipped
/v1/scene/{tn}/{te}.json     what is in it
/v1/scene/{tn}/{te}.jpg      the orthophoto
```

## Decisions worth knowing

**Heights round up.** 30.4 m stores as 31. This number decides how high to fly;
rounding down spends the margin the clearance setting was meant to provide.

**Ground is modelled at 10 m, the surface at 1 m.** Ground returns are sparse
under canopy and inside courtyards -- at 1 m most cells would be empty and
every height measured against them would be missing. Cells with no ground
return borrow from their neighbours, spreading inwards until the grid is full.

Taking the *lowest* ground return in each 10 m cell puts ground at the cell's
downhill edge, so on a slope every height above it reads slightly high: about
0.25 m at a 5% grade. That bias is deliberate and it is asserted in the tests,
direction included. Extra clearance is the only acceptable direction to be
wrong in.

**The point cloud, not the derived raster.** GUGiK also publishes NMPT, a ready
made surface model, and it looks like the easy answer. It is not: it does not
cover Wroclaw at all, and where it exists one sheet is 122 MB of ASCII text --
more than the LAZ, for the same ground.

## Traps this code is shaped around

Each of these produced a confident wrong answer before it was caught.

- **BBOX is north,east**, and so are the GML corners that come back. At Wroclaw
  easting and northing are both about 362000, so a swap returns plausible
  neighbouring tiles containing everything except your point. The URN form of
  the CRS is what pins the axis order; drop it and the server chooses.
- **Newer surveys are PL-2000, not PUWG92**, and a PL-2000 easting starts with
  the zone number: 6432800 rather than 362800. Read one as PUWG92 and every
  point lands in the Baltic and the tile looks empty. Those surveys are skipped
  until the reader reprojects -- which is the main thing missing here.
- **The WASM heap moves.** `getPoint` allocates as it decompresses, and when
  the heap grows the old `ArrayBuffer` is detached, so a cached `DataView`
  throws. It survives one file on heap headroom and dies on the third.
- **Wires are not classified.** No class 13, 14, 15 or 16 in any tile sampled.
  Power lines still come from OpenStreetMap geometry with an assumed height.
  The single most dangerous thing in the sky is the thing this data does not
  label, and no amount of LiDAR here changes that.

## The Worker

`sync/worker.js` stores the plan and obstacle lists on Cloudflare KV, and this
service speaks the same protocol on the same two routes -- so pointing a client
here is a URL change and nothing else (`localStorage['dji.syncUrl']`).

The record validation and the merge are **imported from the Worker**, not
copied. Its own comment makes the case: a client that merges differently from
the server is worse than one rule living in two files, and that goes double for
two servers. While both run, they cannot drift.

Nothing is migrated automatically. The Worker still holds the live lists.
