// profile-spawn.mjs — ticket #350: in-browser per-phase profile of the
// per-spawn worker bootstrap. MANUAL tool (not an os-*.mjs sweep member —
// it measures, it does not gate). Boots os.html with ?spawntrace=1, runs
// no-args `mkdir` solo reps + `ls | grep x | wc -l` pipeline bursts on VT1,
// and prints per-phase stats from window.__spawnTraces, plus an in-browser
// cross-check of the "raw lazy-parse is ~5.5 ms" claim and a network log
// that says whether importScripts re-fetches host.js/kernel.js per spawn.
//
// Usage: node tests/browser/profile-spawn.mjs [--solo=N] [--bursts=N] [--nopool]
//   --nopool: boot with ?pooldepth=0 — the warm pool (#351) disabled, i.e.
//   the pre-#351 spawn path on the SAME tree (the before/after baseline).
import { openOsSession, waitFor } from './lib/os-harness.mjs';

const arg = (name, dflt) => {
  const a = process.argv.find((s) => s.startsWith(`--${name}=`));
  return a ? parseInt(a.split('=')[1], 10) : dflt;
};
const SOLO = arg('solo', 12);
const BURSTS = arg('bursts', 5);
const NOPOOL = process.argv.includes('--nopool');
const PORT = 3299;

