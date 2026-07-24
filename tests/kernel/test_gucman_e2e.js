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
//   - desktop eligibility is DATA (design §5): only a package whose def
//     declares `desktop: {cmd}` may get a /root/Desktop icon (punes), a
//     bin-bearing CLI tool without the field never does (jq), and mkpkg
//     refuses a def whose desktop.cmd names no bin command
//   - the win32 source-lib package (Lane B1, design §3.1): install plants
//     the srclib symlink farms — /usr/local/include/<entry> per top-level
//     include entry, /usr/local/src/<ns> per require namespace — creating
//     the tier dirs (absent on a virgin root) and recording everything in
//     the DB; remove leaves NO residue (links gone, created tiers rmdir'd)
//
// Repo servers: serve.js itself, serving dist/packages (tools/mkpkg.js
// output) as its root — the tree has no os/image.json, so serve.js's image
// gate self-skips. A second serve.js serves a corrupted copy of the repo
// for the refusal leg.
//
// Run: node tests/kernel/test_gucman_e2e.js
'use strict';
const fs = require('fs');
const path = require('path');
const { driveBoot, freshImage, section } = require('./lib/drive.js');
const { ROOT, ensureMinimalImage, ensurePackages, startServer } = require('./lib/gucman.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

async function main() {
  const idx = ensurePackages(['punes', 'win32', 'jq']);
  const MIN = ensureMinimalImage();

  /* ---- mkpkg validation (source-lib §5): desktop.cmd must name a bin ---- *
   * Host-side negative check: a def whose desktop.cmd names no bin command
   * FAILS the package build loudly (the field is validated at build time so
   * gucman never sees a malformed one through the official pipeline). The
   * bad def is written into packages/ (mkpkg has no packages-dir seam),
   * built with --out into the temp dir, and removed again in finally. */
  {
    const cp = require('child_process');
    const badDef = path.join(ROOT, 'packages', 'test-bad-desktop.json');
    const badOut = fs.mkdtempSync(path.join(require('os').tmpdir(), 'mkpkg-bad-'));
    try {
      fs.writeFileSync(badDef, JSON.stringify({
        name: 'test-bad-desktop', version: '1.0', summary: 'negative fixture',
        files: { tool: { content: '#!/bin/sh\necho hi\n', mode: 0o755 } },
        bin: { tool: 'tool' },
        desktop: { cmd: 'nope' },
      }, null, 2) + '\n');
      const r = cp.spawnSync(process.execPath,
        [path.join(ROOT, 'tools', 'mkpkg.js'), '--quiet', `--out=${badOut}`, 'test-bad-desktop'],
        { encoding: 'utf-8', timeout: 60000 });
      check('mkpkg refuses desktop.cmd naming no bin command (exit 1)', r.status === 1,
        `status=${r.status}`);
      check('mkpkg refusal names the desktop.cmd cause',
        /desktop\.cmd .* names no bin command/.test(String(r.stderr)), String(r.stderr));
    } finally {
      fs.rmSync(badDef, { force: true });
      fs.rmSync(badOut, { recursive: true, force: true });
    }
  }

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
    'echo ==catalog',
    'gucman list --all',                      // #83: human catalog, DB cross-ref
    'echo ==infoinst',
    'gucman info punes; echo IRC=$?',         // #83: installed package detail
    'echo ==infoavail',
    'gucman info lua; echo IRC2=$?',          // #83: available-only package
    'gucman info nosuchpkg; echo IRC3=$?',    // #83: unknown -> loud exit 1
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

  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pv = idx.packages.punes.version;

  const minimal = section(aout, 'minimal');
  check('minimal image has no baked /bin/punes', minimal.includes('NO-BAKED-BIN'), minimal);
  check('minimal image has no baked Games/punes menu entry', minimal.includes('NO-BAKED-MENU'));
  check('minimal image has no baked nes openwith key', minimal.includes('NO-BAKED-NES-KEY'));
  check('gucman list starts empty', minimal.includes('no packages installed'), minimal);

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
  check('gucman list shows punes (aligned human row)',
    new RegExp('^punes\\s+' + esc(pv) + '\\s', 'm').test(list2), list2);
  check('gucman list prints the header', /^NAME\s+VERSION\s+SUMMARY/m.test(list2), list2);
  check('reinstall is an already-installed no-op', list2.includes('RC2=0') &&
    /already installed/.test(list2), list2);

  /* ---- #83: the human catalog (list --all) + per-package info ---- */
  const cat = section(aout, 'catalog');
  check('catalog header has AVAILABLE + INSTALLED columns',
    /^NAME\s+AVAILABLE\s+INSTALLED\s+SUMMARY/m.test(cat), cat);
  check('catalog shows punes installed at its version',
    new RegExp('^punes\\s+' + esc(pv) + '\\s+' + esc(pv) + '\\s', 'm').test(cat), cat);
  check('catalog shows lua available but not installed',
    /^lua\s+\S+\s+no\s/m.test(cat), cat);
  check('catalog raw surface untouched: no JSON braces in the human table',
    !cat.includes('"packages"'), cat);

  const infoInst = section(aout, 'infoinst');
  check('info exits 0 for an installed package', infoInst.includes('IRC=0'), infoInst);
  check('info names the package', /^package:\s+punes/m.test(infoInst), infoInst);
  check('info shows available version', new RegExp('^available:\\s+' + esc(pv), 'm').test(infoInst));
  check('info shows installed yes + version',
    new RegExp('^installed:\\s+yes \\(' + esc(pv) + '\\)', 'm').test(infoInst), infoInst);
  check('info reports up-to-date (no update)', /^update:\s+no \(up to date\)/m.test(infoInst), infoInst);
  check('info lists the planted /opt binary',
    /^planted files:$/m.test(infoInst) && infoInst.includes('/opt/punes/punes'), infoInst);
  check('info lists the planted bin symlink',
    /^planted symlinks:$/m.test(infoInst) && infoInst.includes('/usr/local/bin/punes'), infoInst);
  check('info lists the openwith key', /^openwith keys:$/m.test(infoInst) && /^  nes$/m.test(infoInst));
  check('info lists the menu entry', infoInst.includes('/etc/menu/Games/punes'), infoInst);
  check('info shows the payload size', /^size:\s+\S+/m.test(infoInst), infoInst);

  const infoAvail = section(aout, 'infoavail');
  check('info exits 0 for a not-installed package', infoAvail.includes('IRC2=0'), infoAvail);
  check('info shows installed: no for a not-installed package',
    /^installed:\s+no$/m.test(infoAvail), infoAvail);
  check('info shows lua available version',
    new RegExp('^available:\\s+' + esc(idx.packages.lua.version), 'm').test(infoAvail), infoAvail);
  check('info on an unknown package fails loud', infoAvail.includes('IRC3=1'), infoAvail);
  check('unknown-package error names the cause',
    /not installed and not in the repository index/.test(aall), 'stderr missing');

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
  check('install persists across reboot (DB)',
    new RegExp('^punes\\s+' + esc(pv) + '\\s', 'm').test(persist), persist);
  check('install persists across reboot (/opt)', persist.includes('OPT-PERSISTS'));

  const rem = section(bout, 'remove');
  check('remove succeeds (exit 0)', rem.includes('RC=0'), rem);
  check('/opt/punes fully removed', rem.includes('OPT-GONE'));
  check('bin symlink removed', rem.includes('LINK-GONE'));
  check('openwith key removed', rem.includes('NES-KEY-GONE'));
  check('menu entry AND gucman-created menu dirs removed', rem.includes('MENU-DIRS-GONE'));
  check('DB record removed last', rem.includes('DB-GONE'));
  check('gucman list empty after remove',
    rem.includes('no packages installed') && !/^punes\s/m.test(rem), rem);

  const rerun = section(bout, 'rerun');
  check('removing a non-installed package fails loud', rerun.includes('RC=1'), rerun);
  check('punes really gone from PATH', rerun.includes('RC2=127'), rerun);

  /* ---- session C: the Q5/#90 install-to-Desktop toggle ---- *
   * The persistent flag /var/lib/gucman/desktop_shortcuts gates whether an
   * install also plants /root/Desktop/<name>; uninstall removes exactly what
   * it planted. Default OFF (opt-in) → no shortcut; flip ON → the symlink
   * appears and is recorded in the DB; remove → gone. */
  const scriptC = [
    'echo ==deskoff',
    'mkdir -p /var/lib/gucman',
    'rm -f /var/lib/gucman/desktop_shortcuts',           // default OFF
    'gucman install punes; echo RC=$?',
    'test ! -e /root/Desktop/punes && echo NO-DESK-OFF',
    'gucman remove punes >/dev/null; echo RCr=$?',
    'echo ==deskon',
    'echo on > /var/lib/gucman/desktop_shortcuts',       // opt in
    'gucman install punes; echo RC2=$?',
    'readlink /root/Desktop/punes',
    'grep -q "/root/Desktop/punes" /var/lib/gucman/punes.json && echo DB-DESK-OK',
    'echo ==deskrm',
    'gucman remove punes; echo RC3=$?',
    'test ! -e /root/Desktop/punes && echo DESK-GONE',
    /* §5: eligibility is data, not a heuristic — a bin-bearing CLI tool
     * (jq ships /usr/local/bin/jq but no `desktop` field) gets NO icon
     * even with the toggle ON. This is the regression Lane C exists to
     * create: pre-§5 the launchable-command heuristic planted one. */
    'echo ==deskcli',
    'gucman install jq; echo RC4=$?',
    'readlink /usr/local/bin/jq',
    'test ! -e /root/Desktop/jq && echo NO-CLI-DESK',
    'gucman remove jq; echo RC5=$?',
    'echo ==done',
  ];
  const c = driveBoot(scriptC, BOOT_ARGS);
  const cout = String(c.stdout || '');

  const off = section(cout, 'deskoff');
  check('toggle OFF: install plants no Desktop shortcut', off.includes('NO-DESK-OFF'), off);

  const on = section(cout, 'deskon');
  check('toggle ON: install plants /root/Desktop/punes -> /usr/local/bin/punes',
    on.split('\n').some((l) => l.trim() === '/usr/local/bin/punes'), on);
  check('toggle ON: the Desktop shortcut is recorded in the DB', on.includes('DB-DESK-OK'), on);

  const drm = section(cout, 'deskrm');
  check('uninstall removes the planted Desktop shortcut', drm.includes('DESK-GONE'), drm);

  const dcli = section(cout, 'deskcli');
  check('jq (bin-bearing CLI, no desktop field) installs fine', dcli.includes('RC4=0'), dcli);
  check('jq bin symlink planted', dcli.includes('/opt/jq/jq'), dcli);
  check('toggle ON + no desktop field: NO Desktop icon for jq', dcli.includes('NO-CLI-DESK'), dcli);
  check('jq removes cleanly', dcli.includes('RC5=0'), dcli);

  /* ---- session D: the win32 source-lib package (Lane B1, §3.1) ---- *
   * A srclib package plants header + require-source symlink farms at the
   * standard install locations the in-OS cc searches. The tier dirs do not
   * exist on a virgin root — install creates and records them; remove
   * unlinks every plant and rmdirs the created tiers, leaving no residue. */
  const scriptD = [
    'echo ==virgin',
    'test ! -e /usr/local/include && echo NO-INC-TIER',
    'test ! -e /usr/local/src && echo NO-SRC-TIER',
    'echo ==slinstall',
    'mkdir -p /var/lib/gucman',
    'echo on > /var/lib/gucman/desktop_shortcuts',   // §5: even with the toggle ON…
    'gucman install win32; echo RC=$?',
    'test ! -e "/root/Desktop/win32" && echo NO-SRCLIB-DESK',  // …no bin, no field ⇒ no icon
    'readlink /usr/local/include/windows.h',
    'readlink /usr/local/src/win32',
    'test -f /usr/local/include/windows.h && echo INC-RESOLVES',
    'test -f /usr/local/src/win32/user32.c && echo SRC-RESOLVES',
    'test -f /usr/local/include/ft2build.h && echo FT2BUILD-OK',
    'test -f /usr/local/include/freetype/freetype.h && echo FT-TREE-OK',
    'test -f /usr/local/src/freetype/ftbase.c && echo FT-NS-OK',
    // the §3.3 layout invariants relative quote-includes depend on, asserted
    // IN THE PAYLOAD (real dirs, where lexical `..` == physical): fontcore.h
    // one level above src/win32/ (gdi32.c's "../fontcore.h"), the freetype
    // upstream src/ tree beside the shim dir ("../src/base/ftbase.c").
    // NB the visible-tier form (/usr/local/src/win32/../fontcore.h) does NOT
    // resolve: BlockFS collapses `..` LEXICALLY before the walk (host.js
    // _walkPath — logical, not physical), so `..` never enters the namespace
    // symlink. How the in-OS compile crosses that is Lane B2's seam.
    'test -f /opt/win32/src/win32/../fontcore.h && echo FONTCORE-LAYOUT-OK',
    'test -f /opt/win32/src/freetype/srclib/../src/base/ftbase.c && echo FT-LAYOUT-OK',
    'grep -q include_entries /var/lib/gucman/win32.json && echo DB-INC-OK',
    'grep -q src_namespaces /var/lib/gucman/win32.json && echo DB-NS-OK',
    'grep -q srclib_dirs /var/lib/gucman/win32.json && echo DB-DIRS-OK',
    'echo ==slremove',
    'gucman remove win32; echo RC=$?',
    'test ! -e /usr/local/include && echo INC-TIER-GONE',
    'test ! -e /usr/local/src && echo SRC-TIER-GONE',
    'test ! -e /opt/win32 && echo OPT-GONE',
    'test ! -e /var/lib/gucman/win32.json && echo DB-GONE',
    'echo ==done',
  ];
  const d = driveBoot(scriptD, BOOT_ARGS);
  const dout = String(d.stdout || '');

  const virgin = section(dout, 'virgin');
  check('virgin root has no /usr/local/include tier', virgin.includes('NO-INC-TIER'), virgin);
  check('virgin root has no /usr/local/src tier', virgin.includes('NO-SRC-TIER'));

  const sli = section(dout, 'slinstall');
  check('win32 install succeeds (exit 0)', sli.includes('RC=0'), sli);
  check('toggle ON + srclib package (no bin, no field): NO Desktop icon',
    sli.includes('NO-SRCLIB-DESK'), sli);
  check('/usr/local/include/windows.h -> /opt/win32/include/windows.h',
    sli.includes('/opt/win32/include/windows.h'), sli);
  check('/usr/local/src/win32 -> /opt/win32/src/win32',
    sli.split('\n').some((l) => l.trim() === '/opt/win32/src/win32'), sli);
  check('include-tier link resolves to a real header', sli.includes('INC-RESOLVES'));
  check('src-namespace link resolves to user32.c', sli.includes('SRC-RESOLVES'));
  check('demo ft2build.h planted as a top-level include entry', sli.includes('FT2BUILD-OK'));
  check('freetype/ header tree rides as ONE include link', sli.includes('FT-TREE-OK'));
  check('freetype require namespace maps to the shim dir', sli.includes('FT-NS-OK'));
  check('payload layout: fontcore.h one level above src/win32/', sli.includes('FONTCORE-LAYOUT-OK'));
  check('payload layout: freetype src/ tree beside the shim dir', sli.includes('FT-LAYOUT-OK'));
  check('DB records include_entries', sli.includes('DB-INC-OK'));
  check('DB records src_namespaces', sli.includes('DB-NS-OK'));
  check('DB records the created tier dirs', sli.includes('DB-DIRS-OK'));

  const slr = section(dout, 'slremove');
  check('win32 remove succeeds (exit 0)', slr.includes('RC=0'), slr);
  check('created include tier rmdir\'d on remove', slr.includes('INC-TIER-GONE'), slr);
  check('created src tier rmdir\'d on remove', slr.includes('SRC-TIER-GONE'));
  check('/opt/win32 fully removed', slr.includes('OPT-GONE'));
  check('win32 DB record removed', slr.includes('DB-GONE'));

  /* ---- session E: the FAT image carries the baked srclib fold ---- *
   * foldPackages' twin of the gucman plant: /usr/include + /usr/src symlink
   * farms over the sealed /usr/opt/win32 payload (no --packages flag =
   * boot.js's fat default). */
  const scriptE = [
    'echo ==fat',
    'test -f /usr/include/windows.h && echo BAKED-INC-OK',
    'readlink /usr/include/windows.h',
    'readlink /usr/src/win32',
    'test -f /usr/src/win32/user32.c && echo BAKED-SRC-OK',
    'test -f /usr/src/freetype/ftbase.c && echo BAKED-FT-OK',
    'test -f /usr/include/freetype/freetype.h && echo BAKED-FT-TREE-OK',
    // the baked payload's §3.3 layout invariants (see session D note: `..`
    // is asserted through the REAL payload dirs, not the symlink tier)
    'test -f /usr/opt/win32/src/win32/../fontcore.h && echo BAKED-LAYOUT-OK',
    'test -f /usr/opt/win32/src/freetype/srclib/../src/base/ftbase.c && echo BAKED-FT-LAYOUT-OK',
    'echo ==done',
  ];
  const e = driveBoot(scriptE, { timeout: 420000 });
  const eout = String(e.stdout || '');

  const fat = section(eout, 'fat');
  check('fat: /usr/include/windows.h resolves', fat.includes('BAKED-INC-OK'), fat);
  check('fat: windows.h links into the sealed payload',
    fat.includes('/usr/opt/win32/include/windows.h'), fat);
  check('fat: /usr/src/win32 links into the sealed payload',
    fat.split('\n').some((l) => l.trim() === '/usr/opt/win32/src/win32'), fat);
  check('fat: /usr/src/win32/user32.c resolves', fat.includes('BAKED-SRC-OK'));
  check('fat: freetype shim namespace resolves', fat.includes('BAKED-FT-OK'));
  check('fat: freetype header tree resolves', fat.includes('BAKED-FT-TREE-OK'));
  check('fat: baked payload layout (fontcore.h above src/win32/)', fat.includes('BAKED-LAYOUT-OK'));
  check('fat: baked payload layout (freetype src/ beside shims)', fat.includes('BAKED-FT-LAYOUT-OK'));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures ? `\ngucman e2e: ${failures} FAILED` : '\ngucman e2e: PASS');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e && e.stack || e);
  process.exit(1);
});
