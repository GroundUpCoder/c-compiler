// todos/0152 (#40) — the browser half of the `serve.js --clang` acceptance
// that todos/0141 landed headlessly: a REAL Chromium boots the served
// clang-apps overlay blob and the clang-built apps are present and RUN.
// 0141 proved the bake (sidecar blob carries /usr/bin/doom-clang, os-release
// overlays lists clang-apps) and hermetically regression-tests the serve
// path (tests/serve/test_clang_overlay.js); what was never done — Playwright
// was absent in that clone — was the actual browser boot. This member owns
// it so the verification is a regression test, not a one-off.
//
// The sibling artifact is OPTIONAL by design (0141: consume the published
// artifact, never build the toolchain), so this member SKIPS — loudly, with
// the resolved path — when ../clang-simplified/out-image/overlay.json is
// absent. A skip is exit 0 with a SKIP line in the log: the record states
// its own scope (todos/0339).
//
// Legs: boot the --clang serve to ready; os-release names the overlay;
// doom-clang + stl4 + sdldemo + the Games menu entry are in the sealed
// /usr; `sdldemo &` opens a window whose region really RENDERS (the
// os-doom.mjs region-stats pattern — distinct colors + non-desktop
// coverage, no golden frames).
//
// doom-clang itself is NOT the render subject (yet): the 2026-08-06 run of
// this verification found the PUBLISHED artifact (clang-simplified
// @a1a2a6b) SEGVs at startup — in the browser AND under a headless
// `boot.js --overlay=clang-apps`, so it is the artifact (or a platform ABI
// drift since it was built), not the serve path. This member still RUNS it
// and prints the exit status loudly so the log records the state; the
// render assertion rides sdldemo, which the same run measured working
// (window + frames). When the artifact is rebuilt green, promote the
// doom-clang leg to a real render assert.
//
// Usage: node os-clang.mjs
import fs from 'node:fs';
import path from 'node:path';
import { openOsSession, ROOT } from './lib/os-harness.mjs';

const PORT = 3341;   // unique per member (#546)

const OVERLAY = path.resolve(ROOT, '..', 'clang-simplified', 'out-image', 'overlay.json');
if (!fs.existsSync(OVERLAY)) {
  console.log(`SKIP: sibling clang overlay artifact absent (${OVERLAY}) — ` +
    'serve.js --clang would serve the base image; nothing to verify. ' +
    'Build/publish clang-simplified out-image to enable this member.');
  process.exit(0);
}

// First --clang serve on a tree bakes the overlay SIDECAR blob before
// listening — give waitForServer bake-scale room (the os-rust precedent).
const s = await openOsSession({
  port: PORT, serveArgs: ['--clang'],
  readyLabel: 'boots to ready (clang-apps overlay blob served)',
  serverTries: 600, serverInterval: 500,
});
const { page, check, waitOut, setVt, waitScreen } = s;

try {
  // A healthy ready auto-switches to the desktop (VT2, todos/0070) — shell
  // typing needs VT1 (typed input goes to the VISIBLE tab).
  await setVt(1);

  // ---- the overlay really is the served identity, from inside the OS ----
  await page.keyboard.type('grep -i overlays /usr/share/os-release\r');
  await waitOut('clang-apps', 20000);
  check('os-release names the clang-apps overlay', true);

  await page.keyboard.type('ls /usr/bin/doom-clang /usr/bin/stl4 /usr/bin/sdldemo ' +
    '/usr/share/menu/Games/doom-clang && echo CLANG""-SET-OK\r');
  await waitOut('CLANG-SET-OK', 20000);
  check('doom-clang + stl4 + sdldemo + Games menu entry are baked into /usr', true);

  // ---- doom-clang launch state, recorded loudly (see header) ----
  await page.keyboard.type('doom-clang > /root/dc.log 2>&1; ' +
    'echo DC""-EXIT=$?; cat /root/dc.log\r');
  await waitOut('DC-EXIT=', 60000);
  {
    const out = await page.evaluate(() => window.__osOut || '');
    const m = /DC-EXIT=(\d+)/.exec(out);
    console.log(`  info doom-clang exit status: ${m ? m[1] : '?'} ` +
      '(139 = the known published-artifact SEGV — see header; 0/window = promote this leg)');
  }

  // ---- a clang-built SDL app LAUNCHES and renders (the 0152 claim) ----
  const region = (x0, y0, x1, y1) => page.evaluate(([a, b, c, d]) => {
    const cv = document.getElementById('screen');
    const t = document.createElement('canvas');
    t.width = cv.width; t.height = cv.height;
    const ctx = t.getContext('2d');
    ctx.drawImage(cv, 0, 0);
    const img = ctx.getImageData(a, b, c - a, d - b).data;
    let nonTeal = 0, n = 0;
    const colors = new Set();
    for (let i = 0; i < img.length; i += 16) {
      const col = (img[i] << 16) | (img[i + 1] << 8) | img[i + 2];
      colors.add(col); n++;
      if (col !== 0x008080) nonTeal++;
    }
    return { colors: colors.size, nonTeal, n };
  }, [x0, y0, x1, y1]);

  await page.keyboard.type('sdldemo &\r');
  await setVt(2);
  await waitScreen();
  // The WM places the first window at (12,36); sdldemo's client is 640x480
  // (bouncing boxes over a dark background — few colors, full coverage).
  // Poll, no fixed settle.
  const SDL_REGION = [16, 40, 648, 468];
  let stats = null, ok = false;
  for (const t0 = Date.now(); Date.now() - t0 < 120000;) {
    stats = await region(...SDL_REGION);
    if (stats.colors >= 4 && stats.nonTeal / stats.n > 0.5) { ok = true; break; }
    await new Promise((r) => setTimeout(r, 500));
  }
  check('sdldemo (clang-built SDL app) window renders (colors + coverage)', ok, stats);
} catch (e) {
  s.fail(e);
} finally {
  await s.close();
}
s.finish('os clang overlay (browser)');
