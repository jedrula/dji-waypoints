# Working on this repo

## Run both suites

    npm test                 # the app
    cd server && npm test    # the heights/sync service

Both are plain Node, offline, and run in about a second. A change that touches
`sync/protocol.js` touches both.

## No backward compatibility

Cutting edge. When something is replaced, the old one is **deleted** — not kept
behind a flag, not left "in case", not wrapped in a compatibility shim. Two
implementations of one rule is the bug that keeps happening here: the Cloudflare
Worker and the Node service both served the sync routes, and the Node one
imported its merge from the Worker, so a Cloudflare file owned the rules for a
service that is not Cloudflare. If a second copy has to exist for a moment, one
of them imports from the other and the other is on its way out.

Stored data is not a reason to keep code. Ask, then be lossy.

The one exception is a *record* an old build might round-trip: adding a field to
something two devices sync means an old client can drop it and hand it back with
a newer timestamp, and last-write-wins then destroys it silently. See the
`local: isImported` note in `js/obstacles.js`.

## YAGNI, concretely

A distinction has to change behaviour. If "building" and "tree" are measured the
same way and flown the same way, there is no type field. If nothing on screen
displays a number, nothing computes it — `checkObstacles` spent 600 ms a replan
producing distances no code read.

Cut decorative work before it is written. If it is already written and nothing
calls it, delete it: `localBox` survived only because tests imported it.

## DRY where it is dangerous, not everywhere

Deduplicate a rule when two sides of a boundary must agree about it — a merge
policy, a record shape, a protocol. `sync/protocol.js` exists for exactly that,
and its header says why. Do not deduplicate two things that merely look alike;
they will need to differ and the shared version will grow a flag.

## Measure, then write the number down

This codebase argues with numbers and the comments carry them: "median 1.9-2.1x
too big over 755 footprints", "97% under-reported by more than a metre", "worst
error 3.5e-10 m". Do the same. A claim without a measurement behind it does not
go in a comment, a README or a commit message — and if a measurement turns out
not to support the claim, the claim comes out. Benchmark in Node against cached
data, not in a browser; `node --cpu-prof` plus a script that sums `timeDeltas`
finds hot spots that reading never will.

## Degrade to yesterday's behaviour, never to a wrong answer

Every failure path lands on the conservative thing the app did before the
feature existed. A ring that cannot be trusted becomes the bounding box; a
heights service that is down leaves the estimate standing and marked. The app
must never quietly claim to know a number it does not — for heights that is the
difference between a bad photograph and a crash.

## Comments say why, and name the bug

The code is readable; what is not recoverable is the reasoning and the incident.
Write the constraint, the measurement, or the bug that motivated the line —
"this was `levels * 3.2` and it under-reported 97% of them" is worth more than
any restatement of what the code does. Match the surrounding density: this repo
comments heavily and in prose.

## Dependencies: use them, and keep the browser app buildless

Reversed on 2026-09-10, by Andrzej: "i am fine with dependencies, not sure if
we try to be so super duper lightweight, dont reinvent the wheel, i think it
was a wrong policy we took early on to roll everything on our own". So take the
library. Don't write a zip reader, an XML writer or a projection by hand because
a rule said so.

What is worth keeping from the old rule is narrower and still true: **the pages
under `js/` have no build step.** They are plain ES modules served as files,
with Leaflet and three.js from a CDN, and that is what makes the GitHub Pages
copy work by pushing it and a stale module impossible to ship. Anything a
browser has to load stays that way, or it stops being a thing you can open.

Everywhere else — the service, the tools, the desktop build — a dependency is
just a dependency. `laz-perf` was the first, Electron the second.

## Safety is the point

This plans flights near buildings and power lines. Conservative errors are
acceptable and unsafe ones are not, so when a shortcut changes an answer, work
out which direction it errs in and say so. Anything that prunes, caches or
approximates in `js/collide.js`, `js/prism.js` or the altitude search needs an
argument for why it cannot dismiss something close — a lower bound that is too
small only ever costs time.
