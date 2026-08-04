#!/usr/bin/env node
// #110 (todos-0304): harness-kill honesty for test_os_boot.js — a boot/bake
// spawn KILLED by the harness budget or by an external signal must say so
// unmistakably, instead of surfacing as a product failure.
//
// The two kill flavours are distinguishable in spawnSync's result (verified
// empirically on this Node line — see logs/2026-08-05/ticket-110-kill-honesty.md):
//   - spawnSync's OWN timer sets status:null + signal:SIGTERM AND
//     error.code 'ETIMEDOUT'. Pre-fix, test_os_boot.js's `throw r.error`
//     crashed the file with an unattributed stack (no leg, no budget, no wall
//     time), and the mkimage spawn (which never checked r.error) misprinted a
//     product-shaped FAIL.
//   - an EXTERNAL kill (memory-pressure SIGKILL, a stray/group SIGTERM — the
//     contention scenario) sets status:null + signal with NO error. That is
//     the only path that can print the historical bare
//     "FAIL post-bypass boot exits clean  null" — which reads exactly like an
//     unclean product exit and names no signal.
//
// Leg 1 forces the budget path through the CC_OS_BOOT_TIMEOUT_MS seam (a
// 1500ms budget against the full-bake first session) and requires the
// TIMED OUT banner. Leg 2 SIGKILLs the spawned boot child from OUTSIDE and
// requires the external-signal banner. Both require exit 1 — a killed boot
// stays red, because a hung product and a contended machine are
// indistinguishable at the kill; the MESSAGE, not the colour, is what this
// file guards — and both require the ABSENCE of the two pre-fix shapes.
//
// The target is spawned DETACHED (its own process group) and every cap here
// group-kills with SIGKILL, for two probed-live reasons: (1) the target
// registers harness-temp's cleanup trap (process.once('SIGTERM')), and a
// trapped signal delivered while the target is blocked in its OWN spawnSync
// is deferred to an event-loop turn a fully synchronous file never takes —
// with spawnSync's default SIGTERM killSignal the target outlived a 1s
// timeout to its inner spawn's full length and exited 0, the caller still
// handed error:ETIMEDOUT; (2) a kill that reaches only the target pid
// orphans its live os/boot.js child, which then HOLDS THE HEAVY LOCK through
// its whole bake and poisons the next leg's boot into a spurious refusal.
'use strict';
const path = require('path');
const cp = require('child_process');

