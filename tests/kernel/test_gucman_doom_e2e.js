#!/usr/bin/env node
// #420 acceptance: DOOM is a DEFAULT PACKAGE, not baked mass.
//
// The shape (#419's mechanism, doom as its first real member):
//
//   - packages/doom.json carries the binary (vendor/doom/bin.json), the
//     shareware WAD and a quake-pattern self-locating launcher (d_iwad.c's
//     BuildIWADDirList puts "." first, so cd-to-the-package-dir is the whole
//     WAD resolution — no vendored-source patch).
//   - os/image.json no longer bakes /usr/bin/doom, the Games menu link, the
//     Desktop link or /root/doom1.wad; instead `defaultPackages` names doom,
//     so bakeSystemImage writes it into /usr/share/gucman/defaults and every
//     boot's `gucman sync-defaults` service pulls it in.
//
// Sessions (two driveBoots — the reboot IS the point):
//   A. Clean minimal first boot, OFFLINE (the baked repo default is
//      origin-relative /packages, which is unreachable headless): doom is
//      ABSENT everywhere it used to be baked (the negative controls that
//      make this file non-vacuous — every one of them FAILS on the
//      unconverted tree, where doom is still baked), the baked defaults
//      file names doom, and sync-defaults fails LEGIBLY (status `failed` +
//      `failed doom`, a real message — never a dead menu entry) with the OS
//      unharmed. Then a reachable repo is declared via /etc for the reboot.
//   B. The retry boot — the headless equivalent of "clean first boot with
//      network": sync-defaults installs doom with ZERO user action, the WAD
//      is byte-exact through fetch→inflate→untar→BlockFS (in-OS sha256sum vs
//      the vendored file), `doom` REALLY boots to its "DOOM Shareware"
//      window off the installed WAD, and `gucman remove doom` replays clean.
//
// On the unconverted tree this file fails RED twice over: session A's
// absence legs trip on the still-baked /bin/doom + /root/doom1.wad, and
// ensurePackages(['doom']) refuses because packages/doom.json does not
// exist (the quake-e2e precedent, both failure modes by design).
//
// Run: node tests/kernel/test_gucman_doom_e2e.js
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { driveBoot, freshImage } = require('./lib/drive.js');
const { ROOT, ensureMinimalImage, ensurePackages, startServer } = require('./lib/gucman.js');

// Not drive.js section(): doom's own startup banner is a bar of '='s, which
// splits any '=='-delimited section spanning a running game (the quake-e2e
// lesson). '@@' never appears in doom's output.
function sect(out, name) {
  const parts = String(out).split('@@' + name + '\n');
  return parts.length > 1 ? parts[1].split('@@')[0] : '';
}

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const STATUS = '/run/gucman-sync.status';
// Bounded poll on the sync's real completion marker (the 0171 rule — never
// a fixed sleep, never a wait expected to time out).
const waitFile = (p, secs, tag) =>
  `n=0; while [ ! -e ${p} ] && [ $n -lt ${secs * 2} ]; do sleep 0.5; n=$((n+1)); done; ` +
  `test -e ${p} && echo WAIT-OK-${tag} || echo WAIT-TIMEOUT-${tag}`;

