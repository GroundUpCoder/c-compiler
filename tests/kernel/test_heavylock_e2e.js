#!/usr/bin/env node
// The heavy-test host lock guards the BOOT, not a caller list (todos/0342,
// which also closed todos/0303).
//
// The 2026-07-25 OOM guard used to live only in the two suite runners; the
// documented single-file invocation (`node tests/kernel/<e2e>.js`, a bare
// `node os/boot.js`, a hand-run os-*.mjs) booted full OSes with no lock at
// all. Now os/boot.js JOINS the lock at startup and the browser harness
// joins before serve.js/Chromium, with re-entrancy through a VERIFIED
// CC_HEAVY_LOCK_PID marker (pid alive AND equal to the recorded holder).
//
// Every leg here redirects the lock scope through a private TMPDIR
// (heavy-lock.js derives its path from os.tmpdir(), which honors TMPDIR on
// darwin and linux), so this file never touches the real host lock and needs
// no code seam. The stand-in holder is THIS process's pid — alive by
// construction, no second 4 GB boot. Leg 2 is the RED the acceptance demands
// (a guard whose failure path was never exercised is not a guard — the
// todos/0341 rule); legs 1/3/4/6 are the GREEN.
//
// Leg 7's vehicle is os-boots.mjs, not the design table's os-minimal.mjs:
// os-minimal runs a real tools/mkpkg.js build BEFORE it reaches the harness
// (a refusal control must not mutate dist/packages, and the .mkpkg-lock
// makes that racy under --repeat), while os-boots' first act is
// startServer — so "exit 3 before any serve.js or playwright work" is
// assertable via the absent `[serve]` tap. Same seam, same assertion.
//
// A lock assertion matches exit 3 AND the `[heavy-lock]` stderr marker —
// init can exit 3 legitimately (`sh -c 'exit 3'`), so the code alone is not
// the signal.
//
// Run: node tests/kernel/test_heavylock_e2e.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { mkdtempOwned } = require('../lib/harness-temp.js');
const { LOCK_PATH } = require('../lib/heavy-lock.js');

const ROOT = path.resolve(__dirname, '../..');
const BOOT = path.join(ROOT, 'os/boot.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); failures++; }
}

// Private lock scope: one throwaway dir serves as the children's TMPDIR (so
// their heavy-lock.js resolves its lock file inside it) and as image storage.
const priv = mkdtempOwned('heavylock-');
const lockFile = path.join(priv, path.basename(LOCK_PATH));
const writeLock = (pid, name) => fs.writeFileSync(lockFile, JSON.stringify({
  pid, name, host: os.hostname(), startedAt: new Date().toISOString(),
  argv: ['stand-in'],
}));
const clearLock = () => fs.rmSync(lockFile, { force: true });

// Child env: private TMPDIR, and NO inherited lock state — under the kernel
// suite this test's own env carries the runner's CC_HEAVY_LOCK_PID, which
// must not leak into legs that stage their own markers.
function childEnv(extra) {
  const env = Object.assign({}, process.env, { TMPDIR: priv }, extra || {});
  if (!extra || !('CC_NO_HEAVY_LOCK' in extra)) delete env.CC_NO_HEAVY_LOCK;
  if (!extra || !('CC_HEAVY_LOCK_PID' in extra)) delete env.CC_HEAVY_LOCK_PID;
  return env;
}

// One real boot per GREEN leg; the image is minted in leg 1 and REUSED by
// legs 3/4/6 (no re-seed, no re-install — keeps four boots affordable).
const image = path.join(priv, 'os.img');
function boot(script, { env, args = [], timeout = 300000 } = {}) {
  return cp.spawnSync('node', [BOOT, '--image=' + image, '--quiet', ...args],
    { input: script + '\n', encoding: 'utf8', timeout, env });
}

// ---- leg 1: no lock file → the boot runs, exit 0 ----
clearLock();
{
  const r = boot('echo LEG1-OK', { env: childEnv() });
  check('leg 1: free lock — boot runs the script', r.status === 0 && r.stdout.includes('LEG1-OK'),
    { status: r.status, stderr: String(r.stderr).slice(-500) });
  check('leg 1: the boot RELEASED its lock on exit', !fs.existsSync(lockFile));
}

// ---- leg 2 (the RED control): live foreign holder → exit 3, fast, loud ----
writeLock(process.pid, 'stand-in holder');
{
  const img2 = path.join(priv, 'never.img');
  // No --quiet: any [boot] progress line would prove image work happened.
  const r = cp.spawnSync('node', [BOOT, '--image=' + img2],
    { input: 'echo NEVER\n', encoding: 'utf8', timeout: 120000, env: childEnv() });
  const err = String(r.stderr || '');
  check('leg 2: exit 3 with the [heavy-lock] marker', r.status === 3 && err.includes('[heavy-lock]'),
    { status: r.status, stderr: err.slice(-500) });
  check('leg 2: the refusal NAMES the holder', err.includes('stand-in holder') && err.includes('pid ' + process.pid), err.slice(-500));
  check('leg 2: the refusal names CC_NO_HEAVY_LOCK=1', err.includes('CC_NO_HEAVY_LOCK=1'));
  check('leg 2: no image work happened', !fs.existsSync(img2) && !err.includes('[boot]'),
    { imgExists: fs.existsSync(img2) });
  check('leg 2: the script never ran', !String(r.stdout || '').includes('NEVER'));
}

