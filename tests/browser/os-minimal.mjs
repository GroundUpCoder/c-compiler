// The MINIMAL-image install gate — the browser realm against the DEPLOYED
// artifact shape, not the dev-convenience one.
//
// WHY THIS FILE EXISTS
// -------------------
// Every other browser file boots the FAT fixture: serve.js folds every
// packages/<name>.json back into the blob before serving it (and
// tests/lib/image-fixture.js bakes os/os-system.img the same way). The
// DEPLOY does the opposite — comguc/scripts/build.mjs bakes a plain
// `mkimage.js --out=…` with nothing folded and publishes the mkpkg repo at
// /packages, so every optional app installs at RUNTIME over HTTP. The two
// artifacts are ~111 MB and ~23 MB and they do NOT contain the same files.
//
// That gap is not theoretical. v170 shipped `netsurf-demos` and its commit
// message says "preinstalled"; on the deployed image it is not — it is an
// installable package, and nothing anywhere booted the shape users boot.
// serve.js carried a comment saying a deploy-shaped serve was future work.
// This file is that work: it boots the MINIMAL blob plus a real served
// package repo and installs the package the way a user would.
//
// The load-bearing assertion is the NEGATIVE CONTROL: before the install the
// demos must be ABSENT. If this suite is ever pointed back at the fat image
// (or `--minimal` stops working), that assertion goes red instead of the
// file quietly re-testing what everything else already tests.
//
// Nothing here lists a demo, a package or a count: the demo set comes from
// vendor/netsurf/demos/demos.js, the planted file set from drive.js's
// pkgSeedPlants(), the catalog + card ordering from the live index.json, and
// the base version from os/image.json.
//
// Usage: node os-minimal.mjs
import { spawnSync } from 'node:child_process';
import fsMod from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { openOsSession, ROOT } from './lib/os-harness.mjs';

const PORT = 3255;
const require = createRequire(import.meta.url);
const { BLOCK_FS } = require(path.join(ROOT, 'host.js'));
const COMMON = require(path.join(ROOT, 'os', 'os-common.js'));
const drive = require(path.join(ROOT, 'tests', 'kernel', 'lib', 'drive.js'));
const NSDEMOS = require(path.join(ROOT, 'vendor/netsurf/demos/demos.js'));

const PKG = 'netsurf-demos';
const MANIFEST = JSON.parse(fsMod.readFileSync(path.join(ROOT, 'os/image.json'), 'utf8'));
// The seed destination + the exact planted file set, derived from the package
// definition through os-common's own tree enumeration (drive.js pkgSeedPlants).
const SEED_DEST = Object.keys(require(path.join(ROOT, 'packages', PKG + '.json')).seed)[0];
const BASE = '/root/' + SEED_DEST;
const PLANTS = drive.pkgSeedPlants(PKG);
const DEMOS = NSDEMOS.demos();

// The fat fixture must come out of this run untouched: `--minimal` bakes a
// SIDECAR precisely so it cannot invalidate the shared os/os-system.img that
// every other suite's freshness gate keys on (a minimal blob at the same
// version is NOT that fixture — image-fixture.js compares the package set).
const FAT_IMG = path.join(ROOT, 'os', 'os-system.img');
const MIN_IMG = path.join(ROOT, 'os', 'os-system.minimal.img');
const fatBefore = fsMod.existsSync(FAT_IMG)
  ? (({ size, mtimeMs }) => ({ size, mtimeMs }))(fsMod.statSync(FAT_IMG)) : null;

// serve.js bakes/validates the system image itself but does NOT run mkpkg —
// build dist/packages here so the served repo's index matches the served
// image's version (the minBase gate), exactly like os-gucman.mjs.
{
  const r = spawnSync(process.execPath,
    [path.join(ROOT, 'tools', 'mkpkg.js'), '--no-baseline', '--quiet'], { stdio: 'inherit' });
  if (r.status !== 0) { console.error('mkpkg failed — cannot serve a package repo'); process.exit(1); }
}
const INDEX = JSON.parse(fsMod.readFileSync(
  path.join(ROOT, 'dist', 'packages', 'index.json'), 'utf8'));
