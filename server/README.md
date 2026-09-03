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