async function main() {
  const MIN = ensureMinimalImage();
  const { dir: tmp, image } = freshImage('os-gucman-doom-');
  fs.copyFileSync(MIN, image);   // copy mtime = now -> input-fresh at boot

  const wad = fs.readFileSync(path.join(ROOT, 'vendor', 'doom', 'data', 'doom1.wad'));
  const wadSha = crypto.createHash('sha256').update(wad).digest('hex');

  // The package repo is only needed for session B, but build it before any
  // boot so a broken definition fails the run in seconds, not minutes.
  // (On the unconverted tree session A's absence legs are the red that
  // NAMES the problem, so they run first — this throw is the backstop.)
  let repo, port;
  const BOOT_ARGS = { image, args: ['--packages=none'], timeout: 420000 };

  /* ---- session A: clean minimal first boot, offline ---- */
  const sA = driveBoot([
    'echo @@absent',
    'test ! -e /bin/doom && echo NO-BAKED-BIN',
    'test ! -e /usr/share/menu/Games/doom && echo NO-BAKED-MENU',
    'test ! -e /root/doom1.wad && echo NO-WAD-IN-HOME',
    'test ! -e /root/Desktop/doom && echo NO-DESK-LINK',
    'echo @@defaults',
    'grep -x doom /usr/share/gucman/defaults && echo DEFAULTS-NAME-DOOM',
    waitFile(STATUS, 150, 'STATUS-A'),
    `cat ${STATUS}`,
    'gucman list',
    'echo @@done',
  ], BOOT_ARGS);
  // The repo URL is declared in a tiny second boot below rather than here:
  // session A's sync must be genuinely offline (the baked origin-relative
  // /packages default), not pointed at a dead port we invented.
  const outA = String(sA.stdout || '');

  const abs = sect(outA, 'absent');
  check('minimal image has no baked /bin/doom', abs.includes('NO-BAKED-BIN'), abs);
  check('minimal image has no baked Games/doom menu entry', abs.includes('NO-BAKED-MENU'));
  check('no /root/doom1.wad seed (the WAD moved into the package)',
    abs.includes('NO-WAD-IN-HOME'));
  check('no baked Desktop/doom link', abs.includes('NO-DESK-LINK'));

  const defs = sect(outA, 'defaults');
  check('baked /usr/share/gucman/defaults names doom (bakeSystemImage from defaultPackages)',
    defs.includes('DEFAULTS-NAME-DOOM'), defs);
  check('sync-defaults concluded on the first boot (status file written)',
    defs.includes('WAIT-OK-STATUS-A'), defs);
  check('offline first boot degrades LEGIBLY: status is failed + names doom (retries next boot)',
    /^failed$/m.test(defs) && /^failed doom$/m.test(defs), defs);
  check('the OS is unharmed: nothing installed, gucman list still works',
    defs.includes('no packages installed'), defs);

  /* ---- interlude: build the repo, then declare it via /etc ---- */
  repo = ensurePackages(['doom']);
  port = await startServer(repo.dir);
  console.log(`[gucman-doom] repo :${port} (payload ${(repo.index.packages.doom.payload.size / (1 << 20)).toFixed(1)} MiB)`);
  const sArm = driveBoot([
    'echo @@arm2',
    'mkdir -p /etc/gucman',
    `echo http://127.0.0.1:${port} > /etc/gucman/repos`,
    `rm -f ${STATUS}`,   // next boot's sync is the writer session B waits on
    'echo ARMED',
    'echo @@done',
  ], BOOT_ARGS);
  check('repo declared for the retry boot', sect(String(sArm.stdout || ''), 'arm2').includes('ARMED'));

  /* ---- session B: the retry boot with a reachable repo ---- */
  const sB = driveBoot([
    'echo @@sync',
    waitFile(STATUS, 150, 'STATUS-B'),
    `cat ${STATUS}`,
    'test -e /var/lib/gucman/doom.json && echo DOOM-DB-OK',
    'readlink /usr/local/bin/doom',
    'test -x /opt/doom/doom-bin && echo OPT-BINARY-OK',
    'test -x /opt/doom/doom && echo LAUNCHER-OK',
    'readlink /etc/menu/Games/doom',
    'test ! -e /opt/.staging.doom && echo NO-STAGING',
    'echo @@wad',
    'wc -c < /opt/doom/doom1.wad',
    'sha256sum /opt/doom/doom1.wad',
    'echo @@launch',
    'doom &',
    'wmctl wait win "DOOM Shareware"',
    'wmctl list; echo LIST-RC=$?',
    // pkill, not `kill %1`: the job is the launcher sh, which WAITS on the
    // game as a separate pid (the quake launcher contract — no exec).
    'pkill doom',
    'wmctl wait nowin "DOOM Shareware"',
    'echo @@remove',
    'gucman remove doom; echo RC=$?',
    'test ! -e /opt/doom && echo OPT-GONE',
    'test ! -e /usr/local/bin/doom && echo LINK-GONE',
    'test ! -e /etc/menu/Games/doom && echo MENU-GONE',
    'test -e /var/lib/gucman/removed/doom && echo TOMBSTONED',
    'which doom || echo NOT-ON-PATH',
    'echo @@done',
  ], BOOT_ARGS);
  const outB = String(sB.stdout || '');
  if (process.env.GUCMAN_DEBUG) {
    fs.writeFileSync('/tmp/gucman-doom-debug.log',
      outA + '\n===B===\n' + outB + '\n===STDERR===\n' + String(sB.stderr || ''));
  }

  const sync = sect(outB, 'sync');
  check('sync concluded on the networked boot', sync.includes('WAIT-OK-STATUS-B'), sync);
  check('sync installed doom with zero user action (status ok + installed doom)',
    /^ok$/m.test(sync) && /^installed doom$/m.test(sync), sync);
  check('install-DB record exists', sync.includes('DOOM-DB-OK'));
  check('/usr/local/bin/doom -> /opt/doom/doom (the launcher)',
    sync.split('\n').some((l) => l.trim() === '/opt/doom/doom'), sync);
  check('/opt/doom/doom-bin is executable', sync.includes('OPT-BINARY-OK'));
  check('the launcher script is executable', sync.includes('LAUNCHER-OK'));
  check('/etc/menu/Games/doom -> /usr/local/bin/doom',
    sync.split('\n').some((l) => l.trim() === '/usr/local/bin/doom'), sync);
  check('staging dir cleaned after install', sync.includes('NO-STAGING'));

  const wadSec = sect(outB, 'wad');
  check(`installed doom1.wad is all ${wad.length} bytes`,
    wadSec.split('\n').some((l) => l.trim() === String(wad.length)), wadSec);
  check('installed doom1.wad sha256 matches the vendored file (byte-exact through the pipeline)',
    wadSec.includes(wadSha), wadSec);

  const launch = sect(outB, 'launch');
  check('installed doom boots to its window off the installed WAD (the "." IWAD probe)',
    launch.split('\n').some((l) => l.endsWith('\tDOOM Shareware')), JSON.stringify(launch));

  const rem = sect(outB, 'remove');
  check('remove succeeds (exit 0)', rem.includes('RC=0'), rem);
  check('/opt/doom fully removed', rem.includes('OPT-GONE'));
  check('bin symlink removed', rem.includes('LINK-GONE'));
  check('menu entry removed', rem.includes('MENU-GONE'));
  check('removal is tombstoned (sync will never resurrect it — #419 durability)',
    rem.includes('TOMBSTONED'), rem);
  check('doom really gone from PATH', rem.includes('NOT-ON-PATH'), rem);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures ? `\ngucman doom e2e: ${failures} FAILED` : '\ngucman doom e2e: PASS');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e && e.stack || e);
  process.exit(1);
});
