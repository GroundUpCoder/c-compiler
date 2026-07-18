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
import { openOsSession, ROOT } from './lib/os-harness.mjs';

const PORT = 3252;

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
  // (streamed HTTP_READ), sha256 verify, staged extract, symlink plant.
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

  // Clean removal replays the DB (also proves the install recorded one).
  await page.keyboard.type('gucman remove lua; echo RM-RC""=$?\r');
  await waitOut('RM-RC=', 30000);
  const out2 = await page.evaluate(() => window.__osOut);
  const rm = /RM-RC=(\d+)/.exec(out2);
  check('gucman remove exits 0', rm && rm[1] === '0', rm && rm[1]);
} catch (e) {
  s.fail(e);
} finally {
  await s.close();
}
s.finish('os gucman http (browser)');