// ---- leg 3 (the nested proof): verified marker → re-entrant join, exit 0 ----
// Lock still held by this (alive) pid; the marker aims at the same pid, so
// both re-entrancy conditions hold. This is the kernel suite's fan-out shape
// in miniature.
{
  const r = boot('echo LEG3-OK', { env: childEnv({ CC_HEAVY_LOCK_PID: String(process.pid) }) });
  check('leg 3: verified marker joins re-entrantly', r.status === 0 && r.stdout.includes('LEG3-OK'),
    { status: r.status, stderr: String(r.stderr).slice(-500) });
  check('leg 3: a re-entrant join has NO release duty (lock survives)', fs.existsSync(lockFile));
}

// ---- leg 4: dead-pid holder → stale steal, exit 0 ----
{
  const dead = cp.spawnSync('node', ['-e', '']);   // finished → its pid is dead
  writeLock(dead.pid, 'dead stand-in');
  const r = boot('echo LEG4-OK', { env: childEnv() });
  check('leg 4: a dead holder is stolen', r.status === 0 && r.stdout.includes('LEG4-OK'),
    { status: r.status, deadPid: dead.pid, stderr: String(r.stderr).slice(-500) });
  check('leg 4: the stealer released on exit', !fs.existsSync(lockFile));
}

// ---- leg 5: driveBoot propagates the refusal as ITS OWN exit 3 ----
// driveBoot calls process.exit(3) in the CALLING process, so it runs in a
// scratch child — exactly the single-file `node tests/kernel/<e2e>.js` shape
// this item's acceptance names.
writeLock(process.pid, 'stand-in holder');
{
  const script = 'require(' + JSON.stringify(path.join(__dirname, 'lib/drive.js')) +
    ').driveBoot("echo LEG5", { image: ' + JSON.stringify(path.join(priv, 'leg5.img')) + ' });';
  const r = cp.spawnSync('node', ['-e', script],
    { encoding: 'utf8', timeout: 120000, cwd: ROOT, env: childEnv() });
  const err = String(r.stderr || '');
  check('leg 5: a driveBoot caller exits 3', r.status === 3, { status: r.status, stderr: err.slice(-500) });
  check('leg 5: the propagated refusal names the holder',
    err.includes('[heavy-lock]') && err.includes('stand-in holder'), err.slice(-500));
}

// ---- leg 6: CC_NO_HEAVY_LOCK=1 escapes past a live foreign holder ----
{
  const r = boot('echo LEG6-OK', { env: childEnv({ CC_NO_HEAVY_LOCK: '1' }) });
  check('leg 6: the escape hatch boots', r.status === 0 && r.stdout.includes('LEG6-OK'),
    { status: r.status, stderr: String(r.stderr).slice(-500) });
  check('leg 6: the escape never touched the lock', fs.existsSync(lockFile));
}

// ---- leg 7: a hand-run os-*.mjs exits 3 at the harness, before serve.js ----
{
  const r = cp.spawnSync('node', [path.join(ROOT, 'tests/browser/os-boots.mjs')],
    { encoding: 'utf8', timeout: 120000, cwd: path.join(ROOT, 'tests/browser'), env: childEnv() });
  const all = String(r.stdout || '') + String(r.stderr || '');
  check('leg 7: os-boots.mjs exits 3 under a foreign holder',
    r.status === 3 && all.includes('[heavy-lock]'), { status: r.status, tail: all.slice(-500) });
  check('leg 7: refused BEFORE serve.js spawned (no [serve] tap output)', !all.includes('[serve]'));
  check('leg 7: the refusal names this harness caller', all.includes('os-boots.mjs'), all.slice(-500));
}

// ---- leg 8: --wait-lock=SECS exits 3 at the deadline, loudly ----
// (The holder never frees. The wait must print its status line — todos/0171:
// a wait is never silent — and the refusal must say the deadline fired.)
writeLock(process.pid, 'stand-in holder');
{
  const t0 = Date.now();
  const r = boot('echo NEVER', { env: childEnv(), args: ['--wait-lock=2'], timeout: 120000 });
  const err = String(r.stderr || '');
  check('leg 8: --wait-lock=2 exits 3 at the deadline', r.status === 3 && err.includes('[heavy-lock]'),
    { status: r.status, stderr: err.slice(-500) });
  check('leg 8: the wait was LOUD (status line printed)', err.includes('waiting for stand-in holder'), err.slice(-500));
  check('leg 8: the refusal says the deadline fired', err.includes('deadline reached'));
  check('leg 8: the deadline was honored (~2s, not the spawn timeout)', Date.now() - t0 < 60000, Date.now() - t0);
}

// ---- leg 9: --wait-lock acquires when the holder frees ----
// A helper process frees the lock after 2s (this process is about to block
// in spawnSync, so it cannot free the lock itself).
{
  cp.spawn('node', ['-e', 'setTimeout(()=>require("fs").rmSync(process.argv[1],{force:true}),2000)', lockFile],
    { stdio: 'ignore' });
  const r = boot('echo LEG9-OK', { env: childEnv(), args: ['--wait-lock=120'] });
  const err = String(r.stderr || '');
  check('leg 9: --wait-lock acquires when the lock frees', r.status === 0 && r.stdout.includes('LEG9-OK'),
    { status: r.status, stderr: err.slice(-500) });
  check('leg 9: it waited loudly first', err.includes('waiting for stand-in holder'), err.slice(-500));
}

clearLock();
console.log(failures === 0 ? '\nheavylock e2e: PASS' : `\nheavylock e2e: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
