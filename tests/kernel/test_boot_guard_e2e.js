#!/usr/bin/env node
// todos/0293 (#101, the 0045 noted-only follow-up): headless boot.js takes a
// SINGLE-INSTANCE guard on its image pair — the twin of the browser's Web
// Lock. Two live BlockFS instances over one writable root store are silent
// cross-file corruption by BlockFS's own multi-instance rules, and the test
// estate never catches it because drive.js mints a fresh mkdtemp pair per
// boot. So this file points two boots at ONE store DELIBERATELY — the exact
// isolation-hides-the-bug shape the ticket names.
//
// Legs (private TMPDIR so the children's heavy lock never touches the real
// host lock; boot A becomes the private heavy-lock holder, which also proves
// the image guard refuses BEFORE contending for the machine-wide lock):
//   1. boot A holds the pair (stdin pipe open at the hush prompt); a second
//      boot B of the SAME --image= is refused: exit 5, stderr names the
//      holder pid and the lock path, B's script never runs.
//   2. A exits cleanly -> the sidecar lock is RELEASED.
//   3. boot C of the same pair now runs (the refusal was the lock, not the
//      image), and releases on exit too.
//   4. a stale lock left by a dead holder is STOLEN (self-heal), and the
//      stealer releases on exit.
//
// Run: node tests/kernel/test_boot_guard_e2e.js
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { mkdtempOwned } = require('../lib/harness-temp.js');

const ROOT = path.resolve(__dirname, '../..');
const BOOT = path.join(ROOT, 'os/boot.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); failures++; }
}

// Private scope: the ONE image pair every leg shares, and a private TMPDIR
// so child boots contend a private heavy lock, not the host's.
const priv = mkdtempOwned('bootguard-');
const image = path.join(priv, 'os.img');
const imageLock = path.join(priv, 'os-root.img.lock');   // boot.js pairing rule

// Child env: private TMPDIR, no inherited heavy-lock state (under the kernel
// suite this process carries the runner's CC_HEAVY_LOCK_PID, which points at
// the HOST lock — meaningless inside the private TMPDIR scope).
function childEnv() {
  const env = Object.assign({}, process.env, { TMPDIR: priv });
  delete env.CC_NO_HEAVY_LOCK;
  delete env.CC_HEAVY_LOCK_PID;
  return env;
}

function bootSync(script, timeout = 300000) {
  return cp.spawnSync('node', [BOOT, '--image=' + image, '--quiet'],
    { input: script + '\n', encoding: 'utf8', timeout, env: childEnv() });
}

const sleepMs = (ms) =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

(async () => {
  // ---- legs 1+2: a live holder refuses the second boot; exit releases ----
  {
    const a = cp.spawn('node', [BOOT, '--image=' + image, '--quiet'],
      { stdio: ['pipe', 'pipe', 'pipe'], env: childEnv() });
    let aOut = '', aErr = '';
    a.stdout.on('data', (d) => { aOut += d; });
    a.stderr.on('data', (d) => { aErr += d; });
    const aExit = new Promise((res) => a.on('exit', (code, sig) => res({ code, sig })));

    // The guard latches before any image work, so the sidecar appearing is
    // the "A owns the pair" marker (never a fixed sleep — 0171).
    let latched = false;
    for (let i = 0; i < 1200 && !latched; i++) {
      if (fs.existsSync(imageLock)) latched = true;
      else sleepMs(100);
    }
    check('leg 1: boot A latched the image-pair lock', latched, aErr.slice(-500));

    const b = bootSync('echo B-RAN', 120000);
    const bErr = String(b.stderr || '');
    check('leg 1: second boot of the SAME pair refused at exit 5',
      b.status === 5, { status: b.status, stderr: bErr.slice(-500) });
    check('leg 1: the refusal names the holder pid and the lock path',
      bErr.includes('pid ' + a.pid) && bErr.includes(imageLock), bErr.slice(-500));
    check('leg 1: the refused boot never ran its script',
      !String(b.stdout || '').includes('B-RAN'), String(b.stdout || '').slice(-200));
    check('leg 1: the holder still owns the lock after the refusal',
      fs.existsSync(imageLock));

    // A exits cleanly; the lock must go with it.
    a.stdin.write('exit 0\n');
    const ax = await aExit;
    check('leg 2: boot A exited cleanly', ax.code === 0, { exit: ax, stderr: aErr.slice(-500) });
    check('leg 2: A released the image-pair lock on exit', !fs.existsSync(imageLock));
  }

  // ---- leg 3: the pair is bootable again once the holder is gone ----
  {
    const r = bootSync('echo C-OK');
    check('leg 3: freed pair boots (exit 0, script ran)',
      r.status === 0 && String(r.stdout || '').includes('C-OK'),
      { status: r.status, stderr: String(r.stderr || '').slice(-500) });
    check('leg 3: released on exit', !fs.existsSync(imageLock));
  }

  // ---- leg 4: a dead holder's stale lock is stolen (self-heal) ----
  {
    const dead = cp.spawnSync('node', ['-e', '']);   // finished -> pid is dead
    fs.writeFileSync(imageLock, JSON.stringify({
      pid: dead.pid, image, startedAt: new Date().toISOString(), argv: ['stale'],
    }));
    const r = bootSync('echo D-OK');
    check('leg 4: a dead holder is stolen — the boot runs',
      r.status === 0 && String(r.stdout || '').includes('D-OK'),
      { status: r.status, deadPid: dead.pid, stderr: String(r.stderr || '').slice(-500) });
    check('leg 4: the stealer released on exit', !fs.existsSync(imageLock));
  }

  console.log(failures === 0 ? '\nboot guard e2e: PASS' : `\nboot guard e2e: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