const NAMES = Object.keys(INDEX.packages).sort();
if (!INDEX.packages[PKG]) { console.error(`mkpkg produced no ${PKG} entry`); process.exit(1); }
const PKG_VER = INDEX.packages[PKG].version;
// minBase pins (#518). netsurf-demos DECLARES its floor now (169, the seed
// content-kind's first shipped version), so it no longer sits on the
// minBase == base boundary — that role moves to `netsurf`, the card sorted
// directly above it (visible in the same viewport after the scroll below),
// which stays undeclared and therefore stamps the current image version.
// Both pins are preconditions: if either package's declaration changes, this
// test must be re-pointed, not silently allowed to go vacuous.
const PKG_MINBASE = require(path.join(ROOT, 'packages', PKG + '.json')).minBase;
if (!Number.isInteger(PKG_MINBASE) || INDEX.packages[PKG].minBase !== PKG_MINBASE ||
    !(PKG_MINBASE < (MANIFEST.version | 0))) {
  console.error(`${PKG} must declare an explicit minBase below the image version and it must ` +
    `ride the index verbatim (def=${PKG_MINBASE}, index=${INDEX.packages[PKG].minBase}, ` +
    `image=${MANIFEST.version}) — if its declaration changed, re-point this test`);
  process.exit(1);
}
const BOUNDARY_PKG = 'netsurf';
const BOUNDARY_VER = INDEX.packages[BOUNDARY_PKG] && INDEX.packages[BOUNDARY_PKG].version;
if (!INDEX.packages[BOUNDARY_PKG] ||
    INDEX.packages[BOUNDARY_PKG].minBase !== (MANIFEST.version | 0)) {
  console.error(`${BOUNDARY_PKG} is this test's minBase == base boundary card and must stay ` +
    `undeclared (index minBase=${INDEX.packages[BOUNDARY_PKG] &&
    INDEX.packages[BOUNDARY_PKG].minBase}, image=${MANIFEST.version}) — if it now declares ` +
    `a floor, pick another undeclared package for the boundary leg`);
  process.exit(1);
}
// Card order is sorted-by-name; the header contributes two buttons before the
// first card (Refresh, then the "Install to Desktop" toggle) — the same
// prediction tests/kernel/test_software_e2e.js makes and re-verifies.
const PKG_BTN = 2 + NAMES.indexOf(PKG);

// A stale/missing minimal sidecar makes serve.js bake BEFORE listening.
const s = await openOsSession({
  port: PORT, serveArgs: ['--minimal'],
  serverTries: 900, serverInterval: 500,
});
const { page, check, waitOut, setVt, waitScreen } = s;

// ---- shell driver -------------------------------------------------------
// One typed line + its rc, sliced out of the tty mirror. The `TAG` needle is
// SPLIT in the typed text (`TA""G`) so the line's own echo can never satisfy
// the wait (the 0171 rule); the rc lands as `TAG-RC=N`, so a failing command
// fails HERE rather than by a downstream timeout.
let cursor = 0;
async function sh(cmd, tag, ms = 30000) {
  const typed = `${cmd}; echo ${tag.slice(0, -1)}""${tag.slice(-1)}-RC=$?\r`;
  await page.keyboard.type(typed);
  await waitOut(`${tag}-RC=`, ms);
  const out = await page.evaluate(() => window.__osOut);
  const seg = out.slice(cursor);
  cursor = out.length;
  const m = new RegExp(`${tag}-RC=(\\d+)`).exec(seg);
  return { seg, rc: m ? parseInt(m[1], 10) : null };
}

