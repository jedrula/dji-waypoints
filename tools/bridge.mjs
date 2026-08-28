#!/usr/bin/env node
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, mkdtempSync, existsSync, copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { checkKmz } from './check.mjs';

// Transports for getting a KMZ into DJI Fly's mission folder on a controller.
//
// On a DJI RC 2 the only one that works is MTP. adb is a dead end: published
// work on this controller (KATMAI, Android 11) found the ADB interface held
// offline, with key injection, wireless pairing and property toggles all
// refused. The RC does expose a USB still-image interface, which is MTP, and
// DJI leaves /Android/data browsable through it.
//
//   waypoint/<UUID>/<UUID>.kmz
//
// DJI Fly only lists folders it created itself, so installing always means
// overwriting the file inside an existing folder -- there is no "add". Three
// ways to reach it: MTP (the DJI RC), a plain directory (an SD card, a mount, a
// copy on disk), or adb (an Android device that allows it, which the RC 2 does not).

export const FLY_DIR = 'Android/data/dji.go.v5/files/waypoint';
export const MTP_TOOL_SRC = new URL('./mtptool.c', import.meta.url).pathname;
export const MTP_TOOL = new URL('./mtptool', import.meta.url).pathname;
export const REMOTE = `/sdcard/${FLY_DIR}`;
export const BACKUP_DIR = 'backups';

/* ---------- adb ---------- */

// Android Studio ships adb but does not put it on PATH, which is the usual
// reason this looks unavailable on a Mac that plainly has it.
let adbCache;
export function adbBin() {
  if (adbCache !== undefined) return adbCache;
  const candidates = [
    process.env.ADB,
    'adb',
    join(homedir(), 'Library/Android/sdk/platform-tools/adb'),
    '/opt/homebrew/bin/adb',
    '/usr/local/bin/adb',
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      execFileSync(c, ['version'], { stdio: 'ignore' });
      adbCache = c;
      return c;
    } catch { /* next */ }
  }
  adbCache = null;
  return null;
}

function adb(args, opts = {}) {
  const bin = adbBin();
  if (!bin) throw new Error('adb not found');
  return execFileSync(bin, args, { encoding: 'utf8', maxBuffer: 1 << 26, ...opts });
}

// `adb devices -l` lines look like:
//   1ABC2DEF  device product:rm620 model:DJI_RC2 device:rm620 transport_id:3
// unauthorized means the controller has not accepted this Mac's key yet, which
// is a prompt on its screen rather than an error worth failing on.
export function adbDevices() {
  if (!adbBin()) return [];
  let out;
  try { out = adb(['devices', '-l']); } catch { return []; }
  return out.split('\n').slice(1).map((l) => l.trim()).filter(Boolean).map((line) => {
    const [serial, state, ...rest] = line.split(/\s+/);
    const kv = Object.fromEntries(rest.map((p) => p.split(':')).filter((p) => p.length === 2));
    return { serial, state, model: (kv.model ?? '').replace(/_/g, ' ') || null };
  });
}

/* ---------- mtp ---------- */

// macOS hands every still-image USB device to Image Capture the moment it is
// plugged in, and ptpcamerad then holds the interface libmtp needs. It is
// launchd-managed and comes straight back, so the only thing that works is to
// kill it immediately before each command rather than once at the start.
function shooAwayImageCapture() {
  try { execFileSync('/usr/bin/killall', ['-9', 'ptpcamerad', 'mscamerad-xpc'], { stdio: 'ignore' }); } catch { /* not running */ }
}

let mtpToolChecked = false;
export function mtpTool() {
  if (mtpToolChecked) return existsSync(MTP_TOOL) ? MTP_TOOL : null;
  mtpToolChecked = true;
  const srcNewer = existsSync(MTP_TOOL)
    ? statSync(MTP_TOOL_SRC).mtimeMs > statSync(MTP_TOOL).mtimeMs
    : true;
  if (srcNewer) {
    // libmtp's own CLI cannot write into a folder -- it has no way to name a
    // parent, so it aims at the storage root with no storage id and the RC
    // rejects it. Fifty lines of C against the same library can.
    try {
      const flags = execFileSync('pkg-config', ['--cflags', '--libs', 'libmtp'], { encoding: 'utf8' }).trim().split(/\s+/);
      execFileSync('cc', [MTP_TOOL_SRC, ...flags, '-o', MTP_TOOL], { stdio: 'pipe' });
    } catch {
      return null;
    }
  }
  return existsSync(MTP_TOOL) ? MTP_TOOL : null;
}

