#!/usr/bin/env node
// #419 acceptance: DEFAULT PACKAGES — eager install on first boot.
//
// The mechanism (design fork CLOSED by jku 2026-08-03: eager on first boot;
// lazy-on-first-launch is dead — it structurally cannot serve a font, which
// is pulled in by a glyph-cache miss, not a click):
//
//   - The default set is declared ONCE, as `defaultPackages` in os/image.json,
//     and baked to /usr/share/gucman/defaults (one name per line, # comments).
//     /etc/gucman/defaults OVERRIDES it wholesale (the gucman `repos`
//     first-existing-file convention) — that /etc layer is this test's seam.
//   - The trigger is `gucman sync-defaults`, spawned as a kernel service on
//     every boot where a defaults list exists at all (boot.js and
//     kernel-worker.js, right after the /bin/wm service). Since #420 the
//     shipped manifest declares a real set (doom), so every boot spawns the
//     sync; headless the baked origin-relative repo is unreachable and the
//     shipped set fails legibly without installing anything.
//   - THE DURABILITY RULE: the default set means "install once, unless the
//     user has ever said no". `gucman remove <name>` records a tombstone at
//     /var/lib/gucman/removed/<name> BEFORE deleting the DB record; sync
//     skips tombstoned names forever; an explicit `gucman install <name>`
//     clears the tombstone (the user said yes again). Without this state,
//     "first boot" degrades into "every boot where the app is missing" and
//     the OS resurrects what the user deliberately deleted.
//   - Outcome record: sync writes /run/gucman-sync.status (atomic tmp+rename;
//     line 1 `ok`/`failed`, then `installed <name>` / `failed <name>` lines).
//     That is the machine-readable completion marker this test waits on (the
//     0171 rule: wait on a real marker, never a fixed sleep) — /run persists
//     across boots on the root volume, so each session rm's it in its TAIL
//     for the next boot (race-free: the writer is the NEXT boot's sync).
//   - Failure honesty: a dead repo or an unknown name prints a legible
//     message on the boot console and the rest of the OS is unharmed; a
//     missing (non-tombstoned) default retries on the next boot.
//
// Sessions (one driveBoot each — reboots are the point):
//   1. clean minimal boot: the baked defaults file names doom (#420), the
//      offline sync fails legibly and installs nothing; then declare OUR
//      defaults (punes + font-fixture) + repo via /etc at runtime — the
//      /etc layer overrides the baked set wholesale.
//   2. reboot = the "first boot" for those defaults: sync installs BOTH with
//      zero user action — punes (an app: bin symlink, launches) and
//      font-fixture (NOT an app: no executable, no launcher, nothing to
//      click — its /etc/fonts/fallback line is the whole point, the #437
//      glyph-cache-miss shape). Then the user removes punes -> tombstone.
//   3. reboot: jq (appended to the defaults after session 2 — the
//      cached-image "newly added default" case) installs = positive control
//      that sync RAN; punes STAYS GONE (durable removal, the load-bearing
//      negative); font-fixture is not re-downloaded (idempotency, and its
//      fallback line is not duplicated). Explicit `gucman install punes`
//      clears the tombstone.
//   4. dead repo + a still-missing default (win32): sync fails LOUD
//      (status `failed`, legible console message), the OS is unharmed.
//   5. repo restored: win32 (a srclib package — also nothing to click)
//      installs on the next boot (retry semantics); the unknown name
//      `nosuchpkg-419` fails legibly WITHOUT stopping the rest (it sits
//      BEFORE win32 in the list); installed names are not re-touched.
//
// Run: node tests/kernel/test_defaults_sync_e2e.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { driveBoot, freshImage, section } = require('./lib/drive.js');
const { ensureMinimalImage, ensurePackages, startServer } = require('./lib/gucman.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const STATUS = '/run/gucman-sync.status';
// Bounded poll on a real marker (the minesweeper-sample pattern) — loud
// verdict either way, never a dead wait.
const waitFile = (p, secs, tag) =>
  `n=0; while [ ! -e ${p} ] && [ $n -lt ${secs * 2} ]; do sleep 0.5; n=$((n+1)); done; ` +
  `test -e ${p} && echo WAIT-OK-${tag} || echo WAIT-TIMEOUT-${tag}`;

async function main() {
  /* The non-app data-package default is a FIXTURE font built through a
   * private --defs root (#615: the real font packages live in the
   * gucos-packages sibling, and a NATIVE test must not depend on that
   * checkout — the sibling-tests.js 'absent' rule). Inline `content`
   * bytes as the face are the test_gucman_upgrade_e2e precedent: the
   * fontchain skips an unloadable face, and nothing here renders it —
   * the /etc/fonts/fallback PLANT is the subject. minBase 1 (#518: no
   * compiled code). */
  const fixRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'defsync-defs-'));
  fs.mkdirSync(path.join(fixRoot, 'packages'));
  fs.writeFileSync(path.join(fixRoot, 'packages', 'font-fixture.json'), JSON.stringify({
    name: 'font-fixture', version: '1.0', minBase: 1,
    summary: 'defaults-sync fixture: a non-app data package with a fonts plant',
    files: { 'fixture.ttf': { content: 'not-a-real-face\n' } },
    fonts: ['fixture.ttf'],
  }));
  // #464: win32 deps freetype, so the repo must carry it for the sync's
  // transitive install to resolve.
  const repo = ensurePackages(['punes', 'font-fixture', 'jq', 'win32', 'freetype'],
    { defs: [fixRoot] });
  fs.rmSync(fixRoot, { recursive: true, force: true });   // consumed by the mkpkg run above
  const MIN = ensureMinimalImage();
  const { image } = freshImage('os-defsync-');
  fs.copyFileSync(MIN, image);   // copy mtime = now -> input-fresh at boot

  const goodPort = await startServer(repo.dir);
  console.log(`[defaults-sync] repo :${goodPort}`);
  const BOOT_ARGS = { image, args: ['--packages=none'], timeout: 420000 };

  /* ---- session 1: the shipped default set, offline; then declare ours ----
   * #420 ended the []-era this session used to pin: the shipped manifest now
   * declares a real default set (doom), so a defaults file IS baked and sync
   * runs on EVERY boot. Headless the baked repo default (origin-relative
   * /packages) is unreachable, so the shipped set fails LEGIBLY and installs
   * nothing — which is what makes the /etc WHOLESALE override below (this
   * test's actual seam) observable in isolation. */
  const s1 = driveBoot([
    'echo ==base',
    'grep -x doom /usr/share/gucman/defaults && echo BAKED-DEFAULTS-DOOM',
    waitFile(STATUS, 150, 'BASE'),
    `grep -x "failed doom" ${STATUS} && echo BASE-SYNC-FAILED-LEGIBLY`,
    'gucman list',
    'echo ==config',
    'mkdir -p /etc/gucman',
    `echo http://127.0.0.1:${goodPort} > /etc/gucman/repos`,
    'printf "# declared at runtime — the /etc override layer\\npunes\\nfont-fixture\\n" > /etc/gucman/defaults',
    'test ! -e /var/lib/gucman/punes.json && echo NOT-YET-INSTALLED',
    `rm -f ${STATUS}`,   // session 2's wait must see ITS OWN boot's sync
    'echo ==done',
  ], BOOT_ARGS);
  const out1 = String(s1.stdout || '');
  const base1 = section(out1, 'base');
  check('shipped manifest bakes a defaults file naming doom (#420)',
    base1.includes('BAKED-DEFAULTS-DOOM'), base1);
  check('offline boot: the shipped sync ran and failed legibly (nothing installed)',
    base1.includes('WAIT-OK-BASE') && base1.includes('BASE-SYNC-FAILED-LEGIBLY'), base1);
  check('minimal boot starts with nothing installed',
    base1.includes('no packages installed'), base1);
  check('declaring defaults mid-session does not install anything (trigger is boot)',
    section(out1, 'config').includes('NOT-YET-INSTALLED'));

  /* ---- session 2: the eager first boot for the declared defaults ---- */
  const s2 = driveBoot([
    'echo ==sync',
    waitFile(STATUS, 150, 'STATUS'),
    `cat ${STATUS}`,
    'test -e /var/lib/gucman/punes.json && echo PUNES-DB-OK',
    'test -e /var/lib/gucman/font-fixture.json && echo FONT-DB-OK',
    'readlink /usr/local/bin/punes',
    'grep -c fixture.ttf /etc/fonts/fallback',
    'echo ==launch',
    'punes &',
    'wmctl wait win puNES',
    'kill %1',
    'wmctl wait nowin puNES',
    'echo ==remove',
    'gucman remove punes; echo RC=$?',
    'test -e /var/lib/gucman/removed/punes && echo TOMBSTONE-OK',
    'test ! -e /opt/punes && echo OPT-GONE',
    'echo jq >> /etc/gucman/defaults',
    `rm -f ${STATUS}`,
    'echo ==done',
  ], BOOT_ARGS);
  const out2 = String(s2.stdout || '');
  const all2 = out2 + '\n' + String(s2.stderr || '');
  const sync2 = section(out2, 'sync');
  check('sync completed (status file appeared)', sync2.includes('WAIT-OK-STATUS'), sync2);
  check('status reports ok', /^ok$/m.test(sync2), sync2);
  check('status names installed punes', /^installed punes$/m.test(sync2), sync2);
  check('status names installed font-fixture', /^installed font-fixture$/m.test(sync2), sync2);
  check('punes DB record exists (installed with zero user action)',
    sync2.includes('PUNES-DB-OK'), sync2);
  check('font-fixture DB record exists (a non-app default: nothing to click)',
    sync2.includes('FONT-DB-OK'), sync2);
  check('punes bin symlink planted', sync2.includes('/opt/punes/punes'), sync2);
  check('font fallback line planted exactly once (glyph-cache reachable)',
    /^1$/m.test(sync2), sync2);
  check('sync console output announces the install',
    /installed punes/.test(all2) && /installed font-fixture/.test(all2));
  // The window itself is guarded by driveBoot: a failed `wmctl wait win
  // puNES` fails the whole session loudly (the 0171 rule).
  check('the default-installed punes launches (present AND working)',
    all2.includes('using built-in test ROM'), section(out2, 'launch'));
  const rem2 = section(out2, 'remove');
  check('gucman remove succeeds', rem2.includes('RC=0'), rem2);
  check('remove records the tombstone BEFORE the DB record goes',
    rem2.includes('TOMBSTONE-OK'), rem2);
  check('/opt/punes gone after remove', rem2.includes('OPT-GONE'));

  /* ---- session 3: durable removal + later-added default + idempotency ---- */
  const s3 = driveBoot([
    'echo ==sync3',
    waitFile(STATUS, 90, 'STATUS3'),
    `cat ${STATUS}`,
    'test -e /var/lib/gucman/jq.json && echo JQ-DB-OK',
    'test ! -e /var/lib/gucman/punes.json && echo PUNES-STAYS-GONE',
    'test ! -e /opt/punes && echo PUNES-OPT-GONE',
    'test ! -e /usr/local/bin/punes && echo PUNES-LINK-GONE',
    'test -e /var/lib/gucman/font-fixture.json && echo FONT-STILL-THERE',
    'grep -c fixture.ttf /etc/fonts/fallback',
    'echo ==reinstall',
    'gucman install punes; echo RC=$?',
    'test ! -e /var/lib/gucman/removed/punes && echo TOMBSTONE-CLEARED',
    'test -x /opt/punes/punes && echo PUNES-BACK',
    // arm session 4: dead repo, two more defaults (unknown name FIRST, so
    // session 5 proves sync continues past it to win32)
    'printf "nosuchpkg-419\\nwin32\\n" >> /etc/gucman/defaults',
    'echo http://127.0.0.1:1 > /etc/gucman/repos',
    `rm -f ${STATUS}`,
    'echo ==done',
  ], BOOT_ARGS);
  const out3 = String(s3.stdout || '');
  const all3 = out3 + '\n' + String(s3.stderr || '');
  const sync3 = section(out3, 'sync3');
  check('sync ran on the reboot (status file)', sync3.includes('WAIT-OK-STATUS3'), sync3);
  check('the later-added default (jq) installed — positive control that sync ran',
    sync3.includes('JQ-DB-OK'), sync3);
  check('REMOVED DEFAULT STAYS GONE: no DB record', sync3.includes('PUNES-STAYS-GONE'), sync3);
  check('removed default stays gone: no /opt tree', sync3.includes('PUNES-OPT-GONE'));
  check('removed default stays gone: no bin symlink', sync3.includes('PUNES-LINK-GONE'));
  check('installed default untouched on reboot', sync3.includes('FONT-STILL-THERE'));
  check('no duplicate fallback line on reboot (idempotent)', /^1$/m.test(sync3), sync3);
  check('no re-download of an installed default', !/downloading font-fixture/.test(all3), all3.slice(0, 400));
  // The exact instrument for "the sync never touched punes": its status
  // record names only what it acted on. The session's OWN explicit
  // `gucman install punes` below legitimately prints `downloading punes`,
  // so a whole-session console regex would be the wrong probe here.
  check('sync status never names the removed default (skipped, not retried)',
    !/^(installed|failed) punes$/m.test(sync3), sync3);
  const re3 = section(out3, 'reinstall');
  check('explicit reinstall of a removed default succeeds', re3.includes('RC=0'), re3);
  check('explicit install clears the tombstone (the user said yes again)',
    re3.includes('TOMBSTONE-CLEARED'), re3);
  check('reinstalled punes is back', re3.includes('PUNES-BACK'));

  /* ---- session 4: dead repo -> loud failure, OS unharmed ---- */
  const s4 = driveBoot([
    'echo ==dead',
    waitFile(STATUS, 90, 'STATUS4'),
    `cat ${STATUS}`,
    'test ! -e /var/lib/gucman/win32.json && echo WIN32-ABSENT',
    'echo STILL-ALIVE',
    'gucman list',
    // arm session 5: repo restored
    `echo http://127.0.0.1:${goodPort} > /etc/gucman/repos`,
    `rm -f ${STATUS}`,
    'echo ==done',
  ], BOOT_ARGS);
  const out4 = String(s4.stdout || '');
  const all4 = out4 + '\n' + String(s4.stderr || '');
  const dead = section(out4, 'dead');
  check('sync still concludes against a dead repo (status file)',
    dead.includes('WAIT-OK-STATUS4'), dead);
  check('status reports failed', /^failed$/m.test(dead), dead);
  check('the missing default is NOT installed offline', dead.includes('WIN32-ABSENT'));
  check('the failure is legible on the console (names gucman + the fetch)',
    /gucman:.*(index|repository|unreachable|refused|failed)/i.test(all4), all4.slice(-400));
  check('the OS is unharmed (shell runs, gucman works)',
    dead.includes('STILL-ALIVE') && /jq/.test(dead), dead);

  /* ---- session 5: repo back -> retry installs; unknown name skipped loud ---- */
  const s5 = driveBoot([
    'echo ==retry',
    waitFile(STATUS, 90, 'STATUS5'),
    `cat ${STATUS}`,
    'test -e /var/lib/gucman/win32.json && echo WIN32-DB-OK',
    `rm -f ${STATUS}`,
    'echo ==done',
  ], BOOT_ARGS);
  const out5 = String(s5.stdout || '');
  const all5 = out5 + '\n' + String(s5.stderr || '');
  const retry = section(out5, 'retry');
  check('a missed default installs on the next boot with the repo back',
    retry.includes('WIN32-DB-OK'), retry);
  check('status records the win32 install', /^installed win32$/m.test(retry), retry);
  check('the unknown name fails, named, without stopping the rest',
    /^failed nosuchpkg-419$/m.test(retry) && /^failed$/m.test(retry), retry);
  check('unknown-name failure is legible on the console',
    /nosuchpkg-419.*not found in the repository index/.test(all5), all5.slice(-400));
  check('installed defaults are not re-touched on the retry boot',
    !/downloading jq/.test(all5) && !/downloading font-fixture/.test(all5));

  console.log(failures ? `\n${failures} check(s) FAILED` : '\ndefaults-sync e2e OK');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
