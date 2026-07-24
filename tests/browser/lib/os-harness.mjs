// Shared harness for the browser OS acceptance sweep (todos/0146).
//
// Every `os-*.mjs` used to copy-paste the same setup: serve.js spawn, the
// `waitForServer` fetch-poll, the `--enable-unsafe-webgpu --enable-features=
// Vulkan` Chromium launch (todos/0055 — worker WebGPU is required to boot),
// the boot-to-ready + prompt waits, the `check`/`failures` scoreboard, and the
// per-page pixel/tty helpers (`setVt`, `sample`, `near`, `waitPixel`,
// `waitOut`, the `__osScreen` geometry wait). This is the ONE place that lives
// now — and the seam the future browser `waitFor` (0083) lands in, once.
//
// Playwright is imported LAZILY (inside launchBrowser) so this module — and
// its pure helpers (osUrl, near, makeCheck, startServer arg-building,
// waitForServer against any fetch) — load in plain Node without the operator's
// separate `playwright` install. See tests/browser/lib/test-harness.js.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
// The baked Start-menu tree model (menuGroups/menuLeaves) is re-exported
// from the kernel drive.js via CJS interop rather than twinned like
// deskEntries below: a hardcoded/duplicated menu list is exactly the drift
// that let 0272's mgp-plus entry shift winbox's flyout row unnoticed.
import driveCjs from '../../kernel/lib/drive.js';
export const menuGroups = driveCjs.menuGroups;
export const menuLeaves = driveCjs.menuLeaves;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '../../..');

// The os.html URL. `hostKeys` PINS the keyboard-scheme host auto-detect
// (META-ARROW-KEYBIND.md decision 4): default 'off' suppresses the seed so
// every browser test is byte-identical to the baked windows scheme regardless
// of the CI host — a Mac would otherwise auto-select macos and break the
// GUI+arrow snap legs (os-snap/os-wm). A test that wants the macos default
// passes hostKeys: 'mac'. Pass '' to omit the param entirely (raw os.html).
export const osUrl = (port, hostKeys = 'off') =>
  `http://localhost:${port}/os/os.html` +
  (hostKeys ? `?hostkeys=${encodeURIComponent(hostKeys)}` : '');