function mtp(args) {
  const bin = mtpTool();
  if (!bin) throw new Error('mtp helper unavailable — needs libmtp (brew install libmtp) and a compiler');
  shooAwayImageCapture();
  const out = execFileSync(bin, args, { encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'pipe'] });
  return out;
}

// "d|f<TAB>id<TAB>size<TAB>name" per line.
function mtpList(path) {
  return mtp(['ls', path]).split('\n').filter(Boolean).map((line) => {
    const [kind, id, size, ...rest] = line.split('\t');
    return { dir: kind === 'd', id: Number(id), size: Number(size), name: rest.join('\t') };
  });
}

// Opening an MTP session on this controller costs several seconds, which is far
// too slow for "is anything plugged in?". The USB registry answers that in
// milliseconds, and DJI's vendor id is enough to know.
const DJI_VENDOR_ID = 11427; // 0x2ca3
export function mtpDevices() {
  if (!mtpTool()) return [];
  if (process.platform !== 'darwin') {
    try { mtpList(FLY_DIR); return [{ serial: 'mtp', model: 'DJI controller (MTP)' }]; } catch { return []; }
  }
  try {
    const out = execFileSync('/usr/sbin/ioreg', ['-p', 'IOUSB', '-w0', '-l'],
      { encoding: 'utf8', maxBuffer: 1 << 26 });
    if (!out.includes(`"idVendor" = ${DJI_VENDOR_ID}`)) return [];
    const serial = /"USB Serial Number" = "([^"]+)"/.exec(out)?.[1] ?? 'mtp';
    return [{ serial: 'mtp', model: 'DJI controller', detail: serial }];
  } catch {
    return [];
  }
}

/* ---------- transports ---------- */

// A transport is addressed by a single string so it survives a round trip
// through a URL query or a JSON body: "adb:SERIAL" or "dir:/some/path".
export function parseTransport(id) {
  const i = String(id ?? '').indexOf(':');
  if (i < 0) throw new Error(`bad transport id: ${id}`);
  const kind = id.slice(0, i);
  const ref = id.slice(i + 1);
  if (!['adb', 'dir', 'mtp'].includes(kind)) throw new Error(`unknown transport: ${kind}`);
  return { id, kind, ref };
}

// Somewhere the controller's storage is visible as a plain directory.
export function findMountedDests() {
  const hits = [];
  for (const root of ['/Volumes']) {
    if (!existsSync(root)) continue;
    for (const vol of readdirSync(root)) {
      const p = join(root, vol, FLY_DIR);
      if (existsSync(p)) hits.push(p);
    }
  }
  return hits;
}

export function detect() {
  const transports = [];
  for (const d of mtpDevices()) {
    transports.push({ id: `mtp:${d.serial}`, kind: 'mtp', label: d.model, detail: d.detail ?? 'USB · MTP' });
  }
  for (const d of adbDevices()) {
    if (d.state !== 'device') continue;
    transports.push({
      id: `adb:${d.serial}`,
      kind: 'adb',
      label: d.model ?? 'Android device',
      detail: d.serial,
    });
  }
  for (const dest of findMountedDests()) {
    transports.push({ id: `dir:${dest}`, kind: 'dir', label: 'Mounted volume', detail: dest });
  }
  // An escape hatch for anything that puts the waypoint folder somewhere odd --
  // an SD card, a copy pulled off the controller, a test fixture.
  if (process.env.BRIDGE_DIR && existsSync(process.env.BRIDGE_DIR)) {
    transports.push({ id: `dir:${process.env.BRIDGE_DIR}`, kind: 'dir', label: 'Folder', detail: process.env.BRIDGE_DIR });
  }

  const notes = [];
  if (!mtpTool()) notes.push('no MTP helper — `brew install libmtp pkg-config` to talk to a DJI RC');
  const bin = adbBin();
  if (!bin) {
    notes.push('adb not found — install Android platform-tools, or set ADB=/path/to/adb');
  } else {
    // A DJI RC always shows up here as "offline" -- its adb interface is held
    // shut by DJI. Saying so when MTP already works is just noise.
    const pending = transports.length ? [] : adbDevices().filter((d) => d.state !== 'device');
    for (const d of pending) {
      notes.push(d.state === 'unauthorized'
        ? `${d.serial}: waiting for you to allow USB debugging on the controller's screen`
        : `${d.serial}: ${d.state}`);
    }
    if (!transports.length && !pending.length) {
      notes.push('no device — plug the controller in over USB and turn on USB debugging');
    }
  }
  return { transports, notes, adb: bin };
}

