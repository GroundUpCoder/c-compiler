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
// Since #391 a final leg reruns the install with the net bridge ON (a real
// tools/net-bridge.js): same-origin /packages fetches must take the BASE
// fetch (passthrough), proven by the bridge's own /fetch counter — an
// off-origin curl transits it (the switch is really ON), the install
// does not. Pre-#391 the install died "Couldn't connect to server".
//
// Usage: node os-gucman.mjs
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { openOsSession, ROOT, buildPackageRepo } from './lib/os-harness.mjs';

const PORT = 3252;
const require = createRequire(import.meta.url);
// The demo set + the seed destination, derived — never re-listed here.
const NSDEMOS = require(path.join(ROOT, 'vendor/netsurf/demos/demos.js'));
const SEED_DEST = Object.keys(require(
  path.join(ROOT, 'packages/netsurf-demos.json')).seed)[0];

// serve.js bakes/validates the FAT system image itself but does NOT run
// mkpkg — build dist/packages here so the repo index matches the served
// image's version (the minBase gate). Merged over the sibling defs (#665).
buildPackageRepo();

// ---- #391 bridge-leg helpers (the test_netbridge_e2e.js shapes) ----
function freePort() {
  return new Promise((resolve) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}
function spawnBridge(port) {
  const b = spawn(process.execPath,
    [path.join(ROOT, 'tools', 'net-bridge.js'), '--port=' + port, '--quiet'],
    { stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((resolve, reject) => {
    let out = '';
    b.stdout.on('data', (d) => { out += d; if (out.includes('listening')) resolve(b); });
    b.on('exit', (c) => reject(new Error('bridge exited ' + c + ' before listening')));
  });
}
// agent:false — a fresh connection each probe (pooled sockets die across
// the long OS waits and EPIPE the count).
function bridgeCount(base) {
  return new Promise((resolve, reject) => {
    http.get(base + '/health', { agent: false }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(body).requests); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
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

  // ---- #391: bridge ON — same-origin passthrough keeps gucman working ----
  // The shipped bug: with the bridge ON, gucman's relative /packages urls
  // went to the bridge and every catalogue/install fetch died ("Couldn't
  // connect to server"). The fix routes same-origin targets to the BASE
  // fetch even with the bridge explicitly ON. The proof of WHICH path ran
  // is the bridge's own /fetch counter: the off-origin control transits it
  // (counter moves — the switch is genuinely ON, and it doubles as the
  // settle barrier for the live /etc/net watch, which has no other
  // OS-visible completion marker), and the install then leaves the counter
  // untouched (same-origin traffic never bridged).
  const bridgePort = await freePort();
  const bridgeBase = `http://127.0.0.1:${bridgePort}`;
  const bridge = await spawnBridge(bridgePort);
  try {
    await page.keyboard.type(`printf 'bridge on\\nurl ${bridgeBase}\\n' > /etc/net; echo NET-""SET=$?\r`);
    await waitOut('NET-SET=0', 20000);

    const count0 = await bridgeCount(bridgeBase);
    let engaged = false;
    for (let i = 0; i < 30 && !engaged; i++) {
      await page.keyboard.type(`curl -s ${bridgeBase}/health > /dev/null; echo BRC${i}-""RC=$?\r`);
      await waitOut(`BRC${i}-RC=`, 20000);
      engaged = (await bridgeCount(bridgeBase)) > count0;
    }
    check('#391 positive control: off-origin curl transits the bridge (switch really ON)', engaged);

    const count1 = await bridgeCount(bridgeBase);
    await page.keyboard.type('gucman install lua; echo GUC2-""RC=$?\r');
    await waitOut('GUC2-RC=', 120000);
    const bout = await page.evaluate(() => window.__osOut);
    const rc2 = /GUC2-RC=(\d+)/.exec(bout);
    check('#391 bridge ON: gucman install works (same-origin passthrough)',
      rc2 && rc2[1] === '0', rc2 && rc2[1]);
    check('#391 no "Couldn\'t connect to server" with the bridge ON',
      !bout.slice(bout.indexOf('NET-SET=')).includes("Couldn't connect to server"));
    const count2 = await bridgeCount(bridgeBase);
    check('#391 which-path proof: /fetch counter untouched by the install',
      count2 === count1, count1 + ' -> ' + count2);

    // #362: the page-side bridge probe PIPELINE, in a real browser boot —
    // enabling the bridge made the kernel worker announce net-config,
    // os.html's window-context probe ran, and the verdict landed at
    // /run/net-status. The headless e2e can only PLANT that file (no page
    // exists there); this is the one place the real writer runs. On this
    // http origin the hop is local->local, so no permission gate applies
    // and health must be ok (the bridge is live). The platform-BLOCKED
    // half of the story is os-netbridge-https.mjs's.
    let probe = null;
    for (let i = 0; i < 50 && !(probe && probe.health === 'ok'); i++) {
      probe = await page.evaluate(() => window.__osNetProbe || null);
      if (!probe || probe.health !== 'ok') await new Promise((r) => setTimeout(r, 200));
    }
    check('#362 page probe ran and reached the bridge (window.__osNetProbe)',
      !!probe && probe.health === 'ok', JSON.stringify(probe));
    await page.keyboard.type('cat /run/net-status; echo NS-""DONE\r');
    await waitOut('NS-DONE', 20000);
    const nsout = await page.evaluate(() => window.__osOut);
    const nsTail = nsout.slice(Math.max(0, nsout.indexOf('NS-DONE') - 400),
                               nsout.indexOf('NS-DONE'));
    check('#362 /run/net-status recorded by the kernel worker (origin + health)',
      /origin http:\/\/(localhost|127\.0\.0\.1):\d+/.test(nsTail) && /health ok/.test(nsTail),
      JSON.stringify(nsTail.slice(-200)));
  } finally {
    try { bridge.kill(); } catch (e) { /* already gone */ }
  }
} catch (e) {
  s.fail(e);
} finally {
  await s.close();
}
s.finish('os gucman http (browser)');
