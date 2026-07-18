#!/usr/bin/env node
// gucman fat-data acceptance, headless (ticket: the deploy-leg follow-on to
// Slice 1): Quake is the big-payload case — an ~8.6 MiB compressed package
// carrying the 18.7 MB shareware pak0.pak — proving the whole install
// pipeline on real game data, not just punes-sized binaries:
//
//   - the minimal image really is minimal: no /bin/quake, no Games/quake
//     menu entry, no /root/id1 seed
//   - `gucman install quake` streams the payload, sha256-verifies it, and
//     stage-extracts /opt/quake with the pak byte-exact (in-OS sha256sum of
//     the installed pak == the vendored file's sha — the payload → inflate
//     → untar → BlockFS chain round-trips 18.7 MB bit-for-bit)
//   - the launcher symlink chain works: /usr/local/bin/quake ->
//     /opt/quake/quake (a #!/bin/sh self-locating script that cd's to the
//     package dir — quake's basedir is the CWD) -> quake-bin; the game
//     REALLY boots to its window off the installed pak
//   - `gucman remove quake` replays the DB: /opt tree (all 19 MB), symlink,
//     menu entry gone
//
// FAILS LOUD on the unconverted tree: with quake still baked into the
// system image the minimal-proof leg trips, and pre-split there is no
// packages/quake.json for mkpkg to build.
//
// Run: node tests/kernel/test_gucman_quake_e2e.js
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { driveBoot, freshImage } = require('./lib/drive.js');
const { ROOT, ensureMinimalImage, ensurePackages, startServer } = require('./lib/gucman.js');

// Not drive.js section(): its '==' delimiter collides with quake's own
// console banner ("========Quake Initialized=========" splits any section
// that spans a running quake). '@@' never appears in the game's output.
function sect(out, name) {
  const parts = String(out).split('@@' + name + '\n');
  return parts.length > 1 ? parts[1].split('@@')[0] : '';
}

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

async function main() {
  const idx = ensurePackages(['quake']);
  const MIN = ensureMinimalImage();
  const { dir: tmp, image } = freshImage('os-gucman-quake-');
  fs.copyFileSync(MIN, image);   // copy mtime = now -> input-fresh at boot

  const pak = fs.readFileSync(path.join(ROOT, 'vendor', 'quake', 'data', 'id1', 'pak0.pak'));
  const pakSha = crypto.createHash('sha256').update(pak).digest('hex');

  const port = await startServer(path.join(ROOT, 'dist', 'packages'));
  console.log(`[gucman-quake] repo :${port} (payload ${(idx.packages.quake.payload.size / (1 << 20)).toFixed(1)} MiB)`);

  const script = [
    'echo @@minimal',
    'test ! -e /bin/quake && echo NO-BAKED-BIN',
    'test ! -e /usr/share/menu/Games/quake && echo NO-BAKED-MENU',
    'test ! -e /root/id1 && echo NO-ID1-SEED',
    'echo @@install',
    'mkdir -p /etc/gucman',
    `echo http://127.0.0.1:${port} > /etc/gucman/repos`,
    'gucman install quake; echo RC=$?',
    'readlink /usr/local/bin/quake',
    'test -x /opt/quake/quake-bin && echo OPT-BINARY-OK',
    'test -x /opt/quake/quake && echo LAUNCHER-OK',
    'readlink /etc/menu/Games/quake',
    'test ! -e /opt/.staging.quake && echo NO-STAGING',
    'echo @@pak',
    'wc -c < /opt/quake/id1/pak0.pak',
    'sha256sum /opt/quake/id1/pak0.pak',
    'echo @@db',
    'cat /var/lib/gucman/quake.json',
    'gucman list',
    'echo @@launch',
    'quake &',
    'wmctl wait win Quake',
    'wmctl list; echo LIST-RC=$?',
    // pkill, not `kill %1`: the job is the launcher sh, which WAITS on the
    // game as a separate pid (no in-place exec in the spawn model) — killing
    // the job would strand the window.
    'pkill quake',
    'wmctl wait nowin Quake',
    'echo @@remove',
    'gucman remove quake; echo RC=$?',
    'test ! -e /opt/quake && echo OPT-GONE',
    'test ! -e /usr/local/bin/quake && echo LINK-GONE',
    'test ! -e /etc/menu/Games/quake && echo MENU-GONE',
    'test ! -e /var/lib/gucman/quake.json && echo DB-GONE',
    // `which`, not a bare spawn: on a tree where quake is still on PATH a
    // spawn would run the game FOREGROUND and burn the whole boot timeout.
    'which quake || echo NOT-ON-PATH',
    'echo @@done',
  ];
  const r = driveBoot(script, { image, args: ['--packages=none'], timeout: 420000 });
  const out = String(r.stdout || '');
  if (process.env.GUCMAN_DEBUG) {
    fs.writeFileSync('/tmp/gucman-quake-debug.log',
      out + '\n===STDERR===\n' + String(r.stderr || ''));
  }

  const minimal = sect(out, 'minimal');
  check('minimal image has no baked /bin/quake', minimal.includes('NO-BAKED-BIN'), minimal);
  check('minimal image has no baked Games/quake menu entry', minimal.includes('NO-BAKED-MENU'));
  check('minimal image has no /root/id1 seed', minimal.includes('NO-ID1-SEED'));

  const inst = sect(out, 'install');
  check('install succeeds (exit 0)', inst.includes('RC=0'), inst);
  check('installed banner names the version',
    inst.includes(`installed quake ${idx.packages.quake.version}`), inst);
  check('/usr/local/bin/quake -> /opt/quake/quake (the launcher)',
    inst.split('\n').some((l) => l.trim() === '/opt/quake/quake'), inst);
  check('/opt/quake/quake-bin is executable', inst.includes('OPT-BINARY-OK'));
  check('the launcher script is executable', inst.includes('LAUNCHER-OK'));
  check('/etc/menu/Games/quake -> /usr/local/bin/quake',
    inst.split('\n').some((l) => l.trim() === '/usr/local/bin/quake'), inst);
  check('staging dir cleaned after install', inst.includes('NO-STAGING'));

  const pakSec = sect(out, 'pak');
  check(`installed pak0.pak is all ${pak.length} bytes`,
    pakSec.split('\n').some((l) => l.trim() === String(pak.length)), pakSec);
  check('installed pak0.pak sha256 matches the vendored file (byte-exact through the pipeline)',
    pakSec.includes(pakSha), pakSec);

  const db = sect(out, 'db');
  check('DB records the payload sha256', db.includes(idx.packages.quake.payload.sha256), db.slice(0, 300));
  check('gucman list shows quake (aligned human row)',
    new RegExp('^quake\\s+' + idx.packages.quake.version.replace(/\./g, '\\.') + '\\s', 'm').test(db), db);

  const launch = sect(out, 'launch');
  check('installed quake opens its window off the installed pak',
    launch.split('\n').some((l) => l.endsWith('\tQuake')), JSON.stringify(launch));

  const rem = sect(out, 'remove');
  check('remove succeeds (exit 0)', rem.includes('RC=0'), rem);
  check('/opt/quake fully removed (19 MB reclaimed)', rem.includes('OPT-GONE'));
  check('bin symlink removed', rem.includes('LINK-GONE'));
  check('menu entry removed', rem.includes('MENU-GONE'));
  check('DB record removed', rem.includes('DB-GONE'));
  check('quake really gone from PATH', rem.includes('NOT-ON-PATH'), rem);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures ? `\ngucman quake e2e: ${failures} FAILED` : '\ngucman quake e2e: PASS');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e && e.stack || e);
  process.exit(1);
});
