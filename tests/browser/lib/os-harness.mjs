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
// separate `playwright` install. Their unit coverage is
// tests/browser/os-harness-unit.mjs — a real sweep member since #431 (it sat
// in this directory as `test-harness.js`, enrolled in no suite, and rotted).
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
// The baked Start-menu tree model (menuGroups/menuLeaves) is re-exported
// from the kernel drive.js via CJS interop rather than twinned like
// deskEntries below: a hardcoded/duplicated menu list is exactly the drift
// that let 0272's mgp-plus entry shift winbox's flyout row unnoticed.
import driveCjs from '../../kernel/lib/drive.js';
export const menuGroups = driveCjs.menuGroups;
export const menuLeaves = driveCjs.menuLeaves;
import { joinHeavyLock } from '../../lib/heavy-lock.js';
import { checkPlaywrightPin } from './playwright-pin.cjs';
export { checkPlaywrightPin };

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
//
// `--strict-port` is NOT optional here. Every os-*.mjs pins a fixed port and
// then polls exactly that port; a bare serve.js walks to port+1 on EADDRINUSE,
// so a leftover listener from a killed run silently keeps the port and the test
// talks to the STALE server — reds that read as product regressions. With the
// flag a squatted port fails immediately, naming the holder (see serve.js
// tryListen). Sweep-member ports are UNIQUE since #546 (os-harness-unit.mjs
// enforces it), but the flag still carries a bounded same-port retry: --repeat
// and back-to-back re-runs hit the SAME file's port while the previous server
// is still releasing its socket (the teardown race).
//
// #546, the other half: a squatter that serve.js's refusal names is only loud
// in serve.js's OWN stderr, which most members leave unread — while the stale
// server answers waitForServer's poll with a 200 and the file then certifies
// the WRONG TREE (the L77 fake-green class). So startServer records the child
// it spawned per port, and waitForServer holds any 200 on such a port to the
// child's IDENTITY (the /__serve-id pid handshake): a mismatched 200 is NOT
// success — it keeps polling through the teardown race and, on exhaustion or
// on the child dying, throws naming the squatter / the child's stderr.
//
// `serveArgs` appends extra serve.js flags — the seam os-minimal.mjs uses to
// pass `--minimal` (the DEPLOY image shape: a plain bake + the /packages repo,
// instead of serve.js's dev-convenience fat blob).
// Heavy-test host lock (todos/0342): an os.html boot in a Chromium is the
// browser-shape RAM spend the lock bounds, and this harness is the funnel
// every os-*.mjs (plus tools/os-drive.mjs and friends) reaches it through.
// Join ONCE, at the first of startServer/launchBrowser — before any serve.js
// child or playwright import exists. Under the sweep runner the marker
// (CC_HEAVY_LOCK_PID, alive AND matching the recorded holder) joins
// re-entrantly; a hand-run single file under a foreign holder exits 3 naming
// it. The uncoverable path — a human browser tab against a dev serve.js — is
// recorded as an exclusion in todos/done/0342.
let heavyLockLatched = false;
function latchHeavyLock() {
  if (heavyLockLatched) return;
  heavyLockLatched = true;
  const file = process.argv[1] ? path.basename(process.argv[1]) : 'os-harness';
  joinHeavyLock({ name: `browser os test (${file})` });
}

// The servers THIS process spawned, keyed by port (#546): waitForServer holds
// a 200 on one of these ports to the spawned child's identity. A later spawn
// on the same port (a file reopening its session) replaces the record.
const spawnedServers = new Map();

