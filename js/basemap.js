// The three Esri basemaps, the picker over the map, and the tile source the 3D
// ground shares with it.
//
// Its own module because it is a self-contained job with one rule worth
// protecting: the URL shape and the deepest zoom the service actually holds
// imagery for are written down ONCE. The map layer and the 3D ground both read
// them, or they disagree and only one of them shows Esri's grey "Map data not
// yet available" tile -- which is a real image, so nothing errors and nothing
// looks broken until you see it painted across the ground.

const $ = (id) => document.getElementById(id);

export const BASEMAPS = {
  satellite: { label: 'Satellite', url: 'World_Imagery', maxNative: 19, attribution: 'Imagery &copy; Esri' },
  streets: { label: 'Streets', url: 'World_Street_Map', maxNative: 19, attribution: 'Map &copy; Esri' },
  topo: { label: 'Topo', url: 'World_Topo_Map', maxNative: 19, attribution: 'Topo &copy; Esri' },
};
const KEY = 'dji.basemap';

// Note /{z}/{y}/{x} -- Esri puts the row before the column, which is not the
// usual order and is a whole afternoon if you get it wrong.
export const tileUrl = (service) => (z, x, y) =>
  `https://server.arcgisonline.com/ArcGIS/rest/services/${service}/MapServer/tile/${z}/${y}/${x}`;

export function createBasemaps({ map, onChange = () => {} }) {
  const layers = {};
  let active = 'satellite';
  let current = null;

  function set(name) {
    const spec = BASEMAPS[name] ?? BASEMAPS.satellite;
    active = BASEMAPS[name] ? name : 'satellite';
    layers[active] ??= L.tileLayer(
      `https://server.arcgisonline.com/ArcGIS/rest/services/${spec.url}/MapServer/tile/{z}/{y}/{x}`,
      { maxZoom: 21, maxNativeZoom: spec.maxNative, attribution: spec.attribution },
    );
    if (current !== layers[active]) {
      if (current) map.removeLayer(current);
      current = layers[active];
      // Underneath the flight path and the points, which are already on the map
      // by the time you switch.
      current.addTo(map).bringToBack();
    }
    for (const b of document.querySelectorAll('#basetabs button')) {
      b.classList.toggle('on', b.dataset.base === active);
    }
    // localStorage is the fallback for a bare visit; the URL wins when it has
    // something to say, so opening someone's link does not retune your default.
    try { localStorage.setItem(KEY, active); } catch { /* private window */ }
    onChange(active);
  }

  for (const [name, spec] of Object.entries(BASEMAPS)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.base = name;
    b.textContent = spec.label;
    b.addEventListener('click', () => set(name));
    $('basetabs').append(b);
  }

  let saved = null;
  try { saved = localStorage.getItem(KEY); } catch { /* private window */ }
  set(saved ?? 'satellite');

  return {
    set,
    name: () => active,
    // What the 3D view needs to paint the same imagery on its ground. The
    // attribution is written for Leaflet's control, which renders HTML; a canvas
    // draws text, so the entity has to become the character.
    groundSpec: (on) => {
      const spec = BASEMAPS[active] ?? BASEMAPS.satellite;
      return {
        on,
        url: tileUrl(spec.url),
        maxZoom: spec.maxNative,
        attribution: spec.attribution.replace(/&copy;/g, '©'),
      };
    },
  };
}
