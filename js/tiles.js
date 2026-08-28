// Slippy-map tiles, as textures rather than as a map.
//
// The 3D view needs imagery for one small patch of ground -- the capture area
// and a margin -- at whatever detail makes that patch worth looking at. That is
// a different question from the one the map answers, which is why this does not
// reach into Leaflet's tile cache: the map holds tiles for the map's viewport at
// the map's zoom, and over a 50 m site those are the wrong tiles by several
// zoom levels. Requesting them separately costs nothing anyway -- the tiles
// carry `max-age=86400`, so a URL the map already fetched comes back from the
// browser's cache in a fraction of a millisecond and zero bytes.

export const TILE_PX = 256;

const RAD = Math.PI / 180;

export const lonToX = (lon, z) => ((lon + 180) / 360) * 2 ** z;

export function latToY(lat, z) {
  const s = Math.sin(lat * RAD);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 2 ** z;
}

export const xToLon = (x, z) => (x / 2 ** z) * 360 - 180;

export function yToLat(y, z) {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return Math.atan(Math.sinh(n)) / RAD;
}

// Ground resolution of a tile pixel, which is what decides whether a zoom is
// worth requesting: below about 0.4 m/px a site the size of a house is a smudge.
export const mPerPx = (lat, z) => (156543.03392 * Math.cos(lat * RAD)) / 2 ** z;

export function tileRange(bbox, z) {
  return {
    z,
    x0: Math.floor(lonToX(bbox.west, z)),
    x1: Math.floor(lonToX(bbox.east, z)),
    y0: Math.floor(latToY(bbox.north, z)),
    y1: Math.floor(latToY(bbox.south, z)),
  };
}

export const tileCount = (r) => (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1);

// The most detailed zoom whose tile count over this patch stays within budget.
// Detail is the whole point -- a 50 m yard at the map's zoom is a dozen pixels
// stretched across the ground -- but so is not firing off two hundred requests
// for one frame.
// `maxZoom` is a hard ceiling, not a preference: a tile service answers a
// request past its own coverage with a placeholder image rather than an error.
export function pickZoom(bbox, { maxTiles = 24, minZoom = 10, maxZoom = 19 } = {}) {
  for (let z = maxZoom; z > minZoom; z--) {
    if (tileCount(tileRange(bbox, z)) <= maxTiles) return z;
  }
  return minZoom;
}

// The ground corners of one tile, in lat/lon. Tiles are axis-aligned in Web
// Mercator, not on the ellipsoid, so this is where that distinction is paid:
// north and south edges are at different latitudes than a naive lerp would give.
export function tileBounds(z, x, y) {
  return {
    north: yToLat(y, z),
    south: yToLat(y + 1, z),
    west: xToLon(x, z),
    east: xToLon(x + 1, z),
  };
}

// Images, kept until there are too many. Loading is fire-and-forget: `onLoad`
// is how the view learns to draw itself again, because a tile that arrives
// after the frame it was wanted for is otherwise invisible until you move.
//
// Nothing sets crossOrigin. These tiles carry no CORS headers, so asking for
// them anonymously would fail the load outright; without it they draw fine and
// merely taint the canvas, which costs us nothing -- the 3D view never reads
// its own pixels back.
export function createTileCache({ url, onLoad = () => {}, limit = 200, Image: Img } = {}) {
  const cache = new Map();
  const ImageCtor = Img ?? globalThis.Image;

  return {
    // The image if it is here, null if it is not -- and either way, the request
    // is under way after the first ask.
    get(z, x, y) {
      const key = `${z}/${x}/${y}`;
      const hit = cache.get(key);
      if (hit !== undefined) return hit.img;

      const img = new ImageCtor();
      const entry = { img: null };
      cache.set(key, entry);
      img.onload = () => { entry.img = img; onLoad(); };
      img.onerror = () => { entry.failed = true; };
      img.src = url(z, x, y);

      // Oldest first, which for tiles is near enough to least-recently-wanted:
      // they are asked for in ranges, so a range that has scrolled away is the
      // one that stops being re-inserted.
      if (cache.size > limit) {
        for (const k of cache.keys()) {
          if (cache.size <= limit) break;
          if (k !== key) cache.delete(k);
        }
      }
      return null;
    },

    size: () => cache.size,
    clear: () => cache.clear(),
  };
}
