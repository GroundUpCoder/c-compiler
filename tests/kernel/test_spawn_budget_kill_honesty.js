#!/usr/bin/env node
// #513 (sibling of #110/#512): kill honesty for the INLINE kernel-suite spawn
// sites — a child killed by the harness budget or by an external signal must
// self-describe as a harness/environment event, never render as a
// product-shaped failure (`status=null` / `(got null, signal ...)` in a check
// line) and never crash the file with an unattributed ETIMEDOUT stack.
//
// The shared implementation under test is tests/lib/spawn-budget.js
// (spawnSyncBudgeted + execFileBudgeted), adopted by test_cmdalt_e2e.js,
// test_cc_srclib.js, test_curl_e2e.js, test_gcode_native.js and (refactored
// onto the same core) test_os_boot.js — whose own end-to-end control is
// test_os_boot_kill_honesty.js and keeps guarding the CC_OS_BOOT_TIMEOUT_MS
// seam through the refactor.
//
// End-to-end target here: test_gcode_native.js — the ONE inline site whose
// budgeted spawn is the file's first action (read smoke.mjs, count checks,
// spawn), so a forced kill costs seconds, not a boot. Its pre-fix
// product-shaped kill line is literally `FAIL oracle exits 0 (got null,
// signal SIGKILL)` — the misdirection this file requires the absence of.
//
// Every kill here is REAL: leg 1 forces the harness-budget timer through the
// CC_SPAWN_BUDGET_MS seam; leg 2 delivers an out-of-band SIGKILL to the
// target's smoke.mjs child (the memory-pressure/jetsam shape); leg 3 drives
// the helper directly with a real timer kill, a real out-of-band kill of the
// async child, and real non-kill exits (the passthrough contract).
//
// The target is spawned DETACHED (own process group) and every cap here
// group-kills with SIGKILL — the #110 lessons: killSignal SIGTERM is
// absorbable by children that trap it (tools/mkpkg.js traps SIGTERM for its
// lock release — probed for #110's class), and a pid-only kill orphans the
// grandchild.
'use strict';
const path = require('path');
const cp = require('child_process');

const TARGET = path.join(__dirname, 'test_gcode_native.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

// The pre-fix product shape: the kill rendered as a product verdict —
// "oracle exits 0 (got null, signal ...)" names the CHECK, not the harness.
const PRODUCT_SHAPE = /oracle exits 0 \(got null/;

// smoke.mjs builds gcode.c with clang before anything else; without clang it
// dies in milliseconds and both e2e legs would misread that fast product
// failure as "the banner is missing". The suite's own test_gcode_native.js
// carries no clang gate (clang IS present wherever that file is green), but
// this control's verdict must not depend on losing that race.
try { cp.execFileSync('clang', ['--version'], { stdio: 'pipe' }); }
catch (e) {
  console.log('skip: clang not found — the smoke.mjs target cannot outlive a kill race');
  process.exit(0);
}

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
  // Flag-then-kill (the test_os_boot_kill_honesty.js pattern): the group kill
  // makes 'close' fire and the one done-chain reads the flag.
  const timer = setTimeout(() => {
    t.capped = true;
    killGroup(t.child);
  }, capMs);
  return t.done.then((r) => {
    clearTimeout(timer);
    return Object.assign({ capped: !!t.capped }, r);
  });
}

// ---- leg 1: the budget kill must print the TIMED OUT banner ----
// CC_SPAWN_BUDGET_MS=1000 lands mid-clang-build (multi-second), long before
// smoke.mjs could finish. Pre-fix the seam does not exist: the target ignores
// it, runs the full oracle into this control's own cap, and any kill it DID
// take would print the product shape.
async function leg1() {
  const t = spawnTarget({ CC_SPAWN_BUDGET_MS: '1000' });
  const r = await raceCap(t, 150000);
  if (r.capped) {
    check('budget seam exists (CC_SPAWN_BUDGET_MS honoured)', false,
      'test_gcode_native.js ignored the 1000ms budget and ran to the control\'s own 150s cap');
    return;
  }
  check('budget kill exits 1 (red, not a crash)', r.code === 1,
    'code=' + r.code + ' signal=' + r.sig);
  check('budget kill prints the TIMED OUT banner',
    r.out.includes('TIMED OUT: killed by the harness at its 1000ms budget'),
    JSON.stringify(r.out.split('\n').filter((l) => l.includes('FAIL'))));
  check('the banner names the override seam',
    r.out.includes('CC_SPAWN_BUDGET_MS'), r.out.slice(-400));
  check('no unattributed ETIMEDOUT crash',
    !(r.err.includes('ETIMEDOUT')), r.err.slice(-300));
  check('no product-shaped kill line', !PRODUCT_SHAPE.test(r.out),
    JSON.stringify((r.out.match(PRODUCT_SHAPE) || [])[0]));
}

// ---- leg 2: an external SIGKILL must print the external-signal banner ----
function waitSmokeChild(pid, deadlineMs) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function poll() {
      const p = cp.spawnSync('pgrep', ['-P', String(pid), '-f', 'smoke.mjs'],
        { encoding: 'utf8' });
      const kid = parseInt(String(p.stdout || '').trim().split('\n')[0], 10);
      if (kid > 0) return resolve(kid);
      if (Date.now() - t0 > deadlineMs) {
        return reject(new Error('no smoke.mjs child appeared under pid ' + pid));
      }
      setTimeout(poll, 200);
    })();
  });
}

