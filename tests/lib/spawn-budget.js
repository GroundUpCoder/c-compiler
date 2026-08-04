'use strict';
// spawn-budget.js (#513, generalizing #110's runBudgeted; #512's driveBoot is
// the intended third consumer) — budget-bearing child spawns whose KILLS
// self-describe as harness/environment events instead of rendering as
// product-shaped failures (a bare `status=null` in a check line) or crashing
// the file with an unattributed ETIMEDOUT stack. The kill stays RED on
// purpose: a hung child and a CPU-contended machine are indistinguishable at
// the kill — this fixes the MESSAGE, not the colour.
//
// The two kill flavours are distinguishable in the child_process result —
// probed live for #110 (sync) and #513 (async), this Node line:
//   sync (spawnSync):
//     budget kill    -> { status: null, signal, error.code: 'ETIMEDOUT' }
//     external kill  -> { status: null, signal, error: null }
//   async (execFile):
//     budget kill    -> rejection { killed: true,  signal, code: null }
//     external kill  -> rejection { killed: false, signal, code: null }
//     nonzero exit   -> rejection { killed: false, signal: null, code: N }
//   (`killed` is set only when the LIB delivered the kill; a maxBuffer abort
//   carries a string code, so requiring code == null excludes it.)
//
// killSignal is forced to SIGKILL, not the default SIGTERM: children that
// trap SIGTERM (tools/mkpkg.js's lock-release trap, harness-temp's and
// heavy-lock's cleanup traps in any spawned test file) defer the handler
// while their main thread is blocked in a synchronous stretch, and
// spawnSync/execFile send killSignal ONCE and never escalate — probed for
// #110, a SIGTERMed child outlived a 1s timeout by its inner spawn's full 6s
// and exited 0. SIGKILL is untrappable; the locks such children hold
// (mkpkg's .mkpkg-lock, the heavy lock) self-heal via their dead-pid steals.
//
// Contract (both entry points):
//   - returns { r, wall, budget, kill } — `kill` is null for any real child
//     exit (INCLUDING nonzero: a product failure must stay one), else
//     { kind: 'budget' | 'external', message } where `message` is the full
//     human explanation (banner + wall time + stderr tail) ready for a
//     check()'s extra. The CALLER owns what a kill does to the file (fail
//     one check and skip the leg, or abort the whole file — test_os_boot.js
//     aborts because a killed bake poisons every later leg).
//   - non-kill spawn errors (ENOENT, EACCES) still throw: those are real
//     harness crashes, not kills to attribute.
//   - opts.timeout is the site's default budget; the env named by
//     opts.budgetEnv (default CC_SPAWN_BUDGET_MS) overrides it — contention
//     relief on a deliberately busy box, and the red controls' lever
//     (test_spawn_budget_kill_honesty.js, test_os_boot_kill_honesty.js).
const cp = require('child_process');
const util = require('util');

function resolveBudget(defaultMs, envName) {
  const v = parseInt(process.env[envName] || '', 10);
  return v > 0 ? v : defaultMs;
}

function tailOf(stderr) {
  return ' stderr tail: ' + String(stderr || '').slice(-300);
}

function budgetMsg(budget, wall, signal, envName) {
  return 'TIMED OUT: killed by the harness at its ' + budget + 'ms budget (' +
    wall + 'ms wall, ' + (signal || 'SIGKILL') + '). NOT a product failure' +
    ' verdict: a hung child and a CPU-contended machine (a sibling heavy' +
    ' suite) are indistinguishable at the kill — re-run quiet, or raise ' +
    envName + '.';
}

function externalMsg(signal, wall, why) {
  return 'killed by ' + signal + ' from outside the harness after ' + wall +
    'ms (' + why + ', so not this file\'s budget). NOT a product exit —' +
    ' memory pressure or a stray kill on a busy machine.';
}

function spawnSyncBudgeted(file, args, opts) {
  opts = opts || {};
  const envName = opts.budgetEnv || 'CC_SPAWN_BUDGET_MS';
  if (!(opts.timeout > 0)) throw new Error('spawnSyncBudgeted: opts.timeout (the budget) is required');
  const budget = resolveBudget(opts.timeout, envName);
  const spawnOpts = Object.assign({}, opts, { timeout: budget, killSignal: 'SIGKILL' });
  delete spawnOpts.budgetEnv;
  const t0 = Date.now();
  const r = cp.spawnSync(file, args, spawnOpts);
  const wall = Date.now() - t0;
  let kill = null;
  if (r.error && r.error.code === 'ETIMEDOUT') {
    kill = { kind: 'budget', message: budgetMsg(budget, wall, r.signal, envName) + tailOf(r.stderr) };
  } else if (r.error) {
    throw r.error;
  } else if (r.status === null) {
    kill = { kind: 'external', message: externalMsg(r.signal, wall, 'no ETIMEDOUT') + tailOf(r.stderr) };
  }
  return { r, wall, budget, kill };
}

// The async twin, for sites whose fake server shares the event loop (the
// smoke.mjs rule — a sync spawn would deadlock the child against an
// unresponsive server). Same contract; opts.onSpawn(child) exposes the
// ChildProcess (the controls' out-of-band-kill hook, and any caller that
// needs the pid). A nonzero exit RETHROWS — that path's rejection carries
// the product stack/stdout and must keep doing so.
async function execFileBudgeted(file, args, opts) {
  opts = opts || {};
  const envName = opts.budgetEnv || 'CC_SPAWN_BUDGET_MS';
  if (!(opts.timeout > 0)) throw new Error('execFileBudgeted: opts.timeout (the budget) is required');
  const budget = resolveBudget(opts.timeout, envName);
  const execOpts = Object.assign({}, opts, { timeout: budget, killSignal: 'SIGKILL' });
  delete execOpts.budgetEnv;
  delete execOpts.onSpawn;
  const t0 = Date.now();
  const p = util.promisify(cp.execFile)(file, args, execOpts);
  if (opts.onSpawn) opts.onSpawn(p.child);
  try {
    const { stdout, stderr } = await p;
    return { r: { stdout, stderr, status: 0, signal: null }, wall: Date.now() - t0, budget, kill: null };
  } catch (e) {
    const wall = Date.now() - t0;
    if (e && e.signal && e.code == null) {
      const kill = e.killed
        ? { kind: 'budget', message: budgetMsg(budget, wall, e.signal, envName) + tailOf(e.stderr) }
        : { kind: 'external', message: externalMsg(e.signal, wall, 'the harness timer did not deliver the kill') + tailOf(e.stderr) };
      return {
        r: { stdout: e.stdout || '', stderr: e.stderr || '', status: null, signal: e.signal },
        wall, budget, kill,
      };
    }
    throw e;
  }
}

module.exports = { spawnSyncBudgeted, execFileBudgeted };