const TARGET = path.join(__dirname, 'test_os_boot.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

// The pre-fix bare-null shape: `  FAIL <leg>  null ...` — check()'s extra in
// test_os_boot.js begins with String(r.status), which is "null" for any
// signal-killed child.
const BARE_NULL = /^ {2}FAIL .* {2}null/m;

// Heavy-lock refusals inside the target are INCONCLUSIVE, not red — propagate
// them as our own exit 3, the driveBoot convention (todos/0342). Under the
// kernel suite this never fires (CC_HEAVY_LOCK_PID joins boots re-entrantly);
// it protects a standalone hand-run racing a live heavy suite.
function bailOnLockRefusal(out, err) {
  if ((out + err).includes('[heavy-lock]')) {
    process.stderr.write('[heavy-lock] target boot refused the lock — inconclusive, propagating exit 3\n');
    process.stderr.write(err.slice(-500) + '\n');
    process.exit(3);
  }
}

// Spawn the target detached with collected stdio. Resolves on 'close' (exit
// AND both pipes drained) with {code, sig, out, err}; `child` is exposed so a
// leg can find and signal the target's os/boot.js child mid-run.
function spawnTarget(env) {
  const child = cp.spawn('node', [TARGET], {
    detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: Object.assign({}, process.env, env || {}),
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  const buf = { out: '', err: '' };
  child.stdout.on('data', (d) => { buf.out += d; });
  child.stderr.on('data', (d) => { buf.err += d; });
  const done = new Promise((resolve) => {
    child.on('close', (code, sig) => resolve({ code, sig, out: buf.out, err: buf.err }));
  });
  return { child, done, buf };
}
function killGroup(child) {
  try { process.kill(-child.pid, 'SIGKILL'); } catch {}
}
function raceCap(t, capMs) {
  // Flag-then-kill, no Promise.race: the group kill makes 'close' fire, and
  // the one done-chain reads the flag — a race between a naked t.done and a
  // capped-wrapping branch would always lose to the naked one.
  const timer = setTimeout(() => {
    t.capped = true;
    killGroup(t.child);   // sweep the boot child too — see the header
  }, capMs);
  return t.done.then((r) => {
    clearTimeout(timer);
    return Object.assign({ capped: !!t.capped }, r);
  });
}

// ---- leg 1: the budget kill must print the TIMED OUT banner ----
async function leg1() {
  const t = spawnTarget({ CC_OS_BOOT_TIMEOUT_MS: '1500' });
  const r = await raceCap(t, 120000);
  if (r.capped) {
    // The target ignored the 1500ms budget and ran into this control's own
    // 120s cap — the seam does not exist (the pre-fix tree's red).
    check('budget seam exists (CC_OS_BOOT_TIMEOUT_MS honoured)', false,
      'test_os_boot.js ignored the 1500ms budget and ran to the control\'s own 120s cap');
    return;
  }
  bailOnLockRefusal(r.out, r.err);
  check('budget kill exits 1 (red, not a crash)', r.code === 1,
    'code=' + r.code + ' signal=' + r.sig);
  check('budget kill prints the TIMED OUT banner',
    r.out.includes('TIMED OUT: killed by the harness at its 1500ms budget'),
    JSON.stringify(r.out.split('\n').filter((l) => l.includes('FAIL'))));
  check('the banner names the override seam',
    r.out.includes('CC_OS_BOOT_TIMEOUT_MS'),
    r.out.slice(-400));
  check('no unattributed ETIMEDOUT crash',
    !(r.out + r.err).includes('spawnSync node ETIMEDOUT'), r.err.slice(-300));
  check('no bare-null FAIL line', !BARE_NULL.test(r.out),
    JSON.stringify((r.out.match(BARE_NULL) || [])[0]));
}

// ---- leg 2: an external SIGKILL must print the external-signal banner ----
// Spawn the target at its DEFAULT budget, wait for its os/boot.js child to
// appear (the first session's bake starts immediately), and SIGKILL that
// child from out-of-band — the memory-pressure/jetsam shape.
function waitBootChild(pid, deadlineMs) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function poll() {
      const p = cp.spawnSync('pgrep', ['-P', String(pid), '-f', 'os/boot.js'],
        { encoding: 'utf8' });
      const kid = parseInt(String(p.stdout || '').trim().split('\n')[0], 10);
      if (kid > 0) return resolve(kid);
      if (Date.now() - t0 > deadlineMs) {
        return reject(new Error('no os/boot.js child appeared under pid ' + pid));
      }
      setTimeout(poll, 200);
    })();
  });
}

async function leg2() {
  const t = spawnTarget();
  let boot;
  try { boot = await waitBootChild(t.child.pid, 90000); }
  catch (e) {
    killGroup(t.child);
    bailOnLockRefusal(t.buf.out, t.buf.err);
    check('a boot child appears (to be killed externally)', false, e.message);
    return;
  }
  try { process.kill(boot, 'SIGKILL'); }
  catch (e) { check('external SIGKILL delivered', false, String(e)); }

  const r = await raceCap(t, 90000);
  if (r.capped) {
    check('an externally-killed boot aborts the file promptly', false,
      'test_os_boot.js was still running 90s after its boot child was ' +
      'SIGKILLed (pre-fix: a bare-null FAIL, then the remaining legs cascade)');
    return;
  }
  bailOnLockRefusal(r.out, r.err);
  check('external kill exits 1 (red, not a crash)', r.code === 1,
    'code=' + r.code + ' sig=' + r.sig);
  check('external kill prints the external-signal banner',
    r.out.includes('killed by SIGKILL from outside the harness'),
    JSON.stringify(r.out.split('\n').filter((l) => l.includes('FAIL'))));
  check('external-kill leg: no bare-null FAIL line', !BARE_NULL.test(r.out),
    JSON.stringify((r.out.match(BARE_NULL) || [])[0]));
}

leg1().then(leg2).then(() => {
  console.log(failures === 0
    ? '\nos boot kill honesty: PASS'
    : `\nos boot kill honesty: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}, (e) => {
  console.error(e);
  process.exit(1);
});
