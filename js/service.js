import { KEY_OK } from '../sync/protocol.js';
// Where the service is, and who you are to it.
//
// One address, because there is one service. It measures heights from LiDAR,
// finds the overhead lines, builds the rough model, and holds the two synced
// lists -- see server/README.md. Those arrived at different times and each
// grew its own copy of this rule and its own localStorage key, which meant
// hosting the thing was two edits in two files that had to agree.
//
// There are two of these and there is one table of them. `hosted` went up
// 2026-09-08 on the home Linux box: a second hostname on the Cloudflare tunnel
// that already fronts api.topomatch.com -- the same tunnel and the same
// connector, with the service in the tmux session start-dev.sh builds.
//
// Routing it through that box's gateway on :8000, the way the other services
// there are reached, was the other option and would have cost the allowlist in
// server/src/server.js: the gateway sets Access-Control-Allow-Origin: * and
// Starlette overwrites rather than appends, so ORIGIN_OK would have become
// decorative.
export const SERVICES = {
  local: { url: 'http://localhost:8130', label: 'this machine' },
  hosted: { url: 'https://drone.topomatch.com', label: 'drone.topomatch.com' },
  // Not a service, and in the table because it is a choice: no service at all.
  // Every height stays the marked estimate it was and every list stays on this
  // device, which is how the whole app worked before any of this existed and is
  // still a working way to use it. Naming it keeps that path reachable -- and
  // exercised -- rather than leaving it as code nothing can enter.
  off: { url: '', label: 'none, work offline' },
};

const LOCAL = /^(localhost|127\.0\.0\.1)$/.test(globalThis.location?.hostname ?? '');

// Which one, by name, and it is a name rather than a URL on purpose: this used
// to be localStorage['dji.serviceUrl'] holding an address you had to know and
// type into a console, which is not a way to switch backend. There are two
// backends. Naming them means the app can offer both, say which one it is on,
// and say whether that one is answering -- see the Advanced pane.
//
// `auto` is the default and is almost always right: a page served from this
// machine talks to a service on this machine, and a page served from anywhere
// else has no local service to talk to. Naming one overrules that, which is
// what a local page pointed at the hosted service needs.
export const CHOICE_STORE = 'dji.service';
export const CHOICES = ['auto', ...Object.keys(SERVICES)];

export function serviceChoice() {
  try {
    const got = globalThis.localStorage?.getItem(CHOICE_STORE);
    return CHOICES.includes(got) ? got : 'auto';
  } catch {
    return 'auto';
  }
}

export function setServiceChoice(name) {
  if (!CHOICES.includes(name)) throw new Error(`No service called ${name}.`);
  try {
    globalThis.localStorage?.setItem(CHOICE_STORE, name);
  } catch { /* blocked; the choice lasts this page load, like the key */ }
  return name;
}

// Which one `auto` means here.
export const autoService = () => (LOCAL ? 'local' : 'hosted');

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
  const pick = serviceChoice();
  const name = pick === 'auto' ? autoService() : pick;
  return SERVICES[name].url.replace(/\/$/, '');
}
