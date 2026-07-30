// gucman browser-realm HTTP acceptance (ticket #78 / P0 receiver-bug class).
//
// The kernel's HTTP transport (todos/0172) calls `this._fetch(url, init)`.
// Browsers BRAND-CHECK fetch's receiver: an unbound global `fetch` stored on
// the Kernel throws `TypeError: Illegal invocation` before any request goes
// out — which gucman surfaced live as "Couldn't connect to server". Node's
// undici does NOT brand-check, so every kernel-suite e2e (Node realm) passed
// while the browser path had never worked. This test is the class-closer: it
// exercises __http_open/status/read/close through a REAL Chromium realm —
// gucman fetches /packages/index.json + a payload over the kernel fetch,
// sha256-verifies, extracts, and the installed binary runs. RED on the
// unbound-fetch kernel.js (GUC-RC=1 + the "Couldn't connect" symptom),
// green on fetch.bind(globalThis).
//
// Usage: node os-gucman.mjs
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';
import { openOsSession, ROOT } from './lib/os-harness.mjs';

const PORT = 3252;
const require = createRequire(import.meta.url);
// The demo set + the seed destination, derived — never re-listed here.
const NSDEMOS = require(path.join(ROOT, 'vendor/netsurf/demos/demos.js'));
const SEED_DEST = Object.keys(require(
  path.join(ROOT, 'packages/netsurf-demos.json')).seed)[0];

// serve.js bakes/validates the FAT system image itself but does NOT run
// mkpkg — build dist/packages here so the repo index matches the served
// image's version (the minBase gate).
{
  const r = spawnSync(process.execPath,
    [path.join(ROOT, 'tools', 'mkpkg.js'), '--quiet'], { stdio: 'inherit' });
  if (r.status !== 0) { console.error('mkpkg failed — cannot serve a package repo'); process.exit(1); }
}

// A stale image makes serve.js re-bake BEFORE listening — give it room
// (the default 50×100ms only covers an already-fresh tree).
const s = await openOsSession({ port: PORT, serverTries: 600, serverInterval: 500 });
const { page, check, waitOut, setVt } = s;

