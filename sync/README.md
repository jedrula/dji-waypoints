# Plan sync

A single Cloudflare Worker behind `POST /sync`. The client sends every plan it
knows about, the Worker merges it with what is stored under that sync key and
returns the union; last write wins per plan id, and a deletion is a tombstone
with a timestamp so it propagates like any other change.

Deployed at <https://dji-waypoints-sync.andrzej-swaton.workers.dev>, which is
what `SYNC_URL` in `js/plans.js` points at.

    wrangler dev --local            # http://localhost:8787, KV in a local emulator
    wrangler deploy                 # push a change live

The KV namespace already exists (`13e721f08df046358f3cee073f427921`, in
wrangler.toml). Recreating it from scratch would be
`wrangler kv namespace create PLANS` and pasting the printed id back in.

There are no accounts, and no key to copy between devices either: the client
sends one hardcoded key (`SYNC_KEY` in `js/plans.js`) as `X-Sync-Key`, so both
devices land in the same store with nothing to set up. The Worker namespaces by
the key's SHA-256, so a dump of KV holds no keys -- but the key ships inside a
public app, so anyone who reads the source can read and write that store. That
is deliberate for one person's plan list. Adding real users later means putting
a login in front of the same storage and using the account id as the namespace;
the Worker does not change.

Point the app at a deployment by setting `dji.syncUrl` in localStorage, or by
editing `SYNC_URL` in `js/plans.js`.
