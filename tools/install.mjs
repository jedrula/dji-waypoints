#!/usr/bin/env node
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { checkKmz } from './check.mjs';

// DJI Fly has no import button. A mission lives as
//   waypoint/<UUID>/<UUID>.kmz
// and the app only sees folders it created itself, so installing means
// overwriting the file inside an existing folder. This does that without
// hand-typing a UUID, and refuses to write a KMZ that fails validation.

const FLY_DIR = 'Android/data/dji.go.v5/files/waypoint';
const BACKUP = 'backups';

function adbAvailable() {
  try {
    const out = execFileSync('adb', ['devices'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n').slice(1).some((l) => /\tdevice$/.test(l.trim()));
  } catch { return false; }
}

// Somewhere the controller's storage is visible as a plain directory.
function findMountedDest() {
  const roots = ['/Volumes'];
  const hits = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const vol of readdirSync(root)) {
      const p = join(root, vol, FLY_DIR);
      if (existsSync(p)) hits.push(p);
    }
  }
  return hits;
}

function listSlots(dest) {
  if (!existsSync(dest)) throw new Error(`no such directory: ${dest}`);
  const slots = [];
  for (const name of readdirSync(dest)) {
    const dir = join(dest, name);
    let st;
    try { st = statSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;
    const kmz = join(dir, `${name}.kmz`);
    const entry = { id: name, dir, kmz, exists: existsSync(kmz), mtime: st.mtime };
    if (entry.exists) {
      entry.size = statSync(kmz).size;
      try {
        const { info, errors } = checkKmz(readFileSync(kmz));
        entry.waypoints = info.waypoints;
        entry.flavour = info.flavour;
        entry.valid = errors.length === 0;
      } catch { entry.waypoints = '?'; }
    }
    slots.push(entry);
  }
  return slots.sort((a, b) => b.mtime - a.mtime);
}

// Only folders that already hold a kmz are installable, and those are what
// --slot indexes. Anything else is listed without a number so the index you
// read is always the index you can use.
function printSlots(slots) {
  const usable = slots.filter((s) => s.exists);
  const rest = slots.filter((s) => !s.exists);
  if (!usable.length) {
    console.log('  (no mission to overwrite — create a throwaway waypoint mission in DJI Fly first)');
  }
  usable.forEach((s, i) => {
    const when = s.mtime.toISOString().replace('T', ' ').slice(0, 16);
    const flag = s.valid === false ? '  INVALID' : '';
    console.log(`  [${i}] ${s.id}  ${when}  ${String(s.waypoints ?? '?').padStart(4)} wp  ${String(s.size).padStart(8)} B${flag}`);
  });
  for (const s of rest) console.log(`   -   ${s.id}  (no kmz inside — not installable)`);
}

async function confirm(question, auto) {
  if (auto) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
  rl.close();
  return a === 'y' || a === 'yes';
}

function backup(file, tag) {
  mkdirSync(BACKUP, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const to = join(BACKUP, `${tag}-${stamp}.kmz`);
  copyFileSync(file, to);
  return to;
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name) => argv.includes(name);
  const opt = (name, def) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : def;
  };
  const files = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--dest' && argv[i - 1] !== '--slot');
  const auto = flag('--yes');
  const useAdb = flag('--adb');

  if (flag('--help') || (!files.length && !flag('--list'))) {
    console.log(`
Install a planned mission into DJI Fly's waypoint folder.

  node tools/install.mjs --list [--dest DIR]
  node tools/install.mjs mission.kmz [--dest DIR] [--slot UUID|INDEX] [--yes]
  node tools/install.mjs part1.kmz part2.kmz --dest DIR      # one slot each
  node tools/install.mjs mission.kmz --adb                   # over adb
  node tools/install.mjs mission.kmz --rename-only -o DIR    # just name it right

Without --dest it looks for ${FLY_DIR} under /Volumes, then tries adb.
Whatever it replaces is copied to ./${BACKUP}/ first.
`);
    process.exit(flag('--help') ? 0 : 2);
  }

  // --rename-only: no device involved, just produce correctly named copies.
  if (flag('--rename-only')) {
    const out = opt('-o', '.');
    mkdirSync(out, { recursive: true });
    for (const f of files) {
      const { errors } = checkKmz(readFileSync(f));
      if (errors.length) { console.error(`refusing ${f}: ${errors[0]}`); process.exit(1); }
      const id = randomUUID().toUpperCase();
      const dir = join(out, id);
      mkdirSync(dir, { recursive: true });
      copyFileSync(f, join(dir, `${id}.kmz`));
      console.log(`${f} -> ${join(dir, `${id}.kmz`)}`);
    }
    console.log('\nCopy these folders into ' + FLY_DIR + ' on the controller.');
    return;
  }

  let dest = opt('--dest');
  let adb = useAdb;
  if (!dest && !adb) {
    const mounted = findMountedDest();
    if (mounted.length === 1) { dest = mounted[0]; console.log(`found ${dest}`); }
    else if (mounted.length > 1) {
      console.error('several candidates, pass one with --dest:');
      mounted.forEach((m) => console.error(`  ${m}`));
      process.exit(2);
    } else if (adbAvailable()) { adb = true; console.log('no mounted volume; using adb'); }
    else {
      console.error(`could not find ${FLY_DIR}.
Connect the controller and mount its storage, then pass --dest <path>,
or use --rename-only to prepare folders you can copy across by hand.`);
      process.exit(2);
    }
  }

  if (adb) {
    if (!adbAvailable()) { console.error('adb: no device in "device" state'); process.exit(2); }
    const remote = `/sdcard/${FLY_DIR}`;
    const out = execFileSync('adb', ['shell', 'ls', remote], { encoding: 'utf8' }).trim();
    const ids = out.split('\n').map((l) => l.trim()).filter(Boolean);
    if (flag('--list')) {
      console.log(`\n${remote}`);
      ids.forEach((id, i) => console.log(`  [${i}] ${id}`));
      return;
    }
    const slotArg = opt('--slot');
    const target = slotArg && !/^\d+$/.test(slotArg) ? slotArg : ids[+(slotArg ?? 0)];
    if (!target) { console.error('no mission folder on the device to overwrite'); process.exit(1); }
    const { errors } = checkKmz(readFileSync(files[0]));
    if (errors.length) { console.error(`refusing to install: ${errors[0]}`); process.exit(1); }
    console.log(`\n  ${files[0]}\n  -> ${remote}/${target}/${target}.kmz`);
    if (!(await confirm('overwrite that mission?', auto))) return;
    execFileSync('adb', ['pull', `${remote}/${target}/${target}.kmz`, join(BACKUP, `${target}.kmz`)], { stdio: 'ignore' });
    execFileSync('adb', ['push', files[0], `${remote}/${target}/${target}.kmz`], { stdio: 'inherit' });
    console.log('\ndone — restart DJI Fly to see it.');
    return;
  }

  dest = resolve(dest);
  const slots = listSlots(dest);

  if (flag('--list')) {
    console.log(`\n${dest}`);
    printSlots(slots);
    return;
  }

  const usable = slots.filter((s) => s.exists);
  if (!usable.length) {
    console.error(`\n${dest} has no mission folder to overwrite.
Create a throwaway waypoint mission in DJI Fly first — that makes the folder.`);
    process.exit(1);
  }

  const slotArg = opt('--slot');
  let chosen;
  if (slotArg === undefined) {
    console.log(`\n${dest}`);
    printSlots(slots);
    console.log('');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const a = (await rl.question(`overwrite which slot? [0-${usable.length - 1}] `)).trim();
    rl.close();
    chosen = usable[+a];
  } else {
    chosen = /^\d+$/.test(slotArg) ? usable[+slotArg] : usable.find((s) => s.id === slotArg);
  }
  if (!chosen) { console.error('no such slot'); process.exit(1); }

  // One slot per file: the chosen one, then the next ones down the list.
  const start = usable.indexOf(chosen);
  if (files.length > usable.length - start) {
    console.error(`${files.length} files but only ${usable.length - start} slot(s) from there.
Create more throwaway missions in DJI Fly, or install fewer parts at a time.`);
    process.exit(1);
  }

  const plan = files.map((f, i) => ({ file: f, slot: usable[start + i] }));
  console.log('');
  for (const { file, slot } of plan) {
    const { errors, warnings, info } = checkKmz(readFileSync(file));
    if (errors.length) {
      console.error(`refusing to install ${file}:`);
      errors.slice(0, 5).forEach((e) => console.error(`  ${e}`));
      process.exit(1);
    }
    warnings.slice(0, 3).forEach((w) => console.log(`  warn  ${w}`));
    console.log(`  ${basename(file)}  (${info.waypoints} wp, ${info.flavour})\n     -> ${slot.kmz}`);
  }
  console.log('');
  if (!(await confirm(`overwrite ${plan.length} mission(s)?`, auto))) { console.log('cancelled'); return; }

  for (const { file, slot } of plan) {
    const saved = backup(slot.kmz, slot.id);
    writeFileSync(slot.kmz, readFileSync(file));
    console.log(`  installed ${basename(file)} -> ${slot.id}  (old copy: ${saved})`);
  }
  console.log('\ndone — restart DJI Fly to see the missions.');
}

main().catch((e) => { console.error(e.message); process.exit(1); });