try {
  await setVt(1);

  // The whole __http_* path in one shot: repo index fetch + payload fetch
  // (streamed FS_READ over the http fd), sha256 verify, staged extract,
  // symlink plant.
  // Split needle (`""`) so the typed line's own tty echo can't satisfy the
  // wait (the 0171 rule); the rc lands as `GUC-RC=N` and we assert on N so
  // a failing install fails HERE, loudly, not by timeout.
  await page.keyboard.type('gucman install lua; echo GUC-RC""=$?\r');
  await waitOut('GUC-RC=', 120000);
  const out = await page.evaluate(() => window.__osOut);
  const rc = /GUC-RC=(\d+)/.exec(out);
  check('gucman install exits 0 (real fetch through the browser realm)',
    rc && rc[1] === '0', rc && rc[1]);
  check('no "Couldn\'t connect to server" (the #78 unbound-fetch symptom)',
    !out.includes("Couldn't connect to server"));

  // The payload really landed from the network repo (the FAT image's baked
  // twin lives at /usr/opt — /opt/lua exists only via a live install).
  await page.keyboard.type('ls /opt/lua/lua && echo OPT-""OK\r');
  await waitOut('OPT-OK', 20000);
  check('payload extracted to /opt/lua', true);

  // And the planted /usr/local/bin symlink runs the fetched binary (full
  // path — bare `lua` could hit the baked /bin twin and mask a dead install).
  await page.keyboard.type('/usr/local/bin/lua -e \'print("LUA-" .. "VIA-HTTP")\'\r');
  await waitOut('LUA-VIA-HTTP', 30000);
  check('installed binary runs via the planted symlink', true);

  // #83: the human catalog + per-package info ride the same browser realm.
  // The FAT image bakes package twins under /usr/opt with NO install-DB
  // records, so those read "built-in" (win32 Lane 0) — only the
  // live-installed lua reads "installed" here.
  await page.keyboard.type('gucman list --all; echo CAT-""RC=$?\r');
  await waitOut('CAT-RC=', 60000);
  const cat = await page.evaluate(() => window.__osOut);
  check('catalog exits 0', /CAT-RC=0/.test(cat));
  check('catalog table has AVAILABLE + INSTALLED columns',
    /NAME\s+AVAILABLE\s+INSTALLED\s+SUMMARY/.test(cat));
  check('catalog row shows lua installed at the available version',
    /^lua\s+(\S+)\s+\1\s/m.test(cat));
  check('catalog row shows punes built-in (baked, no DB record)',
    /^punes\s+\S+\s+built-in\s/m.test(cat));

  await page.keyboard.type('gucman info lua; echo INFO-""RC=$?\r');
  await waitOut('INFO-RC=', 60000);
  await page.keyboard.type('gucman info punes; echo INFO2-""RC=$?\r');
  await waitOut('INFO2-RC=', 60000);
  const inf = await page.evaluate(() => window.__osOut);
  const luaInfo = inf.slice(inf.indexOf('CAT-RC='), inf.indexOf('INFO-RC='));
  const punesInfo = inf.slice(inf.indexOf('INFO-RC='));
  check('info lua exits 0', /INFO-RC=0/.test(inf));
  check('info shows lua installed', /installed:\s+yes/.test(luaInfo));
  check('info2 punes exits 0', /INFO2-RC=0/.test(inf));
  check('info shows punes built-in',
    /package:\s+punes/.test(punesInfo) && /installed:\s+built-in\b/.test(punesInfo));

  // Clean removal replays the DB (also proves the install recorded one).
  await page.keyboard.type('gucman remove lua; echo RM-RC""=$?\r');
  await waitOut('RM-RC=', 30000);
  const out2 = await page.evaluate(() => window.__osOut);
  const rm = /RM-RC=(\d+)/.exec(out2);
  check('gucman remove exits 0', rm && rm[1] === '0', rm && rm[1]);

  // ---- the `seed` content resource kind, in the BROWSER realm ----
  // This is the one thing the kernel suite structurally cannot speak for:
  // boot.js seeds a virgin root from the FOLDED manifest while
  // kernel-worker.js seeds from the RAW fetched image.json, so a
  // preinstalled seed that works headless can still be a no-op here. The
  // design routes baked seeds through the BLOB (seedBakedSeeds over
  // /usr/opt/<name>/control.json) precisely to be immune to that — and
  // this leg is what proves it in a real browser fresh boot.
  const LS = `ls "/root/${SEED_DEST}"`;
  await page.keyboard.type(`${LS}; echo SEED-""RC=$?\r`);
  await waitOut('SEED-RC=', 30000);
  const seed1 = await page.evaluate(() => window.__osOut);
  const seeded = seed1.slice(seed1.indexOf('RM-RC='));
  check('the baked seed planted on a BROWSER virgin root', /SEED-RC=0/.test(seeded));
  for (const name of NSDEMOS.demoNames()) {
    check(`  seeded demo "${name}" is there`, seeded.includes(name));
  }

  // The interplay case (design §5): installing the package OVER its baked
  // twin must skip-and-keep the already-planted files, and removing that
  // overlay install must NOT strip the baked layer's seeds — because a
  // skipped dest is never recorded, so remove has nothing to unlink.
  await page.keyboard.type('gucman install netsurf-demos; echo NSI-""RC=$?\r');
  await waitOut('NSI-RC=', 120000);
  const ins = await page.evaluate(() => window.__osOut);
  check('installing over the baked twin exits 0', /NSI-RC=0/.test(ins));
  check('...and kept the files that were already planted',
    ins.slice(ins.indexOf('SEED-RC=')).includes('kept existing'));

  await page.keyboard.type('gucman remove netsurf-demos; echo NSR-""RC=$?\r');
  await waitOut('NSR-RC=', 60000);
  await page.keyboard.type(`${LS}; echo SEED2-""RC=$?\r`);
  await waitOut('SEED2-RC=', 30000);
  const after = await page.evaluate(() => window.__osOut);
  const tail = after.slice(after.indexOf('NSI-RC='));
  check('removing the overlay install exits 0', /NSR-RC=0/.test(tail));
  // everything the second ls printed sits between the remove's rc and its own
  const afterRemove = tail.slice(tail.indexOf('NSR-RC='));
  check('...and the baked layer\'s seeds SURVIVE it', /SEED2-RC=0/.test(afterRemove));
  for (const name of NSDEMOS.demoNames()) {
    check(`  "${name}" still there after remove`, afterRemove.includes(name));
  }
} catch (e) {
  s.fail(e);
} finally {
  await s.close();
}
s.finish('os gucman http (browser)');
