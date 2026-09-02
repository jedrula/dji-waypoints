// Asking the device where it is, and being honest about the answer.
//
// getCurrentPosition on a laptop hands back whatever the OS last worked out
// from visible Wi-Fi -- observed 32 minutes stale even with maximumAge: 0,
// which the platform is free to ignore. watchPosition keeps the provider
// producing fixes, so this takes the best one that arrives in a few seconds and
// reports its age rather than trusting it blindly.

export const GPS_ERRORS = {
  1: 'Location permission was denied. Allow it in the address bar, or tap the map instead.',
  2: 'Your device could not get a position. On a laptop that usually means Wi-Fi positioning is unavailable.',
  3: 'Locating timed out. Try again, or tap the map instead.',
};

export const FRESH_ENOUGH_MS = 15000;  // stop early once a fix is this new
export const STALE_MS = 120000;        // past this, say so rather than pretend
export const WATCH_MS = 9000;          // the hard cap on how long to keep asking
// How long to keep waiting once a fix has arrived and stopped improving. The
// accuracy test below is a phone's test: a laptop positions itself off visible
// Wi-Fi and reports the same +/-35 m over and over, so it never passes and the
// whole nine seconds gets waited out for a fix that was final after one. Give
// up on a better one instead, and the crosshair answers straight away
// everywhere -- which matters more than the last metre, because the answer is
// drawn WITH its accuracy circle and can be asked again.
export const SETTLE_MS = 1200;

export function bestFix({ onProgress } = {}) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject({ code: 2, message: 'no geolocation' }); return; }
    let best = null;
    let done = false;
    let settle = null;
    const finish = () => {
      if (done) return;
      done = true;
      navigator.geolocation.clearWatch(id);
      clearTimeout(timer);
      clearTimeout(settle);
      best ? resolve(best) : reject({ code: 3, message: 'no fix' });
    };
    const better = (a, b) => {
      if (!b) return true;
      const aFresh = a.age < FRESH_ENOUGH_MS;
      const bFresh = b.age < FRESH_ENOUGH_MS;
      if (aFresh !== bFresh) return aFresh;        // fresh beats accurate
      return a.accuracy < b.accuracy;
    };
    const id = navigator.geolocation.watchPosition(
      (p) => {
        const fix = {
          lat: p.coords.latitude,
          lon: p.coords.longitude,
          accuracy: p.coords.accuracy,
          age: Date.now() - p.timestamp,
        };
        const improved = better(fix, best);
        if (improved) best = fix;
        onProgress?.(best);
        // Good enough on a phone: fresh and sharp, stop at once.
        if (best.age < FRESH_ENOUGH_MS && best.accuracy <= 30) { finish(); return; }
        // Otherwise wait only as long as it keeps getting better.
        clearTimeout(settle);
        settle = setTimeout(finish, SETTLE_MS);
      },
      (err) => { if (!best) { done = true; clearTimeout(timer); reject(err); } },
      { enableHighAccuracy: true, timeout: WATCH_MS, maximumAge: 0 },
    );
    const timer = setTimeout(finish, WATCH_MS);
  });
}