const q = (xs, p) => {
  const s = xs.slice().sort((a, b) => a - b);
  if (!s.length) return NaN;
  const i = (s.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
};
const r1 = (x) => Math.round(x * 10) / 10;
const stats = (xs) => ({ n: xs.length, p50: r1(q(xs, 0.5)), p10: r1(q(xs, 0.1)), p90: r1(q(xs, 0.9)), min: r1(Math.min(...xs)), max: r1(Math.max(...xs)) });

// Per-trace phase decomposition. All stamps are timeOrigin+now() absolutes.
// Warm takes (#351): the realm was created at pool-fill time, so t0/t1
// PREDATE k0 — a_realm/b_import are off-critical-path there (reported NaN
// so the aggregates only average on-path spans); d_firstOut (spawn entry ->
// first output) stays the honest end-to-end number in both worlds.
function phases(t) {
  const warm = t.warm === true;
  return {
    argv0: t.argv0, pid: t.pid, hadModule: t.hadModule, warm,
    poolAge: warm && t.wBorn != null ? t.k0 - t.wBorn : NaN,  // pooled idle time
    ctor: t.k1 - t.k0,               // kernel thread: take / new Worker() sync cost
    postBoot: t.k2 - t.k1,           // kernel thread: boot postMessage (module clone)
    a_realm: warm ? NaN : t.t0 - t.k0,   // ctor call -> worker script first line
    b_import: warm ? NaN : t.t1 - t.t0,  // importScripts fetch+parse+execute (~1MB)
    bootWait: t.tBoot - Math.max(t.k2, t.t1),  // boot msg delivery after import
    setup: (t.instStart ?? t.tBoot) - t.tBoot, // RemoteFS + roFs mount + runModule preamble
    c_inst: t.instEnd != null ? t.instEnd - t.instStart : NaN,  // WASM instantiate
    toFirstOut: t.firstOut != null ? t.firstOut - (t.instEnd ?? t.tBoot) : NaN, // main() -> first fd1/2 write
    d_firstOut: t.firstOut != null ? t.firstOut - t.k0 : NaN,   // TOTAL: spawn -> first output
    // spawn -> last observed event (tExit only survives off-kernel paths)
    total: (t.tExit ?? t.firstOut ?? t.instEnd ?? t.tBoot) - t.k0,
  };
}

const main = async () => {
  const reqCounts = Object.create(null);
  const s = await openOsSession({
    port: PORT,
    urlQuery: 'spawntrace=1' + (NOPOOL ? '&pooldepth=0' : ''),
    readyLabel: `boots to ready (spawntrace=1${NOPOOL ? ', pool OFF' : ''})`,
    serverTries: 1200,   // first run in a fresh worktree re-bakes the image
  });
  const { page, setVt, check } = s;
  try {
    page.on('request', (r) => {
      const u = r.url().split('?')[0];
      const m = u.match(/\/(host\.js|kernel\.js|process-worker\.js)$/);
      if (m) reqCounts[m[1]] = (reqCounts[m[1]] || 0) + 1;
    });

    // Boot-time spawns (init/sh/wm/...) already accumulated — keep them as
    // the cold-spawn sample, slice per-step below.
    await setVt(1);
    await page.waitForTimeout(300);
    const tracesLen = () => page.evaluate(() => (window.__spawnTraces || []).length);
    const bootLen = await tracesLen();
    console.log(`  boot-time traces: ${bootLen}`);
    const reqAtStart = { ...reqCounts };

    // ---- solo no-args mkdir reps (the usage-error path: pure startup) ----
    const promptBack = () => waitFor(page, () => /~ # $/.test(window.__osOut),
                                     { timeout: 30000, polling: 50 });
    for (let i = 0; i < SOLO; i++) {
      const before = await tracesLen();
      await page.keyboard.type('mkdir\r');
      await waitFor(page, (n) => (window.__spawnTraces || []).length >= n,
                    { arg: before + 1, timeout: 30000, polling: 50 });
      await promptBack();
      await page.waitForTimeout(100);
    }
    const afterSolo = await tracesLen();
    check(`solo mkdir reps traced (${afterSolo - bootLen} >= ${SOLO})`, afterSolo - bootLen >= SOLO);

    // ---- pipeline bursts: 3 concurrent spawns racing one another ----
    for (let i = 0; i < BURSTS; i++) {
      const before = await tracesLen();
      await page.keyboard.type('ls | grep x | wc -l\r');
      await waitFor(page, (n) => (window.__spawnTraces || []).length >= n,
                    { arg: before + 3, timeout: 30000, polling: 50 });
      await promptBack();
      await page.waitForTimeout(100);
    }
    const afterBurst = await tracesLen();
    check(`burst reps traced (${afterBurst - afterSolo} >= ${3 * BURSTS})`, afterBurst - afterSolo >= 3 * BURSTS);

    // ---- perceived latency: Enter keydown -> usage-error bytes on screen ----
    // (covers tty input round-trip + hush parse/fork + spawn + output; the
    // setInterval(0) poll adds ~2-4 ms of quantization)
    const perceived = [];
    for (let i = 0; i < 6; i++) {
      const before = await tracesLen();
      await page.evaluate(() => {
        window.__perc = { enterAt: 0, outAt: 0, base: (window.__osOut || '').length };
        const h = (e) => {
          if (e.key === 'Enter') {
            window.__perc.enterAt = performance.timeOrigin + performance.now();
            window.removeEventListener('keydown', h, true);
          }
        };
        window.addEventListener('keydown', h, true);
        const iv = setInterval(() => {
          if (window.__perc.enterAt && !window.__perc.outAt &&
              window.__osOut.slice(window.__perc.base).includes('invalid usage')) {
            window.__perc.outAt = performance.timeOrigin + performance.now();
            clearInterval(iv);
          }
        }, 0);
      });
      await page.keyboard.type('mkdir\r');
      await waitFor(page, () => window.__perc && window.__perc.outAt > 0,
                    { timeout: 30000, polling: 50 });
      const perc = await page.evaluate(() => window.__perc);
      const trs = await page.evaluate(() => window.__spawnTraces || []);
      const tr = trs.slice(before).find((t) => t.argv0 === 'mkdir');
      perceived.push({
        enterToOut: r1(perc.outAt - perc.enterAt),
        enterToSpawn: tr ? r1(tr.k0 - perc.enterAt) : NaN,   // tty+hush pre-spawn
      });
      await promptBack();
      await page.waitForTimeout(100);
    }

    const traces = await page.evaluate(() => window.__spawnTraces || []);
    const boot = traces.slice(0, bootLen).map(phases);
    const solo = traces.slice(bootLen, afterSolo).map(phases);
    const burst = traces.slice(afterSolo, afterBurst).map(phases);

    // Burst inter-arrival + overlap: per burst of 3, spawn k0 gaps and
    // whether worker i+1's import span overlaps worker i's.
    const rawBurst = traces.slice(afterSolo, afterBurst);
    const burstGroups = [];
    for (let i = 0; i + 2 < rawBurst.length; i += 3) {
      const g = rawBurst.slice(i, i + 3).sort((x, y) => x.k0 - y.k0);
      burstGroups.push({
        argv0s: g.map((t) => t.argv0),
        k0gaps: [r1(g[1].k0 - g[0].k0), r1(g[2].k0 - g[1].k0)],
        // overlap of import spans [t0,t1] between consecutive members
        importOverlap: [
          r1(Math.min(g[0].t1, g[1].t1) - Math.max(g[0].t0, g[1].t0)),
          r1(Math.min(g[1].t1, g[2].t1) - Math.max(g[1].t0, g[2].t0)),
        ],
        span: r1(Math.max(...g.map((t) => t.tExit)) - g[0].k0),
      });
    }

    // ---- in-page cross-check: fetch + compile-only cost of the two files ----
    const parseCheck = await page.evaluate(async () => {
      const out = {};
      for (const f of ['/host.js', '/kernel.js']) {
        const tf0 = performance.now();
        const resp = await fetch(f);
        // Function-body parse can't take host.js's shebang (script grammar
        // allows it, function grammar doesn't) — strip, faithful to what
        // importScripts parses.
        const text = (await resp.text()).replace(/^#![^\n]*\n/, '\n');
        const tf1 = performance.now();
        // compile-only (lazy): Function body parse, no top-level execution
        const tc0 = performance.now();
        new Function(text);
        const tc1 = performance.now();
        // second compile (warm)
        const tc2 = performance.now();
        new Function(text);
        const tc3 = performance.now();
        out[f] = { bytes: text.length, fetchMs: tf1 - tf0, compileMs: tc1 - tc0, compile2Ms: tc3 - tc2 };
      }
      return out;
    });

    const agg = (list) => {
      const keys = ['ctor', 'postBoot', 'a_realm', 'b_import', 'bootWait', 'setup', 'c_inst', 'toFirstOut', 'd_firstOut', 'total', 'poolAge'];
      const o = {};
      for (const k of keys) o[k] = stats(list.map((p) => p[k]).filter((x) => !isNaN(x)));
      return o;
    };

    // Warm/cold split (#351): pool stats close the loop on how many spawns
    // actually took a pooled worker vs degraded to the synchronous create.
    const poolStats = await page.evaluate(() =>
      window.__osPoolStats ? window.__osPoolStats() : null);
    const warmSplit = (list) => ({
      warm: list.filter((p) => p.warm).length,
      cold: list.filter((p) => !p.warm).length,
    });

    const report = {
      env: { ua: await page.evaluate(() => navigator.userAgent), solo: SOLO, bursts: BURSTS, nopool: NOPOOL },
      requests: { atBoot: reqAtStart, total: { ...reqCounts } },
      poolStats,
      bootSpawns: boot,
      soloWarmSplit: warmSplit(solo),
      soloStats: agg(solo),
      soloRaw: solo,
      burstWarmSplit: warmSplit(burst),
      burstStats: agg(burst),
      burstGroups,
      perceived,
      parseCheck,
    };
    console.log('\n===SPAWN-PROFILE-JSON===');
    console.log(JSON.stringify(report, null, 1));
    console.log('===END===');
    await s.close();
    s.finish('profile-spawn');
  } catch (e) {
    s.fail(e);
    await s.close();
    s.finish('profile-spawn');
  }
};

main().catch((e) => { console.error(e); process.exit(1); });
