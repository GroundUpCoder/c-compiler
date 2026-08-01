// os-spawntrace.mjs — ticket #350: positive control for the default-off
// spawn trace (?spawntrace=1). The (HP) rule: a default-off change whose
// acceptance is "nothing changed" needs a control in the SAME estate
// proving the ON path actually emits — otherwise a broken trace reads as
// green forever. The OFF path needs no twin here: every other sweep file
// boots without the param and exercises exactly that path.
//
// Asserts: a traced no-args `mkdir` produces ONE merged __spawnTraces
// record with sane phase ordering (kernel stamps -> worker first line ->
// importScripts done -> boot -> instantiate -> first output), a cached
// Module (todos/0037 still active), and positive per-phase durations.
import { openOsSession, waitFor } from './lib/os-harness.mjs';

const s = await openOsSession({
  port: 3298,
  urlQuery: 'spawntrace=1',
  readyLabel: 'boots to ready (spawntrace=1)',
});
const { page, setVt, check } = s;
try {
  await setVt(1);
  await page.waitForTimeout(300);
  const before = await page.evaluate(() => (window.__spawnTraces || []).length);
  await page.keyboard.type('mkdir\r');
  // The record lands at instantiate; the firstOut fragment merges when the
  // usage error prints — wait for a COMPLETE mkdir record, not just any.
  await waitFor(page, (n) => (window.__spawnTraces || [])
    .slice(n).some((t) => t.argv0 === 'mkdir' && t.firstOut), {
    arg: before, timeout: 30000, polling: 100 });
  const tr = await page.evaluate(
    (n) => window.__spawnTraces.slice(n).find((t) => t.argv0 === 'mkdir'), before);

  check('trace record emitted for mkdir', !!tr);
  check('module cache hit (hadModule)', tr.hadModule === true);
  // Phase ordering: k0 <= k1 <= k2 (kernel thread), k0 < t0 (worker first
  // line), t0 < t1 (importScripts span), t1 <= tBoot, instStart <= instEnd,
  // instEnd <= firstOut. Clock coarsening can tie neighbors — never invert.
  const ord = tr.k0 <= tr.k1 && tr.k1 <= tr.k2 && tr.k0 < tr.t0 &&
              tr.t0 < tr.t1 && tr.t1 <= tr.tBoot + 0.2 &&
              tr.instStart <= tr.instEnd && tr.instEnd <= tr.firstOut;
  check('phase stamps ordered', ord, tr);
  const total = tr.firstOut - tr.k0;
  check('spawn -> first output positive and sane (< 5s)', total > 0 && total < 5000, total);
  const b = tr.t1 - tr.t0;
  check('importScripts span positive', b > 0, b);
} catch (e) {
  s.fail(e);
}
await s.close();
s.finish('os-spawntrace');
