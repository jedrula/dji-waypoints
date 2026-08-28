# Sync

A single Cloudflare Worker holding the two lists this app keeps, one route each:

| route | list | client |
|---|---|---|
| `POST /sync` | saved plans | `js/plans.js` |
| `POST /obstacles` | the boxes drawn on the map | `js/obstacles.js` |

Both are live. Both work the same way, deliberately. The client sends every record it knows
about, the Worker merges it with what is stored under that sync key and returns
the union; last write wins per id, and a deletion is a tombstone with a
timestamp so it propagates like any other change. Each list gets its own KV
entry (prefix `ns:` for plans, `obs:` for obstacles) under the same namespace
hash, so one list can never be clobbered by a write to the other.

Adding a third list is a row in the `LISTS` table plus a `clean` function saying
what its records look like.

Deployed at <https://dji-waypoints-sync.andrzej-swaton.workers.dev>, which is
what `SYNC_URL` in `js/synced.js` points at.

    wrangler dev --local            # http://localhost:8787, KV in a local emulator
    wrangler deploy                 # push a change live

The KV namespace already exists (`13e721f08df046358f3cee073f427921`, in
wrangler.toml). Recreating it from scratch would be
`wrangler kv namespace create PLANS` and pasting the printed id back in.

There are no accounts, and no key to copy between devices either: the client
sends one hardcoded key (`SYNC_KEY` in `js/synced.js`) as `X-Sync-Key`, so both
devices land in the same store with nothing to set up. The Worker namespaces by
the key's SHA-256, so a dump of KV holds no keys -- but the key ships inside a
public app, so anyone who reads the source can read and write that store. That
is deliberate for one person's plan list. Adding real users later means putting
a login in front of the same storage and using the account id as the namespace;
the Worker does not change.

Point the app at a deployment by setting `dji.syncUrl` in localStorage, or by
editing `SYNC_URL` in `js/synced.js`. Setting `dji.syncUrl` to an empty string
turns sync off for that browser; `localStorage.removeItem('dji.syncUrl')` puts
it back.
