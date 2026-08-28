# Duplicate-frame flood at hover — Mini 5 Pro, 27–28 Aug 2026

Investigated 28 Aug 2026 from the aircraft's internal storage (`/Volumes/Untitled`, 45.2 GB
exFAT, 94% full). EXIF headers only — bulk reads were failing, see "The aircraft
keeps dropping off the USB bus" below.

## What was flown

**Aug 27, 15:51:36 → 15:52:24 — 33 photos, idx 0231–0263.** Flat lawnmower grid
at 12 m AGL, gimbal nadir, ~4 m/s, two full up-down-across legs. Clean: every
frame moved 2–6 m from the last, no duplicates. Ends mid-pattern after 48 s, so
the mission was cut short, but what it captured is good.

**Aug 28, 17:54:21 → 18:02:12 — 196 photos, idx 0264–0459.** Three segments: a
short 76 m pass, an orbit climbing 38 → 76 m, then a 168 s descent gap with no
photos, then low work at 3 m AGL. Two stall blocks:

| | frames | files | duration | frozen at |
|---|---|---|---|---|
| Stall A | 26 | 0318–0343 | 17:56:01 → 17:56:37 (36 s) | 76 m, gimbal yaw −153.2°, pitch −87.7° |
| Stall B | 55 | 0405–0459 | 18:00:54 → 18:02:12 (78 s) | 3 m, gimbal yaw −146.7°, pitch −27.3° |

In both blocks GPS moves **≤ 0.08 m between frames**, `FlightXSpeed`/
`FlightYSpeed` read `0.0`, gimbal yaw and pitch are identical to 0.1°, and
exposure is unchanged (1/2000, ISO 100, f/1.8, 4096×3072). Same viewpoint, same
settings, over and over.

**81 of 196 frames (41%) are duplicates, ≈ 1.12 GB.** Stall B runs to the last
file on the card, which is the "huge number of same photos at the last waypoint"
that prompted this.

Stall A is the same bug at a mid-mission hover. It only stopped because the next
leg started, which is why nobody noticed it.

## Root cause: the shutter was on a *timed* interval

The cadence is a near-constant **~1.4–1.5 s** across both flights, while the
distance between consecutive frames ranges **0.42 m to 6.41 m** (CV 0.49),
tracking ground speed. A distance trigger would do the opposite — constant
spacing, variable time.

Decisively: during both stalls the aircraft covered ~0 m and kept firing on the
same 1.4 s beat. A `multipleDistance` trigger cannot fire at zero displacement.

So these flights were **not** using this repo's interval path. `intervalGroupXml`
in `js/wpml.js:130` emits `multipleDistance` with `fwdSpacing`, which goes silent
the moment the aircraft stops. What flew was a time-lapse / Timed Interval
shutter set in the DJI Fly camera UI, and that keeps running through every hover:
waypoint arrival, gimbal settle, and the final hold before RTH.

## Follow up on the controller

1. **Was the camera left in Timed Interval mode in DJI Fly?** That is the
   hypothesis. The camera mode is sticky across flights and overrides what the
   mission asks for.
2. **Were these flown from a KMZ this app generated at all**, or hand-flown /
   built in DJI Fly's own waypoint editor? The flight structure on Aug 28 (orbit
   climbing 38 → 76 m, then a separate 3 m segment) does not obviously match a
   generated plan.
3. If a KMZ was used, pull it off the controller and diff it:
   `npm run check -- theirs.kmz ours.kmz`.

This bears on the open AEB question in `TODO.md` — it is direct evidence that the
camera's own mode, set in DJI Fly, drives the shutter during a waypoint mission
rather than the mission's `takePhoto` actions alone.

## The aircraft keeps dropping off the USB bus

This is the aircraft's **internal storage** — `diskutil` reports the device as a
`File-Stor Gadget` (the Linux USB mass-storage gadget), 45.2 GB, mounted exFAT
via FSKit. There is no microSD to pull out and read in a card reader.

Behaviour, consistent across two replugs:

- On a fresh mount, the first sustained read gets **3–4 MB**, then every read
  returns `Input/output error`.
- Reading in 256 KB chunks and **reopening the file at the failed offset** does
  get through — a full 13.5 MB file came off in 9 s with 23 retries.
- But after a minute or two of that, the aircraft **drops off the bus entirely**
  and the volume unmounts itself. It needs a physical replug to come back.

Untested causes, most likely first: the aircraft browning out under sustained
flash reads (check it is powered on with a well-charged battery, not just drawing
from USB); a marginal or charge-oriented USB-C cable, or a hub in the path; the
aircraft's idle power-off killing the gadget; macOS's FSKit exFAT driver.

At ~9 s per file plus a wedge every minute or two, pulling ~2 GB this way needs
roughly 150 replugs. Worth trying a different cable and a direct port first, or
DJI QuickTransfer over Wi-Fi to a phone instead.

**One unresolved integrity question.** A retried read of `0231` came back the
right length but with no JPEG EOI marker at the end. Either DJI appends data past
EOI, or a retried read can silently return a wrong block. Until that is settled,
anything copied off must be content-verified, not just length-checked.
`tools/pull-media.py` decodes every image it pulls and re-reads any file that
needed a retry, comparing the two.

**Nothing has been deleted.** Writing to a volume that unmounts itself mid-
operation is how exFAT directories get destroyed. Deletion waits until the
keepers are safely copied off and the connection holds.

## Prepared for when it reads again

- `2026-08-28-duplicates.txt` — the exact 81 filenames to delete.
- `2026-08-28-keep.txt` — the 148 keepers (33 from Aug 27, 115 from Aug 28).
- `exif-2026-08-27.tsv`, `exif-2026-08-28.tsv` — the extracted EXIF this rests on.

Copy the keepers into `captures/` (gitignored) first, verify, then delete. The
resilient copier is `tools/pull-media.py` — chunked reads, reopen-and-retry, full
image decode, and a second read of anything that needed a retry. It skips files
already present, so it can be re-run after each disconnect and picks up where it
left off.

One frame is deliberately kept immediately before each stall — `0317` and `0404`
— as the legitimate arrival shot for that waypoint.
