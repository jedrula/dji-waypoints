// Where the service is.
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

// The whole of "logging in", until there is anything to log in to. One person,
// two devices, one key, compiled into the app -- which means it is as public as
// the app is, and anyone reading this file can read and write the lists. That
// is the trade for having no key to copy between devices, and it holds only
// while a plan list is the sort of thing worth nobody's trouble. A real login
// replaces this constant with an account id; nothing else changes.
export const SERVICE_KEY = 'andrzej-H5rGhCrCRmPXoRSFUA8etg';

// Every request to the service carries it, not just the two list routes. It
// lived in synced.js while sync was the only thing that authenticated, and that
// is precisely how /v1/* ended up open: a /v1/tile miss makes the service pull
// ~223 MB of LiDAR from GUGiK (measured, tile 724/724, four sheets at 51-60 MB),
// so an unauthenticated data route is an open pipe pointed at a public agency.
// The service checks the shape of this header rather than its value, because a
// key that ships inside a public app stops crawlers and casual curl and nobody
// who reads the source.
export const serviceHeaders = (extra = {}) => ({ 'X-Sync-Key': SERVICE_KEY, ...extra });

export function serviceUrl() {
  try {
    return (globalThis.localStorage?.getItem(OVERRIDE) ?? DEFAULT_URL).replace(/\/$/, '');
  } catch {
    // A browser with storage blocked still gets the default.
    return DEFAULT_URL;
  }
}
