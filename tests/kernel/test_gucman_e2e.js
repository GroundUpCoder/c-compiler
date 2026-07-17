#!/usr/bin/env node
// gucman Slice 1 acceptance, headless: the gucOS package manager proves the
// whole pull-an-app-out-of-the-image loop on the MINIMAL image (punes is a
// package now, NOT baked — boot.js --packages=none):
//
//   - the minimal image really is minimal: no /bin/punes, no Games/punes
//     menu entry, no baked `nes` openwith key
//   - a 1-byte-corrupted payload is REFUSED before extraction (sha256 is
//     checked first): no /opt entry, no staging leftovers, no DB record
//   - `gucman install punes` against a local serve.js repo: staged extract,
//     atomic /opt/punes, /usr/local/bin/punes symlink, /etc/openwith `nes`
//     key, /etc/menu/Games/punes entry, DB record written last
//   - the installed punes LAUNCHES (window titled "puNES", built-in test
//     ROM) from /usr/local/bin — the loader is location-agnostic
//   - the install persists across a reboot (root volume, not the blob)
//   - `gucman remove punes` replays the DB record in reverse: /opt tree,
//     symlink, openwith key, menu entry AND the menu dirs gucman created
//     are all gone; the DB record goes last
//
// Repo servers: serve.js itself, serving dist/packages (tools/mkpkg.js
// output) as its root — the tree has no os/image.json, so serve.js's image
// gate self-skips. A second serve.js serves a corrupted copy of the repo
// for the refusal leg.
//
// Run: node tests/kernel/test_gucman_e2e.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { driveBoot, freshImage, section } = require('./lib/drive.js');

const ROOT = path.resolve(__dirname, '../..');
const { BLOCK_FS } = require(path.join(ROOT, 'host.js'));
const COMMON = require(path.join(ROOT, 'os', 'os-common.js'));

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

/* ---- the minimal system blob (no packages), baked once + cached ---- */
function ensureMinimalImage() {
  const MIN = path.join(ROOT, 'build', 'test-fixtures', 'os-system.min.img');
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'os', 'image.json'), 'utf-8'));
  let fresh = false;
  try {
    const st = fs.statSync(MIN);
    const store = new COMMON.NodeFileStore(fs, MIN, false);
    const v = COMMON.bakedVersion(BLOCK_FS, store);
    const pk = COMMON.bakedPackages(BLOCK_FS, store);
    store.close();
    fresh = v === (raw.version | 0) && pk.length === 0 &&
      st.mtimeMs >= COMMON.newestBakeInput(fs, path, ROOT, raw).mtimeMs;
  } catch (e) { /* missing -> bake */ }
  if (!fresh) {
    console.log('[gucman] baking the minimal (no-packages) system blob…');
    fs.mkdirSync(path.dirname(MIN), { recursive: true });
    const r = cp.spawnSync(process.execPath,
      [path.join(ROOT, 'tools', 'mkimage.js'), `--out=${MIN}`, '--quiet'],
      { stdio: ['ignore', 'inherit', 'inherit'], timeout: 600000 });
    if (r.status !== 0) throw new Error('mkimage (minimal) failed');
  }
  return MIN;
}

/* ---- the package repo (mkpkg output), built once + reused when fresh ---- */
function ensurePackages() {
  const r = cp.spawnSync(process.execPath, [path.join(ROOT, 'tools', 'mkpkg.js'), '--quiet'],
    { stdio: ['ignore', 'inherit', 'inherit'], timeout: 600000 });
  if (r.status !== 0) throw new Error('mkpkg failed');
  const idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'dist', 'packages', 'index.json'), 'utf-8'));
  if (!idx.packages.punes) throw new Error('mkpkg produced no punes entry');
  return idx;
}

/* ---- spawn serve.js over a static dir, resolve its port ---- */
const servers = [];
function startServer(dir) {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(process.execPath, [path.join(ROOT, 'serve.js'), dir, '0'],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    servers.push(child);
    let buf = '';
    const to = setTimeout(() => {
      reject(new Error('serve.js never announced a port (stale output: ' + buf + ')'));
    }, 10000);
    child.stdout.on('data', (d) => {
      buf += d;
      const m = /http:\/\/localhost:(\d+)/.exec(buf);
      if (m) { clearTimeout(to); resolve(parseInt(m[1], 10)); }
    });
    child.on('error', (e) => { clearTimeout(to); reject(e); });
    child.on('exit', (code) => { clearTimeout(to); reject(new Error('serve.js exited ' + code)); });
  });
}
process.on('exit', () => { for (const s of servers) { try { s.kill(); } catch (e) {} } });