export function startServer(port, { root = ROOT, onLog, serveArgs = [] } = {}) {
  latchHeavyLock();
  const child = spawn('node',
    [path.join(ROOT, 'serve.js'), root, String(port), '--strict-port', ...serveArgs],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  // stderr is always tapped (#546): the strict-port refusal names the squatter
  // THERE, and waitForServer's failure path replays the tail instead of losing
  // it to an unread pipe. stdout stays unread unless the caller asks.
  const rec = { child, exit: null, errTail: '' };
  child.stderr.on('data', (d) => {
    rec.errTail = (rec.errTail + d).slice(-2000);
    if (onLog) onLog(d);
  });
  if (onLog) child.stdout.on('data', (d) => onLog(d));
  child.on('exit', (code, signal) => { rec.exit = { code, signal }; });
  spawnedServers.set(Number(port), rec);
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
  // Identity handshake (#546): when THIS process spawned the server for the
  // polled port, a 200 only counts if /__serve-id answers with that child's
  // pid. A stale serve.js squatting the port answers 200s indistinguishably
  // at the HTTP level — pre-#546 that certified the WRONG TREE silently.
  let owned = null;
  try { owned = spawnedServers.get(Number(new URL(url).port || 0)) || null; } catch {}
  let squatter = null;
  for (let i = 0; i < tries; i++) {
    if (owned && owned.exit) break;   // our server died — polling is pointless
    try {
      if ((await fetchFn(url)).ok) {
        if (!owned) return true;      // not ours (remote / injected) — no identity to hold
        try {
          const id = await (await fetchFn(new URL('/__serve-id', url).toString())).json();
          if (id && id.pid === owned.child.pid) return true;
          squatter = id && id.pid !== undefined ? `pid ${id.pid}` : 'unidentifiable server';
        } catch { squatter = 'a server with no /__serve-id (pre-#546 tree?)'; }
        // A mismatched 200 is NOT success: during the strict-port teardown
        // race the dying predecessor answers while our child retries the
        // bind. Keep polling; loud failure only at exhaustion.
      }
    } catch {}
    await new Promise((r) => setTimeout(r, interval));
  }
  if (soft) return false;
  if (owned && owned.exit) {
    throw new Error(`waitForServer: the serve.js this test spawned for ${url} EXITED ` +
      `(${JSON.stringify(owned.exit)}) before serving — its stderr said:\n` +
      (owned.errTail || '  (nothing)'));
  }
  if (squatter !== null) {
    throw new Error(`waitForServer: ${url} answered, but NOT from the serve.js this test ` +
      `spawned (pid ${owned.child.pid}) — the 200s came from ${squatter}. A stale server is ` +
      `squatting the port; kill stray serve.js procs (tests/lib/harness-leaks.js reaps orphans).`);
  }
  throw new Error(`waitForServer: ${url} never answered after ${tries}×${interval}ms ` +
    `— a stale serve.js may be squatting the port (kill stray serve.js/'node -e' procs), ` +
    `or an image rebake outran the wait (raise tries, or prebake with node tools/mkimage.js).`);
}

// ---- package repo rebuild (#665) ----------------------------------------
// The members that rebuild dist/packages (os-git-cli, os-git-net, os-gucman,
// os-minimal, os-rust) must merge the SIBLING definition sources, or a COLD
// tree writes an index missing the sibling-defined packages (the #615 fonts)
// and serve.js's #614 guard then refuses to start for EVERY later member —
// 38 waitForServer deaths that read as a product regression. Resolution is
// the ONE existing discovery (os-common resolveSiblingRepo: GUCOS_PACKAGES
// override, linked-worktree main-clone sibling, naive sibling); an absent
// sibling contributes nothing and the serve guard stands down to match.

// -> { root, via, names } | null (no sibling checkout found — a normal state)
export function resolveSiblingDefs(root = ROOT) {
  const requireCjs = createRequire(import.meta.url);
  const COMMON = requireCjs(path.join(root, 'os', 'os-common.js'));
  const sibling = COMMON.resolveSiblingRepo(fs, path, root, 'gucos-packages',
    { env: process.env.GUCOS_PACKAGES });
  if (!sibling) return null;
  // Only the env override can name a nonexistent path (discovery candidates
  // are existence-checked in the resolver) — and an explicit override that is
  // wrong must fail LOUD, never quietly demote to 'absent' (the cmdalt
  // no-silent-fallback rule; same behavior as serve.js/sibling-tests.js).
  if (!fs.existsSync(sibling.root)) {
    console.error(`GUCOS_PACKAGES=${process.env.GUCOS_PACKAGES} does not exist — ` +
      `point it at the gucos-packages checkout, or unset it to use discovery`);
    process.exit(2);
  }
  return { ...sibling, names: COMMON.listPackages(fs, path, sibling.root, {}) };
}

// The coverage check serve.js's #614 guard applies, as a reusable probe:
// -> { idxPath, missing } — missing is [] when covered, when there is no
// sibling (or it defines nothing), or when no index exists yet (a bare cold
// tree serves without one; only a PRESENT-but-incomplete index refuses).
export function siblingIndexGap(root = ROOT, sibling = resolveSiblingDefs(root)) {
  const idxPath = path.join(root, 'dist', 'packages', 'index.json');
  if (!sibling || !sibling.names.length || !fs.existsSync(idxPath)) {
    return { idxPath, missing: [] };
  }
  let idxNames = [];
  try { idxNames = Object.keys(JSON.parse(fs.readFileSync(idxPath, 'utf-8')).packages || {}); }
  catch (e) { /* unreadable index: every sibling name reports missing */ }
  return { idxPath, missing: sibling.names.filter((n) => !idxNames.includes(n)) };
}

// Build dist/packages the way every rebuilding member must: mkpkg over the
// MERGED definition sources, then verify the written index actually covers
// the sibling set — so a regression of this seam fails HERE, in the one test
// that owns the rebuild, with the cause named, instead of poisoning shared
// state for every member that follows (#665 acceptance). `args` are extra
// mkpkg arguments (os-rust's producer flags + package name); a NAMED build
// gets the sibling names appended, because a cold tree has no prior index to
// carry them from (#580's upsert only preserves entries that already exist).
export function buildPackageRepo({ root = ROOT, args = [] } = {}) {
  const sibling = resolveSiblingDefs(root);
  const named = args.some((a) => !a.startsWith('--'));
  const r = spawnSync(process.execPath, [
    path.join(root, 'tools', 'mkpkg.js'), '--no-baseline', '--quiet',
    ...args,
    ...(named && sibling ? sibling.names : []),
    ...(sibling ? [`--defs=${sibling.root}`] : []),
  ], { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`buildPackageRepo: mkpkg exited ${r.status} — cannot serve a package repo`);
    process.exit(2);
  }
  const { idxPath, missing } = siblingIndexGap(root, sibling);
  if (missing.length) {
    console.error(`buildPackageRepo: rebuilt ${path.relative(root, idxPath)} is still ` +
      `missing sibling package(s): ${missing.join(', ')}`);
    console.error(`  sibling: ${sibling.root} (via ${sibling.via}) — serve.js's #614 guard ` +
      `would refuse this index for every later member`);
    console.error(`  removing the bad index so THIS test is the one loud failure (#665)`);
    try { fs.rmSync(idxPath); } catch (e) {}
    process.exit(2);
  }
  return sibling;
}

// The one WebGPU-flagged Chromium the whole sweep launches. Playwright is
// pulled in here, lazily, so the module loads without it. `opts` merges into
// chromium.launch (tools/os-drive.mjs passes { headless: false }).
//
// Before launching, assert the resolved playwright IS the pinned one (todos/
// 0171 loud-symptom rule). The check — and its history, and the gate-start
// pre-flight that now runs the same logic at second zero (#559) — lives in
// ./playwright-pin.cjs; the call here is defense in depth for a hand-run
// single os-*.mjs, which goes through neither tests/run.js nor os-sweep.mjs.
export async function launchBrowser(args = ['--enable-unsafe-webgpu', '--enable-features=Vulkan'], opts = {}) {
  latchHeavyLock();
  checkPlaywrightPin();
  const { chromium } = await import('playwright');
  return chromium.launch({ args, ...opts });
}

// Browser twin of tests/kernel/lib/drive.js's todos/0171 loud-symptom gate
// (ticket #97/0287): a `wmctl wait` that can't be satisfied prints
// `wmctl: wait X timed out after Nms` to stderr and exits 1 — but a shell
// script with no `set -e` just burns the full timeout and sails on, so the
// test then samples STALE state and a wait on an unreachable condition
// passes SLOWLY instead of failing. On the browser side that stderr lands
// in the tty mirror (window.__osOut); this is the pure scanner the page
// helpers (and any file-local scan, e.g. os-minimal.mjs's end-of-session
// leg) share. No browser test legitimately expects a timeout — absence
// checks use nowin/nolabel, which SUCCEED on absence.
export const WMCTL_TIMEOUT_RE = /wmctl: wait .* timed out after \d+ms/;
export const wmctlTimeoutHits = (hay) =>
  Array.from(new Set(String(hay).match(new RegExp(WMCTL_TIMEOUT_RE.source, 'g')) || []));

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

// Wait-polling policy (#576 D3): poll on animation frames. A satisfied
// condition resolves on the next frame instead of up to 200ms later, which
// across a sweep's hundreds of sequential waits is real wall time. The one
// caveat is Chromium's background-page throttling: rAF can stall in a page
// that is not frontmost (the os-boots.mjs stall note, 2026-07-06), so
// MULTI-PAGE tests pass osHelpers an explicit interval instead — a wait
// against a backgrounded page must never depend on its frames.
export const POLL = 'raf';

// Per-page pixel/tty/VT helpers, bound to a Playwright page. Byte-identical to
// the inline definitions the sweep files carry. `polling` overrides the wait
// policy for every helper this instance returns (see POLL above).
export function osHelpers(page, { polling = POLL } = {}) {
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
      await new Promise(r => setTimeout(r, 50));
    }
  };

  // (#97/0287) Scan the tty mirror for the drive.js-class wmctl-timeout
  // symptom and throw naming every hit + the tty tail before the first one
  // (0171: the diagnostic points at its cause). waitOut runs this after
  // every satisfied wait, so a timed-out `wmctl wait` earlier in the
  // session surfaces at the next sync point instead of poisoning later
  // assertions silently.
  const assertNoWmctlTimeout = async () => {
    const out = await page.evaluate(() => window.__osOut || '');
    const hits = wmctlTimeoutHits(out);
    if (!hits.length) return;
    const at = out.search(WMCTL_TIMEOUT_RE);
    const tail = out.slice(0, at).split('\n').slice(-12);
    throw new Error('wmctl wait timed out (a wait on an unreachable condition — ' +
      'root-cause it, do not lengthen the timeout):\n  ' + hits.join('\n  ') +
      '\n--- tty tail before the first timeout ---\n' + tail.join('\n'));
  };

  // Wait for the tty mirror (window.__osOut) to contain a needle. The
  // predicate ALSO returns on a wmctl-timeout line (#97/0287): a timed-out
  // in-OS wait means the needle's producer is not coming, so resolve now
  // and let the scan below turn it into a named hard failure rather than
  // an opaque waitForFunction timeout.
  const waitOut = async (needle, ms) => {
    await page.waitForFunction(
      (n) => window.__osOut && (window.__osOut.includes(n) ||
        /wmctl: wait .* timed out after \d+ms/.test(window.__osOut)),
      needle, { timeout: ms || 20000, polling });
    await assertNoWmctlTimeout();
  };

  // Wait until the desktop canvas layout matches the live __osScreen geometry
  // (0023) — the guard every pixel test runs before sampling on VT2.
  const waitScreen = ({ timeout = 30000 } = {}) => page.waitForFunction(() => {
    const r = document.getElementById('screen').getBoundingClientRect();
    return window.__osScreen && window.__osScreen.w > 800 &&
      Math.abs(r.width - window.__osScreen.w) < 2 &&
      Math.abs(r.height - window.__osScreen.h) < 2;
  }, { timeout, polling });

  return { setVt, sample, near, waitPixel, waitOut, waitScreen, assertNoWmctlTimeout };
}

