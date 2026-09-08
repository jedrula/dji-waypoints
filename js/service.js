import { KEY_OK } from '../sync/protocol.js';
// Where the service is, and who you are to it.
//
// One address, because there is one service. It measures heights from LiDAR,
// finds the overhead lines, builds the rough model, and holds the two synced
// lists -- see server/README.md. Those arrived at different times and each
// grew its own copy of this rule and its own localStorage key, which meant
// hosting the thing was two edits in two files that had to agree.
//
// A local page talks to a local service, so a laptop already running one needs
// no configuring. Every other page goes to the hosted one.
const LOCAL = /^(localhost|127\.0\.0\.1)$/.test(globalThis.location?.hostname ?? '');

// Hosted 2026-09-08 on the home Linux box: a second hostname on the Cloudflare
// tunnel that already fronts api.topomatch.com -- the same tunnel and the same
// connector, with the service in the tmux session start-dev.sh builds.
//
// Routing it through that box's gateway on :8000, the way the other services
// there are reached, was the other option and would have cost the allowlist
// below: the gateway sets Access-Control-Allow-Origin: * and Starlette
// overwrites rather than appends, so ORIGIN_OK would have become decorative.
const DEFAULT_URL = LOCAL ? 'http://localhost:8130' : 'https://drone.topomatch.com';

// For pointing one browser somewhere else without touching the source.
export const OVERRIDE = 'dji.serviceUrl';

// One key, one library. Generated on this device the first time anything needs
// it and kept, so a fresh install is isolated from every other install by
// default -- which is the whole of having more than one user.
//
// It was a constant compiled into the app until 2026-09-09, and that worked
// for exactly one person. Every install shared one namespace, so a second user
// would have read and written the first's plans; worse, sync/protocol.js caps
// the *merged* list at 500 live records and keeps the newest, so an active
// user's plans would have evicted a quiet user's, permanently and with nothing
// said. Isolation is the fix, and the server needed no part of it: it checks
// the shape of a key and never a value.
//
// Still a name rather than a password. Anyone holding your key can read and
// write your library, which is the trade for having nothing to sign up for. A
// real login replaces this with an account id and nothing else changes.
export const KEY_STORE = 'dji.syncKey';

const freshKey = () => {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

// Storage blocked, or none at all under node: the key lives for this page load
// only. Heights still work, because the service asks for a well-formed key and
// not a particular one; sync lands somewhere that will not be there next time,
// which is the honest outcome and better than refusing to start.
let memoryKey = null;

export function serviceKey() {
  try {
    const store = globalThis.localStorage;
    if (store) {
      const got = store.getItem(KEY_STORE);
      if (got && KEY_OK.test(got)) return got;
      const made = freshKey();
      store.setItem(KEY_STORE, made);
      return made;
    }
  } catch { /* blocked; fall through to the per-load key */ }
  return (memoryKey ??= freshKey());
}

// Pasting the other device's key is how two devices come to share one library.
// The local records are not touched: they are merged into whatever that key
// already holds on the next sync, which is what "share this library" means.
export function setServiceKey(key) {
  const trimmed = String(key).trim();
  if (!KEY_OK.test(trimmed)) throw new Error('A key is 16 to 128 letters, digits, - or _.');
  globalThis.localStorage?.setItem(KEY_STORE, trimmed);
  return trimmed;
}

// Every request to the service carries the key, not just the two list routes. It
// lived in synced.js while sync was the only thing that authenticated, and that
// is precisely how /v1/* ended up open: a /v1/tile miss makes the service pull
// ~223 MB of LiDAR from GUGiK (measured, tile 724/724, four sheets at 51-60 MB),
// so an unauthenticated data route is an open pipe pointed at a public agency.
// The service checks the shape of this header rather than its value, because a
// key that ships inside a public app stops crawlers and casual curl and nobody
// who reads the source.
export const serviceHeaders = (extra = {}) => ({ 'X-Sync-Key': serviceKey(), ...extra });

export function serviceUrl() {
  try {
    return (globalThis.localStorage?.getItem(OVERRIDE) ?? DEFAULT_URL).replace(/\/$/, '');
  } catch {
    // A browser with storage blocked still gets the default.
    return DEFAULT_URL;
  }
}
