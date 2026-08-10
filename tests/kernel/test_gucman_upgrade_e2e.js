#!/usr/bin/env node
// gucman `upgrade` (ticket #545) — the verb that ends "installed once,
// frozen forever": an installed package converges on the repository's
// published version through a STAGED REPLACEMENT, never remove+install.
//
// The semantics under test (the #545 design decisions):
//   - `upgrade <name>` converges on the index version whenever it DIFFERS
//     (version strings are opaque labels — no ordering exists, so a
//     publisher rollback converges the same way a release does, loudly);
//     same version = a spoken no-op; not installed / not in the index =
//     loud errors naming the fix.
//   - `upgrade` with no name converges every installed package; a package
//     the index no longer carries is skipped with a note, never a failure.
//   - the mechanism is gm_install_one's upgrade mode: download + sha256 +
//     staging + validation happen FIRST (any failure there leaves the old
//     install fully intact), then the old prerm runs with argv[1] =
//     "upgrade", the old record is replayed (NO tombstone, NO
//     reverse-dependency guard — the name never leaves the system), the
//     standard plant runs, and the new postinst runs with "upgrade"; the
//     DB record is only ever atomically REPLACED, never absent.
//   - /etc/cmdalt claim lines and /etc/fonts/fallback lines are POSITIONAL
//     (first claim wins the dispatch; the fallback list is priority order):
//     the upgrade replay skips them, the re-plant is idempotent IN PLACE,
//     and claims/faces the new version dropped are reconciled away after
//     the new record lands — so an upgrade can never silently flip a
//     command default to another package's claim.
//   - seeds keep the content contract: a pristine copy is refreshed to the
//     new version's bytes, a user-modified copy is kept loudly.
//   - the Desktop shortcut is preserved BY PRESENCE, ignoring the current
//     toggle in both directions: present-before stays present (toggle off),
//     deleted-before stays deleted (toggle on).
//   - the #419 crash window (the reason remove+install was rejected): a
//     gucman killed dead mid-upgrade (SIGKILL while the new postinst runs)
//     leaves NO tombstone and the OLD record intact — still "installed",
//     never unhooked from sync-defaults — and a re-run of `upgrade`
//     converges.
//
// Run: node tests/kernel/test_gucman_upgrade_e2e.js
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { driveBoot, freshImage, section } = require('./lib/drive.js');
const { ROOT, ensureMinimalImage, startServer, POOL } = require('./lib/gucman.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

/* ---- fixture definitions: one package, three published versions -------
 * Private --packages-dir per repo (the mkpkg-bad-defs isolation rule — a
 * transient def in the shared packages/ is visible to every concurrently
 * booting e2e's fold). Names stay STABLE across versions (bin/menu/openwith)
 * — that is what makes a crashed upgrade's re-run converge instead of
 * tripping the plant's refuse-on-exists. minBase pinned to 1 (#518: no
 * compiled code in these payloads). */
const logsh = (hook, v) =>
  ({ content: `#!/bin/sh\necho "${hook}:$1:${v}" >> /root/up.log\n`, mode: 0o755 });
const V1 = {
  'test-up': {
    name: 'test-up', version: '1.0', summary: 'upgrade fixture', minBase: 1,
    files: {
      tool: { content: '#!/bin/sh\necho tool-v1\n', mode: 0o755 },
      'gone.txt': { content: 'only-in-v1\n' },
      'note.txt': { content: 'seed-v1\n' },
      'keep.txt': { content: 'keep-v1\n' },
      'fa.ttf': { content: 'face-a\n' },
      'fb.ttf': { content: 'face-b\n' },
      postinst: logsh('postinst', 'v1'), prerm: logsh('prerm', 'v1'),
    },
    bin: { uptool: 'tool' },
    desktop: { cmd: 'uptool' },
    openwith: { tup: 'uptool' },
    commands: { testcmd: 'uptool', oldcmd: 'uptool' },
    menu: [{ group: 'TestUp', entry: 'uptool', cmd: 'uptool' }],
    seed: { 'testup/note.txt': 'note.txt', 'testup/keep.txt': 'keep.txt' },
    fonts: ['fa.ttf', 'fb.ttf'],
    postinst: 'postinst', prerm: 'prerm',
  },
  'test-other': {
    name: 'test-other', version: '1.0', summary: 'second claimant fixture', minBase: 1,
    files: { otool: { content: '#!/bin/sh\necho other\n', mode: 0o755 } },
    bin: { othertool: 'otool' },
    commands: { testcmd: 'othertool' },
  },
};
const V2 = {
  'test-up': {
    name: 'test-up', version: '2.0', summary: 'upgrade fixture', minBase: 1,
    files: {
      tool: { content: '#!/bin/sh\necho tool-v2\n', mode: 0o755 },
      'new.txt': { content: 'only-in-v2\n' },
      'note.txt': { content: 'seed-v2\n' },
      'keep.txt': { content: 'keep-v2\n' },
      'fa.ttf': { content: 'face-a\n' },
      postinst: logsh('postinst', 'v2'), prerm: logsh('prerm', 'v2'),
    },
    bin: { uptool: 'tool' },
    desktop: { cmd: 'uptool' },
    openwith: { tup: 'uptool' },
    commands: { testcmd: 'uptool' },              // oldcmd dropped in 2.0
    menu: [{ group: 'TestUp', entry: 'uptool', cmd: 'uptool' }],
    seed: { 'testup/note.txt': 'note.txt', 'testup/keep.txt': 'keep.txt' },
    fonts: ['fa.ttf'],                            // fb.ttf dropped in 2.0
    postinst: 'postinst', prerm: 'prerm',
  },
  'test-other': V1['test-other'],
};
// 3.0: the crash-window version — its postinst parks on a flag file so the
// test can SIGKILL gucman inside the commitment window, then re-run with
// the flag gone. Repo C deliberately does NOT carry test-other (the
// installed-but-unpublished skip leg).
const V3 = {
  'test-up': {
    name: 'test-up', version: '3.0', summary: 'upgrade fixture', minBase: 1,
    files: {
      tool: { content: '#!/bin/sh\necho tool-v3\n', mode: 0o755 },
      'note.txt': { content: 'seed-v3\n' },
      'keep.txt': { content: 'keep-v3\n' },
      'fa.ttf': { content: 'face-a\n' },
      postinst: { content: '#!/bin/sh\ntouch /root/up3-started\n' +
        'while [ -e /root/up3-hang ]; do sleep 1; done\n' +
        'echo "postinst:$1:v3" >> /root/up.log\n', mode: 0o755 },
      prerm: logsh('prerm', 'v3'),
    },
    bin: { uptool: 'tool' },
    desktop: { cmd: 'uptool' },
    openwith: { tup: 'uptool' },
    commands: { testcmd: 'uptool' },
    menu: [{ group: 'TestUp', entry: 'uptool', cmd: 'uptool' }],
    seed: { 'testup/note.txt': 'note.txt', 'testup/keep.txt': 'keep.txt' },
    fonts: ['fa.ttf'],
    postinst: 'postinst', prerm: 'prerm',
  },
};

function buildRepo(tmp, tag, defs) {
  const defsDir = fs.mkdtempSync(path.join(require('os').tmpdir(), `mkpkg-up-${tag}-`));
  const outDir = path.join(tmp, `repo-${tag}`);
  try {
    for (const n of Object.keys(defs))
      fs.writeFileSync(path.join(defsDir, `${n}.json`), JSON.stringify(defs[n], null, 2) + '\n');
    fs.mkdirSync(outDir, { recursive: true });
    const r = cp.spawnSync(process.execPath,
      [path.join(ROOT, 'tools', 'mkpkg.js'), '--no-baseline', '--quiet',
       `--packages-dir=${defsDir}`, `--out=${outDir}`, `--pool=${POOL}`],
      { encoding: 'utf-8', timeout: 300000 });
    if (r.status !== 0) throw new Error(`mkpkg (${tag}) failed: ${r.stderr}`);
    const idx = JSON.parse(fs.readFileSync(path.join(outDir, 'index.json'), 'utf-8'));
    for (const n of Object.keys(defs))
      if (!idx.packages[n]) throw new Error(`repo ${tag} has no ${n}`);
  } finally {
    fs.rmSync(defsDir, { recursive: true, force: true });
  }
  return outDir;
}

async function main() {
  const MIN = ensureMinimalImage();
  const { dir: tmp, image } = freshImage('os-gucman-up-');
  fs.copyFileSync(MIN, image);

  const repoA = buildRepo(tmp, 'v1', V1);
  const repoB = buildRepo(tmp, 'v2', V2);
  const repoC = buildRepo(tmp, 'v3', V3);
  const portA = await startServer(repoA);
  const portB = await startServer(repoB);
  const portC = await startServer(repoC);
  console.log(`[gucman-up] repos v1 :${portA}, v2 :${portB}, v3 :${portC}`);

  const script = [
    'echo ==setup',
    'mkdir -p /etc/gucman /var/lib/gucman',
    'printf "# this test owns its package state\\n" > /etc/gucman/defaults',
    `echo http://127.0.0.1:${portA} > /etc/gucman/repos`,
    'echo on > /var/lib/gucman/desktop_shortcuts',
    'echo ==notinst',
    'gucman upgrade test-up; echo RC=$?',
    'echo ==install1',
    'gucman install test-up; echo RC=$?',
    'gucman install test-other; echo RC2=$?',
    'uptool',
    'readlink /root/Desktop/test-up',
    'echo user-edit >> /root/testup/keep.txt',
    'echo ==uptodate',
    'gucman upgrade test-up; echo RC=$?',
    'echo ==upgrade',
    // toggle OFF before the upgrade — presence, not the toggle, must decide
    'printf "off\\n" > /var/lib/gucman/desktop_shortcuts',
    `echo http://127.0.0.1:${portB} > /etc/gucman/repos`,
    'gucman upgrade test-up; echo RC=$?',
    'uptool',
    'test ! -e /opt/test-up/gone.txt && echo V1-FILE-GONE',
    'test -f /opt/test-up/new.txt && echo V2-FILE-OK',
    'grep \'"version"\' /var/lib/gucman/test-up.json',
    'cat /root/testup/note.txt',
    'cat /root/testup/keep.txt',
    'test -h "/root/Desktop/test-up" && echo DESK-KEPT',
    'grep "^testcmd" /etc/cmdalt | head -1',
    'grep -q "^oldcmd" /etc/cmdalt || echo OLDCMD-RECONCILED',
    'grep "^testcmd" /etc/cmdalt | grep -q othertool && echo OTHER-CLAIM-INTACT',
    'grep -c "fa.ttf" /etc/fonts/fallback',
    'grep -q "fb.ttf" /etc/fonts/fallback || echo FB-FACE-RECONCILED',
    'grep "^tup" /etc/openwith',
    'readlink /etc/menu/TestUp/uptool && echo MENU-OK',
    'test ! -e /var/lib/gucman/removed/test-up && echo NO-TOMB',
    'echo ==uplog',
    'cat /root/up.log',
    'echo ==installnoop',
    'gucman install test-up; echo RC=$?',
    'echo ==downgrade',
    `echo http://127.0.0.1:${portA} > /etc/gucman/repos`,
    'gucman upgrade test-up; echo RC=$?',
    'grep \'"version"\' /var/lib/gucman/test-up.json',
    'uptool',
    'echo ==upall',
    `echo http://127.0.0.1:${portB} > /etc/gucman/repos`,
    'gucman upgrade; echo RC=$?',
    'grep \'"version"\' /var/lib/gucman/test-up.json',
    'grep \'"version"\' /var/lib/gucman/test-other.json',
    'echo ==deskstaysgone',
    // deleted-before stays deleted, even with the toggle back ON
    'echo on > /var/lib/gucman/desktop_shortcuts',
    'rm "/root/Desktop/test-up"',
    `echo http://127.0.0.1:${portA} > /etc/gucman/repos`,
    'gucman upgrade test-up; echo RC=$?',
    'test ! -e "/root/Desktop/test-up" && echo DESK-STAYS-GONE',
    'echo ==crash',
    `echo http://127.0.0.1:${portC} > /etc/gucman/repos`,
    'touch /root/up3-hang',
    'gucman upgrade test-up &',
    // marker wait, 1s supervision tick (the postinst signals its own start)
    'while test ! -e /root/up3-started; do sleep 1; done',
    'pkill -9 gucman',
    'wait',
    'test ! -e /var/lib/gucman/removed/test-up && echo NO-TOMB-AFTER-CRASH',
    'test -f /var/lib/gucman/test-up.json && echo DB-SURVIVES-CRASH',
    'grep \'"version"\' /var/lib/gucman/test-up.json',
    'echo ==recover',
    'rm /root/up3-hang /root/up3-started',
    'gucman upgrade test-up; echo RC=$?',
    'grep \'"version"\' /var/lib/gucman/test-up.json',
    'uptool',
    'test ! -e /var/lib/gucman/removed/test-up && echo NO-TOMB-FINAL',
    'echo ==skipmissing',
    'gucman upgrade test-other; echo RC=$?',
    'gucman upgrade; echo RC2=$?',
    'echo ==done',
  ];
  const r = driveBoot(script, { image, args: ['--packages=none'], timeout: 420000 });
  const out = String(r.stdout || '');
  const all = out + '\n' + String(r.stderr || '');

  const ni = section(out, 'notinst');
  check('upgrade of a not-installed package fails loud', ni.includes('RC=1'), ni);
  check('the failure names the install fix', /not installed — `gucman install test-up`/.test(all),
    all.slice(-800));

  const i1 = section(out, 'install1');
  check('v1 installs (both fixtures)', i1.includes('RC=0') && i1.includes('RC2=0'), i1);
  check('v1 tool answers', i1.includes('tool-v1'), i1);
  check('Desktop shortcut planted at install (toggle on)',
    i1.includes('/usr/local/bin/uptool'), i1);

  const utd = section(out, 'uptodate');
  check('same-version upgrade is a spoken no-op (exit 0)',
    utd.includes('RC=0') && /already up to date \(1\.0\)/.test(utd), utd);

  const up = section(out, 'upgrade');
  check('upgrade 1.0 -> 2.0 succeeds (exit 0)', up.includes('RC=0'), up);
  check('the banner names the exact move', /upgrading test-up 1\.0 -> 2\.0/.test(up), up);
  check('the completion banner too', /upgraded test-up 1\.0 -> 2\.0/.test(up), up);
  check('the new tool answers', up.includes('tool-v2'), up);
  check('a v1-only payload file is gone', up.includes('V1-FILE-GONE'), up);
  check('a v2-only payload file arrived', up.includes('V2-FILE-OK'), up);
  check('the DB record now says 2.0', /"version":\s*"2\.0"/.test(up), up);
  check('pristine seed refreshed to the new content', up.includes('seed-v2'), up);
  check('modified seed kept (user content intact)',
    up.includes('keep-v1') && up.includes('user-edit') && !up.includes('keep-v2'), up);
  check('the keep is loud', /kept \/root\/testup\/keep\.txt \(modified since install\)/.test(all),
    all.slice(-1200));
  check('Desktop shortcut preserved though the toggle is off', up.includes('DESK-KEPT'), up);
  // the script printed `grep "^testcmd" /etc/cmdalt | head -1` — the FIRST
  // claim line for the name. Pre-#545 the replay removed + re-appended the
  // upgraded package's line, which made test-other's claim first and
  // silently flipped the dispatch default: this is that red control.
  const firstClaim = up.split('\n').find((l) => l.startsWith('testcmd'));
  check('cmdalt: test-up\'s claim KEPT FIRST (the default never flips)',
    firstClaim !== undefined && firstClaim.includes('/usr/local/bin/uptool') &&
    !firstClaim.includes('othertool'), firstClaim || up);
  check('cmdalt: the dropped oldcmd claim reconciled away', up.includes('OLDCMD-RECONCILED'), up);
  check('cmdalt: the other package\'s claim untouched', up.includes('OTHER-CLAIM-INTACT'), up);
  check('fallback: exactly one fa.ttf line (no duplicate append)', /^1$/m.test(up), up);
  check('fallback: the dropped fb.ttf face reconciled away', up.includes('FB-FACE-RECONCILED'), up);
  check('openwith key survives the upgrade', /tup\t\/usr\/local\/bin\/uptool/.test(up), up);
  check('menu entry survives the upgrade', up.includes('MENU-OK'), up);
  check('NO tombstone was written by the upgrade', up.includes('NO-TOMB'), up);

  const ul = section(out, 'uplog');
  check('v1 postinst ran at install with verb "install"', ul.includes('postinst:install:v1'), ul);
  check('the OLD prerm ran with verb "upgrade"', ul.includes('prerm:upgrade:v1'), ul);
  check('the NEW postinst ran with verb "upgrade"', ul.includes('postinst:upgrade:v2'), ul);

  const noop = section(out, 'installnoop');
  check('install on an installed package stays a no-op (exit 0)', noop.includes('RC=0'), noop);
  check('the no-op now names the upgrade path',
    /already installed \(2\.0\) — `gucman upgrade test-up`/.test(noop), noop);

  const dg = section(out, 'downgrade');
  check('a repo publishing an older version converges too (exit 0)',
    dg.includes('RC=0') && /upgrading test-up 2\.0 -> 1\.0/.test(dg), dg);
  check('the DB record follows down', /"version":\s*"1\.0"/.test(dg), dg);
  check('the old tool answers again', dg.includes('tool-v1'), dg);

  const ua = section(out, 'upall');
  check('bare `gucman upgrade` converges every installed package (exit 0)',
    ua.includes('RC=0'), ua);
  check('it upgraded the outdated one', /upgraded test-up 1\.0 -> 2\.0/.test(ua), ua);
  check('it left the up-to-date one alone', !/upgrading test-other/.test(ua), ua);
  check('summary counts one move', /1 package\(s\) upgraded/.test(ua), ua);
  check('test-up landed at 2.0', /"version":\s*"2\.0"/.test(ua), ua);
  check('test-other stayed at 1.0', /"version":\s*"1\.0"/.test(ua), ua);

  const dsg = section(out, 'deskstaysgone');
  check('upgrade succeeds after the icon was deleted', dsg.includes('RC=0'), dsg);
  check('a user-deleted Desktop icon does NOT resurrect (toggle on)',
    dsg.includes('DESK-STAYS-GONE'), dsg);

  const cr = section(out, 'crash');
  check('SIGKILL mid-upgrade leaves NO tombstone (the #419 hazard)',
    cr.includes('NO-TOMB-AFTER-CRASH'), cr);
  check('the DB record survives the crash (still "installed")',
    cr.includes('DB-SURVIVES-CRASH'), cr);
  check('the surviving record is the OLD version', /"version":\s*"1\.0"/.test(cr), cr);

  const rec = section(out, 'recover');
  check('re-running upgrade after the crash converges (exit 0)', rec.includes('RC=0'), rec);
  check('the record lands at 3.0', /"version":\s*"3\.0"/.test(rec), rec);
  check('the new tool answers', rec.includes('tool-v3'), rec);
  check('still no tombstone after recovery', rec.includes('NO-TOMB-FINAL'), rec);

  const sm = section(out, 'skipmissing');
  check('named upgrade of an unpublished package fails loud', sm.includes('RC=1'), sm);
  check('the failure says the index cannot resolve it',
    /installed but not in the repository index/.test(all), all.slice(-800));
  check('bare upgrade SKIPS the unpublished package (exit 0)', sm.includes('RC2=0'), sm);
  check('and reports the skip', /test-other is not in the repository index — skipped/.test(all),
    all.slice(-800));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures ? `\ngucman upgrade e2e: ${failures} FAILED` : '\ngucman upgrade e2e: PASS');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e && e.stack || e);
  process.exit(1);
});