try {
  await setVt(1);

  // ---- leg 0: we really are on the MINIMAL image -------------------------
  // Non-vacuity guard. bakedPackages() reads the blob's os-release PACKAGES=
  // line — the identity axis that distinguishes a fat blob from a minimal one
  // at the same VERSION_ID. Asserted on the artifact AND from inside the OS,
  // so "am I on the shape I claim?" is a checked fact, not an assumption.
  console.log('\nleg 0 — the served artifact is the deploy shape');
  check('serve.js --minimal baked the sidecar os/os-system.minimal.img',
    fsMod.existsSync(MIN_IMG));
  {
    const store = new COMMON.NodeFileStore(fsMod, MIN_IMG, false);
    const v = COMMON.bakedVersion(BLOCK_FS, store);
    const pk = COMMON.bakedPackages(BLOCK_FS, store);
    store.close();
    check('sidecar is at the manifest version', v === (MANIFEST.version | 0),
      `blob v${v}, manifest v${MANIFEST.version}`);
    check('sidecar folds NO packages (an empty os-release PACKAGES=)',
      pk.length === 0, pk.join(','));
  }
  {
    const now = fsMod.existsSync(FAT_IMG)
      ? (({ size, mtimeMs }) => ({ size, mtimeMs }))(fsMod.statSync(FAT_IMG)) : null;
    check('the shared FAT fixture os/os-system.img was not touched',
      JSON.stringify(now) === JSON.stringify(fatBefore),
      `${JSON.stringify(fatBefore)} -> ${JSON.stringify(now)}`);
  }
  {
    // ...and the OS that actually booted is that blob. `PACKAGES=` is written
    // only when something was folded, so its ABSENCE is the minimal marker.
    const r = await sh('grep -c . /usr/share/os-release', 'REL');
    check('the booted /usr carries an os-release', r.rc === 0, r.seg.slice(-300));
    const v = await sh(`grep '^VERSION_ID=' /usr/share/os-release`, 'VER');
    check('booted VERSION_ID matches os/image.json',
      v.seg.includes(`VERSION_ID=${MANIFEST.version}`), v.seg.slice(-300));
    const p = await sh(`grep '^PACKAGES=' /usr/share/os-release`, 'PKG');
    check('booted /usr has NO PACKAGES= line — this is the minimal image',
      p.rc !== 0 && !/^PACKAGES=/m.test(p.seg), p.seg.slice(-300));
  }

  // ---- leg 1: the negative control — the demos are ABSENT ----------------
  // This is what makes the whole file non-vacuous. On the fat image every one
  // of these exists (that is what os-gucman.mjs asserts); here they must not.
  console.log('\nleg 1 — before install: nothing of the package is present');
  {
    const b = await sh(`ls -d /usr/opt/${PKG}`, 'NOBAKED');
    check('no baked twin under the sealed /usr/opt', b.rc !== 0, b.seg.slice(-300));
    const d = await sh(`ls -d "${BASE}"`, 'NOSEED');
    check(`the seed destination "${SEED_DEST}" does not exist`, d.rc !== 0, d.seg.slice(-300));
    // and no planted file survives anywhere under it
    const f = await sh(`find "${BASE}" -type f 2>/dev/null | wc -l`, 'NOFILES');
    check('zero planted demo files', /(^|\n)\s*0\s*(\r?\n)/.test(f.seg), f.seg.slice(-300));
    const db = await sh(`ls /var/lib/gucman/${PKG}.json`, 'NODB');
    check('no gucman install-DB record', db.rc !== 0, db.seg.slice(-300));
  }

  // ---- leg 2: install through the Software Center UI ---------------------
  // Driven through the wm agent protocol (`wmctl click`, `wmctl wait label`)
  // — the project's sanctioned UI driver, addressing real windows by their
  // live text, never by pixel coordinates (OS.md's agent-target pillar). It
  // is the same surface a human clicks: software.c fetches the catalog, the
  // card renders, the Install button runs a real `gucman install` job.
  console.log('\nleg 2 — install through the Software Center');
  {
    const r = await sh('software &', 'SWSPAWN');
    check('software launched', r.rc === 0, r.seg.slice(-300));
  }
  {
    const r = await sh('wmctl wait win Software 60000', 'SWWIN', 90000);
    check('the Software window came up', r.rc === 0, r.seg.slice(-400));
  }
  {
    // Catalog-loaded barrier: the FIRST card is always above the fold. The
    // startup auto-fetch pulls /packages/index.json off the SAME origin that
    // served the page (the baked origin-relative repo default).
    // Wait budgets here are FAILURE deadlines, not sync points, and they are
    // kept tight on purpose: on the wrong (fat) image every card reads
    // [built-in] instead and these waits are what goes red — the sum of them
    // must still leave a red run inside the sweep's 600s per-file timeout, or
    // the informative failure degrades into a bare kill.
    const first = `${NAMES[0]} ${INDEX.packages[NAMES[0]].version} [available]`;
    const r = await sh(`wmctl wait label '${first}' 60000`, 'SWCAT', 90000);
    check(`catalog rendered from the live index (first card: ${NAMES[0]})`,
      r.rc === 0, r.seg.slice(-600));
  }
  {
    // `wmctl wait label` needs a VISIBLE card, so scroll the target into view
    // with the scrollbar's down arrow (SB_LINEDOWN — card-granular and
    // focus-independent, unlike VK_DOWN). Count derived from the card order.
    await sh('SWID=$(wmctl list | grep "Software$" | sed "s/[^0-9].*//")', 'SWID');
    const downs = Math.max(0, NAMES.indexOf(PKG) - 2);
    for (let i = 0; i < downs; i++) {
      await sh('wmctl down $SWID 632 420 && wmctl up $SWID 632 420', `SCRL${i}`);
    }
    // Deliverable B, the AVAILABLE half, both minBase cases on real cards
    // (#518). The BOUNDARY case: netsurf declares no explicit minBase, so
    // mkpkg stamps it with the image version — minBase == the running base.
    // software.c gates on `g_base < minBase`, so its card MUST read
    // [available]; with `<=` it would read [needs newer OS] on the very
    // version that introduced it. (The boundary's other side — minBase ==
    // base + 1 — is pinned in tests/kernel/test_software_e2e.js.) The
    // DECLARED-FLOOR case: netsurf-demos declares minBase 169 < base, and
    // that card must read [available] too — the declared value rode the
    // index (pinned above) and the gate honoured it. netsurf sorts directly
    // above netsurf-demos, so both cards share the scrolled viewport
    // (`wait label` needs a VISIBLE card — software.c renders card-granular
    // from g_scroll).
    const rb = await sh(`wmctl wait label '${BOUNDARY_PKG} ${BOUNDARY_VER} [available]' 30000`,
      'SWBOUND', 60000);
    check(`${BOUNDARY_PKG} lists as [available] at minBase == base (v${MANIFEST.version})`,
      rb.rc === 0, rb.seg.slice(-600));
    const r = await sh(`wmctl wait label '${PKG} ${PKG_VER} [available]' 30000`,
      'SWCARD', 60000);
    check(`${PKG} lists as [available] at declared minBase ${PKG_MINBASE} < base (v${MANIFEST.version})`,
      r.rc === 0, r.seg.slice(-600));
  }
  {
    const r = await sh(`wmctl click BUTTON:${PKG_BTN}`, 'SWCLICK');
    check('clicked the card\'s Install button', r.rc === 0, r.seg.slice(-400));
    const w = await sh(`wmctl wait label '${PKG} ${PKG_VER} [installed]' 120000`,
      'SWINST', 150000);
    check('the card flipped to [installed] — a real gucman job over HTTP',
      w.rc === 0, w.seg.slice(-600));
  }

  // ---- leg 3: what landed is REAL ---------------------------------------
  console.log('\nleg 3 — after install: the seed landed and the demos work');
  {
    const db = await sh(`test -e /var/lib/gucman/${PKG}.json`, 'DBOK');
    check('the install-DB record exists', db.rc === 0, db.seg.slice(-300));

    // Exact set equality against the DERIVED plant list — catches a missing
    // subresource AND an unexpected extra file. `find` output is unordered.
    const f = await sh(`find "${BASE}" -type f | sort`, 'FIND', 60000);
    const body = f.seg.slice(f.seg.indexOf('\n'));
    const got = body.split('\n').map((l) => l.replace(/\r/g, '').trim())
      .filter((l) => l.startsWith(BASE + '/'))
      .sort();
    const want = PLANTS.files.slice().sort();
    check(`every declared file planted (${want.length})`,
      JSON.stringify(got) === JSON.stringify(want),
      `missing ${JSON.stringify(want.filter((w) => !got.includes(w)))} ` +
      `extra ${JSON.stringify(got.filter((g) => !want.includes(g)))}`);

    // The external subresources each demo's markup asks for, present at the
    // exact folder-local path the <link>/<script> spells.
    for (const d of DEMOS) {
      for (const rel of d.styles.concat(d.scripts)) {
        check(`  ${d.name}: subresource "${rel}" planted next to its page`,
          got.includes(`${BASE}/${d.name}/${rel}`));
      }
    }
  }

  // "The file is present" is not "the page works". Open the INSTALLED copy in
  // a real /bin/netsurf window and read the demo's own load-check pill off the
  // composited pixels: the pill is painted #c00000 by the demo's EXTERNAL
  // stylesheet and flipped to #008000 by its EXTERNAL script, so a green pill
  // means both subresources were fetched next to the page and both took
  // effect. The predicates are the demos' own (NSDEMOS.PILL), shipped into the
  // page as source so this file cannot hold a second copy of the colours.
  const pillCounts = () => page.evaluate((srcs) => {
    const isGreen = eval('(' + srcs[0] + ')');
    const isRed = eval('(' + srcs[1] + ')');
    const c = document.getElementById('screen');
    const r = c.getBoundingClientRect();
    const sc = window.__osScreen || { w: 0, h: 0 };
    const t = document.createElement('canvas');
    t.width = Math.max(Math.round(r.width), sc.w);
    t.height = Math.max(Math.round(r.height), sc.h);
    t.getContext('2d').drawImage(c, 0, 0);
    const d = t.getContext('2d').getImageData(0, 0, t.width, t.height).data;
    let g = 0, rd = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (isGreen(d[i], d[i + 1], d[i + 2])) g++;
      else if (isRed(d[i], d[i + 1], d[i + 2])) rd++;
    }
    return { green: g, red: rd };
  }, [String(NSDEMOS.PILL.isGreen), String(NSDEMOS.PILL.isRed)]);

  // Poll the composite for the pill (a real condition, never a fixed sleep):
  // the window title barrier says the document parsed, but the switch to VT2
  // still owes us one composited frame.
  async function waitPill(pred, ms, what) {
    const t0 = Date.now();
    for (;;) {
      const c = await pillCounts();
      if (pred(c)) return c;
      if (Date.now() - t0 > ms) throw new Error(`${what}; last ${JSON.stringify(c)}`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  const probe = DEMOS[0];   // the set is derived, so index 0 is any demo
  {
    const r = await sh(
      `netsurf "${BASE}/${probe.name}/index.html" & wmctl wait win "${probe.title}" 90000`,
      'NSUP', 120000);
    check(`opened the installed "${probe.name}" demo in netsurf`, r.rc === 0, r.seg.slice(-500));
    await setVt(2);
    await waitScreen();
    const c = await waitPill((x) => x.green > 0, 60000,
      `the installed ${probe.name} demo never painted a GREEN load-check pill ` +
      `(its external stylesheet and script must both have taken effect)`);
    check(`  its load-check pill is GREEN — external CSS + JS both live (${c.green}px)`, true);
    check('  ...and no RED pill remains', c.red === 0, JSON.stringify(c));
    await setVt(1);
    await sh(`wmctl close $(wmctl list | grep "${probe.title}$" | sed "s/[^0-9].*//") && ` +
      `wmctl wait nowin "${probe.title}" 15000`, 'NSCLOSE');
  }
  {
    // Negative control for the pill itself: the same installed page with its
    // external script removed must go RED and never green. Without this the
    // green count above could be measuring anything.
    await sh(`cp -r "${BASE}/${probe.name}" /root/nojs && rm /root/nojs/${probe.scripts[0]}`, 'NOJSCP');
    const r = await sh(`netsurf /root/nojs/index.html & wmctl wait win "${probe.title}" 90000`,
      'NOJSUP', 120000);
    check('opened the script-stripped copy (pill negative control)', r.rc === 0, r.seg.slice(-500));
    await setVt(2);
    await waitScreen();
    const c = await waitPill((x) => x.red > 0, 60000,
      'the script-stripped copy never painted a RED pill — the pill check ' +
      'above may not be measuring the demo at all');
    check(`  script-stripped copy is RED, not green (${c.red}px red, ${c.green}px green)`,
      c.green === 0, JSON.stringify(c));
    await setVt(1);
  }

  // Loud-symptom gate, the browser twin of driveBoot's: a `wmctl wait` that
  // could not be satisfied prints to stderr and exits 1, but a script without
  // `set -e` just burns its clock and sails on. Any timeout in this session is
  // a bug — every wait here is on a condition that must become true.
  {
    const out = await page.evaluate(() => window.__osOut);
    const timeouts = (out.match(/wmctl: wait [^\n]*timed out[^\n]*/g) || []);
    check('no wmctl wait timed out during the session',
      timeouts.length === 0, timeouts.join(' | '));
  }
} catch (e) {
  s.fail(e);
} finally {
  await s.close();
}
s.finish('os minimal-image install (browser)');