// serve.js over the repo root (COOP/COEP for SAB), exactly like a developer's
// `node serve.js .`. stdio is piped but left UNREAD by default — matching the
// os-*.mjs majority (serve is near-silent); pass onLog to tap it (os-boots
// prefixes `[serve]`).
export function startServer(port, { root = ROOT, onLog } = {}) {
  const child = spawn('node', [path.join(ROOT, 'serve.js'), root, String(port)],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  if (onLog) {
    child.stdout.on('data', (d) => onLog(d));
    child.stderr.on('data', (d) => onLog(d));
  }
  return child;
}

// Poll the URL until it answers 200. Returns true once it does. On exhausting
// the tries it THROWS a clear, actionable error by default (todos/0171 — the
// loud-symptom rule): a server that never came up used to be discarded here
// and surface downstream as a bare `page.goto: net::ERR_CONNECTION_REFUSED`,
// which reads like a product failure but is almost always a stale `serve.js`
// squatting this file's fixed port (or a rebake that outran the wait). Name
// the real cause at the source instead. Pass `{ soft: true }` for the boolean
// return (the unit test). `fetchFn` is injectable for unit tests.
export async function waitForServer(url, { tries = 50, interval = 100, fetchFn = fetch, soft = false } = {}) {
  for (let i = 0; i < tries; i++) {
    try { if ((await fetchFn(url)).ok) return true; } catch {}
    await new Promise((r) => setTimeout(r, interval));
  }
  if (soft) return false;
  throw new Error(`waitForServer: ${url} never answered after ${tries}×${interval}ms ` +
    `— a stale serve.js may be squatting the port (kill stray serve.js/'node -e' procs), ` +
    `or an image rebake outran the wait (raise tries, or prebake with node tools/mkimage.js).`);
}

// The one WebGPU-flagged Chromium the whole sweep launches. Playwright is
// pulled in here, lazily, so the module loads without it. `opts` merges into
// chromium.launch (tools/os-drive.mjs passes { headless: false }).
export async function launchBrowser(args = ['--enable-unsafe-webgpu', '--enable-features=Vulkan'], opts = {}) {
  const { chromium } = await import('playwright');
  return chromium.launch({ args, ...opts });
}

// The `check`/`failures` scoreboard. `stringify` controls the FAIL tail: the
// os-*.mjs majority JSON.stringifies `extra`; os-boots prints it raw.
export function makeCheck({ stringify = true } = {}) {
  const state = { failures: 0 };
  const check = (name, cond, extra) => {
    if (cond) { console.log('  ok   ' + name); return; }
    const tail = extra !== undefined ? '  ' + (stringify ? JSON.stringify(extra) : extra) : '';
    console.log('  FAIL ' + name + tail);
    state.failures++;
  };
  return { check, state };
}

// RGB channel-wise near-equality (default tolerance 8) — the sweep's pixel
// assertion primitive. Pure, so unit-testable.
export const near = (got, want, tol) => got && got.every((v, i) => Math.abs(v - want[i]) <= (tol || 8));

// Per-page pixel/tty/VT helpers, bound to a Playwright page. Byte-identical to
// the inline definitions the sweep files carry.
export function osHelpers(page) {
  const setVt = (n) => page.evaluate((v) => window.__osVtSwitch(v), n);

  // Sample one composited pixel off the (transferred) desktop canvas, sizing
  // the temp canvas from the LIVE layout rect (0023: the screen tracks the
  // viewport — never trust the stale width/height attributes) OR the last
  // logical size, whichever is larger: at sub-1× zoom (hires-display) the
  // backing store EXCEEDS the CSS rect, and logical sample coords past the
  // pane would otherwise fall off the temp canvas and read [0,0,0].
  const sample = (x, y) => page.evaluate(([sx, sy]) => {
    const c = document.getElementById('screen');
    const r = c.getBoundingClientRect();
    const s = window.__osScreen || { w: 0, h: 0 };
    const t = document.createElement('canvas');
    t.width = Math.max(Math.round(r.width), s.w);
    t.height = Math.max(Math.round(r.height), s.h);
    const ctx = t.getContext('2d');
    ctx.drawImage(c, 0, 0);
    const d = ctx.getImageData(sx, sy, 1, 1).data;
    return [d[0], d[1], d[2]];
  }, [x, y]);

  // Optional `what` names WHAT the pixel is (0171: the diagnostic points at
  // its cause) — "pixel (x,y) never became c (C's focused title); last g".
  const waitPixel = async (x, y, want, ms, what) => {
    const t0 = Date.now();
    for (;;) {
      const got = await sample(x, y);
      if (near(got, want)) return got;
      if (Date.now() - t0 > (ms || 30000))
        throw new Error(`pixel (${x},${y}) never became ${want}${what ? ` (${what})` : ''}; last ${got}`);
      await new Promise(r => setTimeout(r, 200));
    }
  };

  // Wait for the tty mirror (window.__osOut) to contain a needle.
  const waitOut = (needle, ms) => page.waitForFunction(
    (n) => window.__osOut && window.__osOut.includes(n), needle,
    { timeout: ms || 20000, polling: 200 });

  // Wait until the desktop canvas layout matches the live __osScreen geometry
  // (0023) — the guard every pixel test runs before sampling on VT2.
  const waitScreen = ({ timeout = 30000 } = {}) => page.waitForFunction(() => {
    const r = document.getElementById('screen').getBoundingClientRect();
    return window.__osScreen && window.__osScreen.w > 800 &&
      Math.abs(r.width - window.__osScreen.w) < 2 &&
      Math.abs(r.height - window.__osScreen.h) < 2;
  }, { timeout, polling: 200 });

  return { setVt, sample, near, waitPixel, waitOut, waitScreen };
}

// The generic "poll a page predicate" util 0083 asked for — a thin, named
// wrapper over page.waitForFunction so ad-hoc `for(;;){…await timeout}` polls
// have one home. `arg` is forwarded to the predicate (playwright semantics).
export function waitFor(page, pred, { timeout = 30000, polling = 200, arg } = {}) {
  return page.waitForFunction(pred, arg, { timeout, polling });
}

// One-call OS boot: spawn serve, launch Chromium, open a page, wait to `ready`
// (emitting the `readyLabel` check), then the shell prompt. Returns the live
// handles plus the scoreboard, the page helpers, and close/fail/finish
// lifecycle glue. Setup failures clean up server+browser and rethrow, so the
// caller only has to try/finally around the test body.
export async function openOsSession(opts = {}) {
  const {
    port,
    viewport = { width: 1100, height: 900 },
    readyTimeout = 180000,
    readyLabel = 'boots to ready',
    promptNeedle = /~ #/,
    promptTimeout = 30000,
    stringify = true,
    serverTries = 50, serverInterval = 100,
    browserArgs,
    browserOpts,
    onServerLog,
    // Host keyboard-scheme auto-detect (META-ARROW-KEYBIND.md decision 4).
    // Default 'off' PINS the seed off so the sweep is byte-identical to the
    // baked windows scheme regardless of the CI host (a Mac would otherwise
    // auto-select macos and break the GUI+arrow snap legs). A test that wants
    // the auto-detect exercises it with hostKeys: 'mac'.
    hostKeys = 'off',
  } = opts;
  const url = osUrl(port, hostKeys);
  const server = startServer(port, { onLog: onServerLog });
  const browser = await launchBrowser(browserArgs, browserOpts);
  const { check, state } = makeCheck({ stringify });
  try {
    await waitForServer(url, { tries: serverTries, interval: serverInterval });
    const context = await browser.newContext(viewport ? { viewport } : {});
    const page = await context.newPage();
    page.on('console', m => { if (m.type() === 'error') process.stderr.write('[page] ' + m.text() + '\n'); });
    await page.goto(url);
    await page.waitForFunction(() => window.__osState === 'ready', { timeout: readyTimeout, polling: 250 });
    check(readyLabel, true);
    if (promptNeedle) {
      await page.waitForFunction(
        (src) => new RegExp(src).test(window.__osOut), promptNeedle.source,
        { timeout: promptTimeout, polling: 200 });
    }
    const helpers = osHelpers(page);
    return {
      server, browser, context, page, url,
      check, state, helpers, ...helpers,
      fail: (e) => { console.error('FAIL: ' + (e && e.message)); state.failures++; },
      close: async () => { await browser.close(); server.kill(); },
      finish: (label) => {
        console.log(state.failures === 0 ? `\n${label}: PASS` : `\n${label}: ${state.failures} FAILED`);
        process.exit(state.failures === 0 ? 0 : 1);
      },
    };
  } catch (e) {
    try { await browser.close(); } catch {}
    server.kill();
    throw e;
  }
}

// ---- the seeded desktop grid model (todos/0184/0185) ----
// Twin of tests/kernel/lib/drive.js deskEntries/deskSort/deskCell — one
// behavior, two module systems. The seeded /root/Desktop set derives from
// os/image.json's user section (the todos/0166 rule) — FILES and DIRS,
// direct children only (the deck links inside Presentations/ are not
// icons), plus wm.c's always-recreated Recycle Bin. deskSort replicates
// wm.c entcmp (Recycle Bin last, dirs first, byte-order strcmp); deskCell
// maps a name to its column-major cell at the LIVE screen height — 0184
// pushed the seeded set past one column, so column-0 y math alone is
// no longer safe.
export function deskEntries(extras = []) {
  const u = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'os/image.json'), 'utf8')).user;
  const child = (p) => {
    if (!p.startsWith('/root/Desktop/')) return null;
    const n = p.slice('/root/Desktop/'.length);
    return n && !n.includes('/') ? n : null;
  };
  const ents = [];
  for (const p of Object.keys(u.files)) {
    const n = child(p);
    if (n) ents.push({ name: n, dir: false });
  }
  for (const p of u.dirs || []) {
    const n = child(p);
    if (n) ents.push({ name: n, dir: true });
  }
  ents.push({ name: 'Recycle Bin', dir: false });   // wm.c ensure_recycle
  return deskSort(ents.concat(
    extras.map((e) => typeof e === 'string' ? { name: e, dir: false } : e)));
}
export function deskSort(ents) {
  return ents.slice().sort((a, b) => {
    const ra = a.name === 'Recycle Bin' ? 1 : 0,
          rb = b.name === 'Recycle Bin' ? 1 : 0;
    if (ra !== rb) return ra - rb;
    const da = a.dir ? 1 : 0, db = b.dir ? 1 : 0;
    if (da !== db) return db - da;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  }).map((e) => e.name);
}
// wm.c geometry (font-20 retune): 16px margin, 116x96 cells, 36px taskbar;
// rows/col = (scrH - 68) / 96. x/y are the cell origin; cx/cy the icon-click
// center (58 = 16+42 -> now 16+58).
export function deskCell(list, name, scrH) {
  const rows = Math.max(1, Math.floor((scrH - 36 - 32) / 96));
  const i = list.indexOf(name);
  if (i < 0) throw new Error('deskCell: "' + name + '" not on the desktop');
  const col = Math.floor(i / rows), row = i % rows;
  return { index: i, col, row, rows,
           x: 16 + col * 116, y: 16 + row * 96,
           cx: 16 + col * 116 + 58, cy: 16 + row * 96 + 48 };
}