async function main() {
  const idx = ensurePackages();
  const MIN = ensureMinimalImage();
  const { dir: tmp, image } = freshImage('os-gucman-');
  fs.copyFileSync(MIN, image);   // copy mtime = now -> input-fresh at boot

  // The corrupted repo: same index, payload with ONE byte flipped mid-file.
  const goodDir = path.join(ROOT, 'dist', 'packages');
  const badDir = path.join(tmp, 'bad-repo');
  fs.mkdirSync(path.join(badDir, 'pool'), { recursive: true });
  fs.copyFileSync(path.join(goodDir, 'index.json'), path.join(badDir, 'index.json'));
  const poolRel = idx.packages.punes.payload.url;
  const payload = fs.readFileSync(path.join(goodDir, poolRel));
  payload[payload.length >> 1] ^= 0xff;
  fs.writeFileSync(path.join(badDir, poolRel), payload);

  const goodPort = await startServer(goodDir);
  const badPort = await startServer(badDir);
  console.log(`[gucman] repo :${goodPort}, corrupted repo :${badPort}`);

  const BOOT_ARGS = { image, args: ['--packages=none'], timeout: 420000 };

  /* ---- session A: minimal proof, refusal, install, launch ---- */
  const scriptA = [
    'echo ==minimal',
    'test ! -e /bin/punes && echo NO-BAKED-BIN',
    'test ! -e /usr/share/menu/Games/punes && echo NO-BAKED-MENU',
    'grep -q "^nes" /usr/share/openwith || echo NO-BAKED-NES-KEY',
    'gucman list',
    'echo ==badrepo',
    'mkdir -p /etc/gucman',
    `echo http://127.0.0.1:${badPort} > /etc/gucman/repos`,
    'gucman install punes; echo RC=$?',
    'test ! -e /opt/punes && echo NO-OPT-AFTER-BAD',
    'test ! -e /opt/.staging.punes && echo NO-STAGING-AFTER-BAD',
    'test ! -e /var/lib/gucman/punes.json && echo NO-DB-AFTER-BAD',
    'echo ==install',
    `echo http://127.0.0.1:${goodPort} > /etc/gucman/repos`,
    'gucman install punes; echo RC=$?',
    'readlink /usr/local/bin/punes',
    'test -x /opt/punes/punes && echo OPT-BINARY-OK',
    'grep "^nes" /etc/openwith',
    'readlink /etc/menu/Games/punes',
    'test ! -e /opt/.staging.punes && echo NO-STAGING-AFTER-GOOD',
    'echo ==db',
    'cat /var/lib/gucman/punes.json',
    'echo ==list2',
    'gucman list',
    'gucman install punes; echo RC2=$?',      // idempotent no-op
    'echo ==launch',
    'punes &',
    'wmctl wait win puNES',
    'wmctl list',
    'kill %1',
    'wmctl wait nowin puNES',
    'echo ==done',
  ];
  const a = driveBoot(scriptA, BOOT_ARGS);
  const aout = String(a.stdout || '');
  const aall = aout + '\n' + String(a.stderr || '');

  const minimal = section(aout, 'minimal');
  check('minimal image has no baked /bin/punes', minimal.includes('NO-BAKED-BIN'), minimal);
  check('minimal image has no baked Games/punes menu entry', minimal.includes('NO-BAKED-MENU'));
  check('minimal image has no baked nes openwith key', minimal.includes('NO-BAKED-NES-KEY'));
  check('gucman list starts empty', !minimal.includes('punes\t'), minimal);

  const bad = section(aout, 'badrepo');
  check('corrupted payload is refused (exit 1)', bad.includes('RC=1'), bad);
  check('refusal names the sha256 mismatch', /sha256 mismatch/.test(aall));
  check('no /opt entry after the refusal', bad.includes('NO-OPT-AFTER-BAD'));
  check('no staging leftovers after the refusal', bad.includes('NO-STAGING-AFTER-BAD'));
  check('no DB record after the refusal', bad.includes('NO-DB-AFTER-BAD'));

  const inst = section(aout, 'install');
  check('install succeeds (exit 0)', inst.includes('RC=0'), inst);
  check('installed banner names the version',
    inst.includes(`installed punes ${idx.packages.punes.version}`), inst);
  check('/usr/local/bin/punes -> /opt/punes/punes', inst.includes('/opt/punes/punes'));
  check('/opt/punes/punes is executable', inst.includes('OPT-BINARY-OK'));
  check('nes openwith key points into /usr/local/bin',
    /nes\t\/usr\/local\/bin\/punes/.test(inst), inst);
  check('/etc/menu/Games/punes -> /usr/local/bin/punes',
    inst.split('\n').some((l) => l.trim() === '/usr/local/bin/punes'), inst);
  check('staging dir cleaned after install', inst.includes('NO-STAGING-AFTER-GOOD'));

  const db = section(aout, 'db');
  check('DB records the payload sha256', db.includes(idx.packages.punes.payload.sha256), db.slice(0, 300));
  check('DB records the planted symlink', db.includes('/usr/local/bin/punes'));
  check('DB records the openwith key', /"openwith_keys"/.test(db) && /"nes"/.test(db));
  check('DB records the menu entry', db.includes('/etc/menu/Games/punes'));

  const list2 = section(aout, 'list2');
  check('gucman list shows punes', list2.includes('punes\t' + idx.packages.punes.version), list2);
  check('reinstall is an already-installed no-op', list2.includes('RC2=0') &&
    /already installed/.test(list2), list2);

  const launch = section(aout, 'launch');
  check('installed punes boots the built-in test ROM', aall.includes('using built-in test ROM'));
  check('installed punes opens its window',
    launch.split('\n').some((l) => l.endsWith('\tpuNES')), launch);

  /* ---- session B: persistence across reboot, then exact removal ---- */
  const scriptB = [
    'echo ==persist',
    'gucman list',
    'test -x /opt/punes/punes && echo OPT-PERSISTS',
    'punes &',
    'wmctl wait win puNES',
    'kill %1',
    'wmctl wait nowin puNES',
    'echo ==remove',
    'gucman remove punes; echo RC=$?',
    'test ! -e /opt/punes && echo OPT-GONE',
    'test ! -e /usr/local/bin/punes && echo LINK-GONE',
    'grep -q "^nes" /etc/openwith || echo NES-KEY-GONE',
    'test ! -e /etc/menu && echo MENU-DIRS-GONE',
    'test ! -e /var/lib/gucman/punes.json && echo DB-GONE',
    'gucman list',
    'echo ==rerun',
    'gucman remove punes; echo RC=$?',
    'punes; echo RC2=$?',
    'echo ==done',
  ];
  const b = driveBoot(scriptB, BOOT_ARGS);
  const bout = String(b.stdout || '');

  const persist = section(bout, 'persist');
  check('install persists across reboot (DB)', persist.includes('punes\t' + idx.packages.punes.version), persist);
  check('install persists across reboot (/opt)', persist.includes('OPT-PERSISTS'));

  const rem = section(bout, 'remove');
  check('remove succeeds (exit 0)', rem.includes('RC=0'), rem);
  check('/opt/punes fully removed', rem.includes('OPT-GONE'));
  check('bin symlink removed', rem.includes('LINK-GONE'));
  check('openwith key removed', rem.includes('NES-KEY-GONE'));
  check('menu entry AND gucman-created menu dirs removed', rem.includes('MENU-DIRS-GONE'));
  check('DB record removed last', rem.includes('DB-GONE'));
  check('gucman list empty after remove', !rem.includes('punes\t'), rem);

  const rerun = section(bout, 'rerun');
  check('removing a non-installed package fails loud', rerun.includes('RC=1'), rerun);
  check('punes really gone from PATH', rerun.includes('RC2=127'), rerun);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures ? `\ngucman e2e: ${failures} FAILED` : '\ngucman e2e: PASS');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e && e.stack || e);
  process.exit(1);
});