// The generic "poll a page predicate" util 0083 asked for — a thin, named
// wrapper over page.waitForFunction so ad-hoc `for(;;){…await timeout}` polls
// have one home. `arg` is forwarded to the predicate (playwright semantics).
export function waitFor(page, pred, { timeout = 30000, polling = POLL, arg } = {}) {
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
    // extra serve.js flags (see startServer) — e.g. ['--minimal']
    serveArgs,
    // Host keyboard-scheme auto-detect (META-ARROW-KEYBIND.md decision 4).
    // Default 'off' PINS the seed off so the sweep is byte-identical to the
    // baked windows scheme regardless of the CI host (a Mac would otherwise
    // auto-select macos and break the GUI+arrow snap legs). A test that wants
    // the auto-detect exercises it with hostKeys: 'mac'.
    hostKeys = 'off',
    // Extra os.html query params, e.g. 'spawntrace=1' (ticket #350).
    urlQuery = '',
  } = opts;
  const base = osUrl(port, hostKeys);
  const url = urlQuery ? base + (base.includes('?') ? '&' : '?') + urlQuery : base;
  const server = startServer(port, { onLog: onServerLog, serveArgs });
  const browser = await launchBrowser(browserArgs, browserOpts);
  const { check, state } = makeCheck({ stringify });
  try {
    await waitForServer(url, { tries: serverTries, interval: serverInterval });
    const context = await browser.newContext(viewport ? { viewport } : {});
    const page = await context.newPage();
    page.on('console', m => { if (m.type() === 'error') process.stderr.write('[page] ' + m.text() + '\n'); });
    await page.goto(url);
    await page.waitForFunction(() => window.__osState === 'ready', { timeout: readyTimeout, polling: POLL });
    check(readyLabel, true);
    if (promptNeedle) {
      await page.waitForFunction(
        (src) => new RegExp(src).test(window.__osOut), promptNeedle.source,
        { timeout: promptTimeout, polling: POLL });
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
// os/image.json's user section plus status-quo default Desktop packages (the
// todos/0166 rule) — FILES and DIRS,
// direct children only (the deck links inside Presentations/ are not
// icons), plus wm.c's always-recreated Recycle Bin. deskSort replicates
// wm.c entcmp (Recycle Bin last, dirs first, byte-order strcmp); deskCell
// maps a name to its column-major cell at the LIVE screen height — 0184
// pushed the seeded set past one column, so column-0 y math alone is
// no longer safe.
export function deskEntries(extras = []) {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'os/image.json'), 'utf8'));
  const u = manifest.user;
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
  for (const name of manifest.defaultPackages || []) {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'packages', name + '.json'), 'utf8'));
    if (pkg.desktop?.default === true) ents.push({ name, dir: false });
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
