// A pretend receiver, for working on the walk without walking.
//
// NOT PART OF THE APP. Nothing imports this at load time: app.js reaches for it
// only when the address bar says `?mockgps`, so on a phone, on GitHub Pages, and
// in every ordinary run the file is never even fetched. It exists because the
// half of this app that matters most is the half you use standing in a field,
// and a laptop indoors either has no fix at all or has one from a Wi-Fi lookup
// several kilometres and several minutes away -- neither of which exercises the
// code, and both of which waste the trip outside to find out.
//
//   ?mockgps            drop the puck in the middle of the map
//   ?mockgps=50.06,19.93        put it somewhere specific
//   &acc=12             report ±12 m instead of the default ±4
//   &age=180            report a fix three minutes old, to see the stale path
//
// Drag the puck to walk. Everything that asks the browser where you are gets
// the puck's position, including the accuracy, so a stop's box is grown by the
// number you chose and the "too vague to place" refusal can be provoked on
// purpose by asking for ±30.

const $ = (id) => document.getElementById(id);

export function installMock(map, params) {
  const arg = params.get('mockgps');
  const accuracy = Number(params.get('acc') ?? 4);
  const ageMs = Number(params.get('age') ?? 0) * 1000;
  const [argLat, argLon] = String(arg ?? '').split(',').map(Number);

  const start = Number.isFinite(argLat) && Number.isFinite(argLon)
    ? { lat: argLat, lon: argLon }
    : { lat: map.getCenter().lat, lon: map.getCenter().lng };

  let at = { ...start };

  const puck = L.marker([at.lat, at.lon], {
    draggable: true,
    zIndexOffset: 1000,
    icon: L.divIcon({ className: 'mockpuck', iconSize: [26, 26], html: '<b>GPS</b>' }),
  }).addTo(map);
  puck.bindTooltip(`mock fix · ±${accuracy} m — drag me`, { direction: 'top' });
  puck.on('drag', () => { at = { lat: puck.getLatLng().lat, lon: puck.getLatLng().lng }; });

  const position = () => ({
    coords: {
      latitude: at.lat,
      longitude: at.lon,
      accuracy,
      altitude: null, altitudeAccuracy: null, heading: null, speed: null,
    },
    timestamp: Date.now() - ageMs,
  });

  let nextId = 1;
  const watchers = new Map();
  // Replacing the whole object rather than patching methods: some browsers make
  // geolocation's own methods non-configurable, and a half-patched receiver is
  // a worse thing to debug than an obviously fake one.
  Object.defineProperty(navigator, 'geolocation', {
    configurable: true,
    value: {
      getCurrentPosition(ok) { setTimeout(() => ok(position()), 60); },
      watchPosition(ok) {
        const id = nextId++;
        // Two fixes: one immediately, one a moment later, so code that waits
        // for a better one is actually exercised rather than short-circuited.
        const t1 = setTimeout(() => ok(position()), 60);
        const t2 = setTimeout(() => ok(position()), 400);
        watchers.set(id, [t1, t2]);
        return id;
      },
      clearWatch(id) {
        for (const t of watchers.get(id) ?? []) clearTimeout(t);
        watchers.delete(id);
      },
    },
  });

  const note = document.createElement('div');
  note.id = 'mocknote';
  note.textContent = `mock GPS · ±${accuracy} m${ageMs ? ` · ${ageMs / 1000}s old` : ''} · drag the puck`;
  $('stage').append(note);

  return { moveTo: (lat, lon) => { at = { lat, lon }; puck.setLatLng([lat, lon]); } };
}