/* ---------- slots ---------- */

function describe(buf, extra = {}) {
  const slot = { size: buf.length, ...extra };
  try {
    const { info, errors } = checkKmz(buf);
    slot.waypoints = info.waypoints;
    slot.flavour = info.flavour;
    slot.drone = info.drone;
    slot.valid = errors.length === 0;
  } catch {
    slot.waypoints = null;
    slot.valid = false;
  }
  return slot;
}

function listSlotsDir(dest) {
  if (!existsSync(dest)) throw new Error(`no such directory: ${dest}`);
  const slots = [];
  for (const id of readdirSync(dest)) {
    const dir = join(dest, id);
    let st;
    try { st = statSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;
    const kmz = join(dir, `${id}.kmz`);
    if (!existsSync(kmz)) { slots.push({ id, exists: false, mtime: st.mtime.toISOString() }); continue; }
    slots.push({ id, exists: true, mtime: statSync(kmz).mtime.toISOString(), ...describe(readFileSync(kmz)) });
  }
  return slots;
}

function listSlotsAdb(serial) {
  const ids = adb(['-s', serial, 'shell', 'ls', REMOTE])
    .split('\n').map((l) => l.trim().replace(/\r$/, '')).filter(Boolean);
  if (ids.some((l) => /No such file|Permission denied/i.test(l))) {
    throw new Error(`cannot read ${REMOTE} on the controller (${ids[0]})`);
  }
  // ls -l on toybox: "-rw-rw---- 1 u0_a1 ext_data_rw 404185 2026-08-26 10:38 X.kmz"
  const mtimes = new Map();
  try {
    for (const line of adb(['-s', serial, 'shell', 'ls', '-l', REMOTE]).split('\n')) {
      const m = line.match(/(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s+(\S+)\s*$/);
      if (m) mtimes.set(m[3], new Date(`${m[1]}T${m[2]}`).toISOString());
    }
  } catch { /* dates are a nicety */ }

  return ids.map((id) => {
    let buf = null;
    try { buf = pullAdb(serial, id); } catch { /* folder without a kmz */ }
    return buf
      ? { id, exists: true, mtime: mtimes.get(id) ?? null, ...describe(buf) }
      : { id, exists: false, mtime: mtimes.get(id) ?? null };
  });
}

function listSlotsMtp() {
  const out = mkdtempSync(join(tmpdir(), 'dji-slots-'));
  try {
    const lines = mtp(['slots', FLY_DIR, out]).split('\n').filter(Boolean);
    const slots = [];
    for (const line of lines) {
      const [name, kind] = line.split('\t');
      // DJI keeps its own map_preview and capability folders in here; a mission
      // is a folder named with a UUID holding one identically named kmz.
      if (!/^[0-9A-Fa-f-]{36}$/.test(name)) continue;
      if (kind !== 'kmz') { slots.push({ id: name, exists: false, mtime: null }); continue; }
      slots.push({ id: name, exists: true, mtime: null, ...describe(readFileSync(join(out, `${name}.kmz`))) });
    }
    return slots;
  } finally {
    try { rmSync(out, { recursive: true, force: true }); } catch { /* nothing to clean */ }
  }
}

export function listSlots(transportId) {
  const t = parseTransport(transportId);
  const slots = t.kind === 'adb' ? listSlotsAdb(t.ref)
    : t.kind === 'mtp' ? listSlotsMtp()
    : listSlotsDir(t.ref);
  // Newest first: the throwaway mission you just made in DJI Fly to free up a
  // slot is the one you almost certainly want to overwrite.
  return slots.sort((a, b) => String(b.mtime ?? '').localeCompare(String(a.mtime ?? '')));
}

/* ---------- read / write ---------- */

function pullAdb(serial, id) {
  const tmp = join(tmpdir(), `dji-bridge-${randomUUID()}.kmz`);
  try {
    adb(['-s', serial, 'pull', `${REMOTE}/${id}/${id}.kmz`, tmp], { stdio: ['ignore', 'pipe', 'pipe'] });
    return readFileSync(tmp);
  } finally {
    try { rmSync(tmp, { force: true }); } catch { /* nothing to clean */ }
  }
}

// Reading a real mission back off the controller is how you settle what DJI Fly
// itself writes for this aircraft -- feed it to `npm run check -- ours.kmz it.kmz`.
function pullMtp(id) {
  const tmp = join(tmpdir(), `dji-bridge-${randomUUID()}.kmz`);
  try {
    mtp(['get', `${FLY_DIR}/${id}`, `${id}.kmz`, tmp]);
    return readFileSync(tmp);
  } finally {
    try { rmSync(tmp, { force: true }); } catch { /* nothing to clean */ }
  }
}

export function pullSlot(transportId, id) {
  const t = parseTransport(transportId);
  if (t.kind === 'adb') return pullAdb(t.ref, id);
  if (t.kind === 'mtp') return pullMtp(id);
  return readFileSync(join(t.ref, id, `${id}.kmz`));
}

function backup(id, buf) {
  mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const to = join(BACKUP_DIR, `${id}-${stamp}.kmz`);
  writeFileSync(to, buf);
  return to;
}

// Never write a KMZ the validator rejects: a bad file does not fail visibly in
// DJI Fly, it just silently refuses to open the mission you are standing next to.
export function install(transportId, slotId, bytes) {
  const buf = Buffer.from(bytes);
  const { errors, warnings, info } = checkKmz(buf);
  if (errors.length) throw new Error(`refusing to install: ${errors[0]}`);

  const t = parseTransport(transportId);
  let saved = null;
  try { saved = backup(slotId, pullSlot(transportId, slotId)); } catch { /* empty slot */ }

  if (t.kind === 'mtp') {
    const tmp = join(tmpdir(), `dji-bridge-${randomUUID()}.kmz`);
    writeFileSync(tmp, buf);
    try {
      mtp(['put', tmp, `${FLY_DIR}/${slotId}`, `${slotId}.kmz`]);
    } finally {
      try { rmSync(tmp, { force: true }); } catch { /* nothing to clean */ }
    }
  } else if (t.kind === 'adb') {
    const tmp = join(tmpdir(), `dji-bridge-${randomUUID()}.kmz`);
    writeFileSync(tmp, buf);
    try {
      adb(['-s', t.ref, 'push', tmp, `${REMOTE}/${slotId}/${slotId}.kmz`], { stdio: ['ignore', 'pipe', 'pipe'] });
    } finally {
      try { rmSync(tmp, { force: true }); } catch { /* nothing to clean */ }
    }
  } else {
    const dir = join(t.ref, slotId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${slotId}.kmz`), buf);
  }
  return { slot: slotId, backup: saved, waypoints: info.waypoints, warnings };
}

/* ---------- cli ---------- */

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'detect' || !cmd) {
    const d = detect();
    console.log(`adb: ${d.adb ?? 'not found'}`);
    if (!d.transports.length) console.log('no controller reachable');
    for (const t of d.transports) console.log(`  ${t.id}  ${t.label} (${t.detail})`);
    for (const n of d.notes) console.log(`  note: ${n}`);
    return;
  }
  if (cmd === 'slots') {
    const id = rest[0] ?? detect().transports[0]?.id;
    if (!id) { console.error('no transport'); process.exit(2); }
    for (const s of listSlots(id)) {
      console.log(`  ${s.id}  ${s.mtime ?? '?'}  ${s.exists ? `${s.waypoints ?? '?'} wp` : '(empty)'}`);
    }
    return;
  }
  console.error('usage: bridge.mjs [detect|slots <transport>]');
  process.exit(2);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