async function leg2() {
  const t = spawnTarget();
  let kid;
  try { kid = await waitSmokeChild(t.child.pid, 60000); }
  catch (e) {
    killGroup(t.child);
    check('a smoke.mjs child appears (to be killed externally)', false, e.message);
    return;
  }
  try { process.kill(kid, 'SIGKILL'); }
  catch (e) { check('external SIGKILL delivered', false, String(e)); }

  const r = await raceCap(t, 90000);
  if (r.capped) {
    check('an externally-killed oracle reports promptly', false,
      'test_gcode_native.js was still running 90s after its smoke.mjs child was SIGKILLed');
    return;
  }
  check('external kill exits 1 (red, not a crash)', r.code === 1,
    'code=' + r.code + ' sig=' + r.sig);
  check('external kill prints the external-signal banner',
    r.out.includes('killed by SIGKILL from outside the harness'),
    JSON.stringify(r.out.split('\n').filter((l) => l.includes('FAIL'))));
  check('external-kill leg: no product-shaped kill line', !PRODUCT_SHAPE.test(r.out),
    JSON.stringify((r.out.match(PRODUCT_SHAPE) || [])[0]));
}

// ---- leg 3: the shared helper's classify/passthrough contract, driven with
// real kills. Required lazily so a pre-fix tree reports one FAIL here instead
// of crashing legs 1/2 at load time.
async function leg3() {
  let sb = null;
  try { sb = require('../lib/spawn-budget.js'); } catch {}
  check('tests/lib/spawn-budget.js exists (the shared #513 implementation)', !!sb);
  if (!sb) return;

  const a = sb.spawnSyncBudgeted('node', ['-e', 'setTimeout(()=>{},8000)'],
    { encoding: 'utf8', timeout: 400 });
  check('sync budget kill classified', !!(a.kill && a.kill.kind === 'budget'),
    JSON.stringify(a.kill));
  check('sync budget message names budget + wall',
    !!a.kill && a.kill.message.includes('400ms budget') && /\d+ms wall/.test(a.kill.message),
    a.kill && a.kill.message);

  const b = sb.spawnSyncBudgeted('node', ['-e', '0'], { encoding: 'utf8', timeout: 60000 });
  check('clean exit passes through (kill null, status 0)',
    b.kill === null && b.r.status === 0, JSON.stringify({ kill: b.kill, status: b.r.status }));

  const c = sb.spawnSyncBudgeted('node', ['-e', 'process.exit(3)'],
    { encoding: 'utf8', timeout: 60000 });
  check('nonzero exit is NOT classified as a kill (a product failure stays one)',
    c.kill === null && c.r.status === 3, JSON.stringify({ kill: c.kill, status: c.r.status }));

  let threw = false;
  try { sb.spawnSyncBudgeted('no-such-binary-513', [], { timeout: 5000 }); }
  catch (e) { threw = true; }
  check('a real spawn error (ENOENT) still throws', threw);

  const d = await sb.execFileBudgeted('node', ['-e', 'setTimeout(()=>{},8000)'],
    { encoding: 'utf8', timeout: 400 });
  check('async budget kill classified', !!(d.kill && d.kill.kind === 'budget'),
    JSON.stringify(d.kill));

  const e = await sb.execFileBudgeted('node', ['-e', 'setTimeout(()=>{},8000)'], {
    encoding: 'utf8', timeout: 60000,
    onSpawn: (ch) => setTimeout(() => { try { process.kill(ch.pid, 'SIGKILL'); } catch {} }, 300),
  });
  check('async external kill classified', !!(e.kill && e.kill.kind === 'external'),
    JSON.stringify(e.kill));

  let code3 = false;
  try { await sb.execFileBudgeted('node', ['-e', 'process.exit(3)'], { encoding: 'utf8', timeout: 60000 }); }
  catch (err) { code3 = err.code === 3; }
  check('async nonzero exit RETHROWS with its status (product failures keep their stack)', code3);
}

leg1().then(leg2).then(leg3).then(() => {
  console.log(failures === 0
    ? '\nspawn budget kill honesty: PASS'
    : `\nspawn budget kill honesty: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}, (e) => {
  console.error(e);
  process.exit(1);
});
