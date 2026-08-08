// os-warmpool.mjs — ticket #351: the warm worker pool (jku's refill-on-take
// design). Workers stay SINGLE-USE; the pool only pre-pays realm-create +
// importScripts. This file asserts the pool's OBSERVABLE contract via the
// __osPoolStats probe + the #350 spawn trace:
//   - depth invariant: free == POOL_DEPTH after boot and after every spawn
//     (take one -> replacement created in the same step), including a
//     4-stage pipeline burst;
//   - the first typed command after a cold boot takes a WARM worker whose
//     importScripts finished BEFORE the spawn entered (t1 < k0);
//   - idle teardown: no spawns for poolidle ms -> the free entries die;
//   - degradation: the post-teardown spawn is a COLD create (today's path,
//     never a failure) and re-arms the pool back to depth;
//   - accounting closes exactly (served == warmTakes + coldCreates; every
//     pool creation is taken, free, evicted, or torn down) — the page-side
//     face of the single-use tripwire in createWorker;
//   - the two-tab boot guard's LOSING tab creates zero pool workers.
// poolidle=15000: short enough to see teardown in-test, long enough that
// the gap between boot's last spawn (wm) and the first typed command can't
// tear the pool down early under load.
import { openOsSession, waitFor } from './lib/os-harness.mjs';

const IDLE_MS = 15000;
const s = await openOsSession({
  port: 3296,
  urlQuery: `spawntrace=1&poolidle=${IDLE_MS}`,
  readyLabel: `boots to ready (spawntrace=1, poolidle=${IDLE_MS})`,
});
const { page, context, setVt, check } = s;

const stats = () => page.evaluate(() => window.__osPoolStats());
// Node-side condition poll (the probe is a worker round-trip — not a page
// predicate waitForFunction could re-evaluate cheaply).
async function untilStats(pred, timeout) {
  const t0 = Date.now();
  let st = await stats();
  while (!pred(st) && Date.now() - t0 < timeout) {
    await page.waitForTimeout(250);   // timing subject: probe poll cadence (loop breaks on pred)
    st = await stats();
  }
  return st;
}
// The books must balance: every serving is a warm take or a cold create,
// and every pool creation is exactly one of taken/free/evicted/torn-down.
const accounting = (st) =>
  st.served === st.warmTakes + st.coldCreates &&
  st.created === st.warmTakes + st.free + st.evicted + st.tornDown;
const tracesLen = () => page.evaluate(() => (window.__spawnTraces || []).length);
const promptBack = () => waitFor(page, () => /~ # $/.test(window.__osOut),
                                 { timeout: 30000, polling: 'raf' });

try {
  await setVt(1);
  await page.waitForTimeout(300);

  // ---- boot pre-fill + depth invariant at rest ----
  let st = await stats();
  check('pool at depth after boot (free == 3)', st.free === 3 && st.depth === 3, st);
  check('boot spawns served through the same path (served >= 2: sh + wm)', st.served >= 2, st);
  check('accounting closes after boot', accounting(st), st);

  // ---- the first typed command takes a WARM worker ----
  let before = await tracesLen();
  await page.keyboard.type('mkdir\r');
  await waitFor(page, (n) => (window.__spawnTraces || [])
    .slice(n).some((t) => t.argv0 === 'mkdir' && t.firstOut), {
    arg: before, timeout: 30000, polling: 'raf' });
  await promptBack();
  const tr = await page.evaluate(
    (n) => window.__spawnTraces.slice(n).find((t) => t.argv0 === 'mkdir'), before);
  check('first command after boot is warm (imported before spawn entry)',
        tr.warm === true && tr.t1 < tr.k0,
        { warm: tr.warm, importDoneBeforeSpawnMs: tr.k0 - tr.t1 });
  st = await stats();
  check('refill-on-take restored depth after mkdir', st.free === 3, st);

  // ---- 4-stage pipeline burst: depth invariant under load ----
  before = await tracesLen();
  const servedBefore = st.served;
  await page.keyboard.type('ls | cat | grep x | wc -l\r');
  await waitFor(page, (n) => (window.__spawnTraces || []).length >= n,
                { arg: before + 4, timeout: 30000, polling: 'raf' });
  await promptBack();
  st = await stats();
  check('burst of 4 served (all spawns through the pool path)',
        st.served >= servedBefore + 4, st);
  check('depth invariant held through the burst (free == 3)', st.free === 3, st);
  check('accounting closes after the burst', accounting(st), st);

  // ---- idle teardown: the pool does not hold realms forever ----
  // No spawns from here on until the timer fires (the probe itself never
  // resets the idle clock — only spawns do).
  st = await untilStats((x) => x.free === 0 && x.tornDown >= 3, IDLE_MS + 30000);
  check('idle teardown emptied the pool (free == 0, tornDown >= 3)',
        st.free === 0 && st.tornDown >= 3, st);
  check('accounting closes after teardown', accounting(st), st);

  // ---- degradation: post-teardown spawn is COLD, works, and re-arms ----
  const coldBefore = st.coldCreates;
  before = await tracesLen();
  await page.evaluate(() => { window.__osOut = ''; });
  await page.keyboard.type('mkdir\r');
  await waitFor(page, () => window.__osOut.includes('invalid usage'),
                { timeout: 30000, polling: 'raf' });
  await promptBack();
  const tr2 = await page.evaluate(
    (n) => window.__spawnTraces.slice(n).find((t) => t.argv0 === 'mkdir'), before);
  check('post-teardown spawn degraded to the synchronous path (cold, not a failure)',
        tr2 && tr2.warm === false, tr2);
  st = await untilStats((x) => x.free === 3, 15000);
  check('cold spawn re-armed the pool back to depth', st.free === 3, st);
  check('cold create counted (coldCreates grew)', st.coldCreates > coldBefore, st);
  check('accounting closes at end', accounting(st), st);

  // ---- two-tab boot guard: the LOSING tab creates no pool workers ----
  const page2 = await context.newPage();
  await page2.goto(s.url);
  await page2.waitForFunction(() => window.__osState === 'locked',
    { timeout: 30000, polling: 'raf' });
  const st2 = await page2.evaluate(() => window.__osPoolStats());
  check('locked tab created zero pool workers',
        st2.created === 0 && st2.free === 0 && st2.served === 0, st2);
  await page2.close();
} catch (e) {
  s.fail(e);
}
await s.close();
s.finish('os-warmpool');
