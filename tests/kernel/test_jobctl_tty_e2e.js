#!/usr/bin/env node
// Interactive job control e2e (the HANDOFF lingering item; machinery from
// todos/0003, harness from todos/0011): Ctrl-Z / fg / bg / jobs / kill %1
// driven through the REAL stack — boot.js --tty-out, keystrokes through the
// kernel tty line discipline into busybox hush's job control, `cat` as the
// foreground/background tty reader.
//
// Sync model (test_vi_e2e.js rules): piped mode drops tty echo, so stdout
// carries exactly program output — a line typed at a foreground `cat` comes
// back exactly once, `jobs`/`echo` output is byte-clean. Every scenario
// ends with an `echo MARKER:$?` roundtrip; the echoed command line is never
// on stdout (no echo), so `A:130` can only come from execution.
//
// What this pins down beyond the non-interactive test_jobctl_e2e.js
// (embedder-initiated kernel.kill): the full INTERACTIVE loop — VSUSP in
// the line discipline -> SIGTSTP to the fg pgroup -> hush reaps
// WUNTRACED -> jobs table -> fg/bg builtins -> SIGCONT + tcsetpgrp -> the
// job actually CONSUMES tty input again; and SIGTTIN stopping a background
// reader spawned with `&`. Notably: while a tty-reading job is stopped (or
// backgrounded), typed input must route to hush, NOT to the job's parked
// read — the input-stealing class this test was written to catch.
//
// Run: node tests/kernel/test_jobctl_tty_e2e.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { freshImage } = require('./lib/drive.js');

const ROOT = path.resolve(__dirname, '../..');
const BOOT = path.join(ROOT, 'os/boot.js');   // async paced-tty spawn below (not driveBoot's single-shot model)

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

const { dir: tmp, image } = freshImage('os-jobctl-');

function Session() {
  this.p = cp.spawn('node', [BOOT, '--image=' + image, '--fresh', '--tty-out', '--quiet'],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  this.out = '';        // stdout: program output (echo is dropped under pipes)
  this.err = '';        // stderr: hush prompts + job notifications
  this.cursor = 0;
  this._waiter = null;
  this.p.stdout.on('data', (d) => { this.out += d.toString('latin1'); this._poke(); });
  this.p.stderr.on('data', (d) => { this.err += d.toString('latin1'); });
  this.exited = new Promise((res) => this.p.on('exit', (code) => { this.code = code; res(code); }));
}
Session.prototype._poke = function () { if (this._waiter) this._waiter(); };
Session.prototype.send = function (s) { this.p.stdin.write(Buffer.from(s, 'latin1')); };
Session.prototype.expect = function (pattern, timeoutMs) {
  const self = this;
  timeoutMs = timeoutMs || 60000;
  return new Promise((resolve, reject) => {
    const scan = () => {
      const i = self.out.indexOf(pattern, self.cursor);
      if (i >= 0) {
        self.cursor = i + pattern.length;
        cleanup(); resolve();
        return true;
      }
      return false;
    };
    const t = setTimeout(() => {
      cleanup();
      const tail = self.out.slice(Math.max(self.cursor, self.out.length - 400));
      reject(new Error('timeout waiting for ' + JSON.stringify(pattern) +
        '\n--- last output ---\n' + JSON.stringify(tail) +
        '\n--- stderr tail ---\n' + JSON.stringify(self.err.slice(-300))));
    }, timeoutMs);
    const cleanup = () => { clearTimeout(t); self._waiter = null; };
    self._waiter = scan;
    scan();
  });
};

async function main() {
  const s = new Session();

  // ---- boot (fresh: seeds hush + coreutils + cc) ----
  s.send('echo BOOT-OK\n');
  await s.expect('BOOT-OK\n', 240000);

  // ---- A: foreground roundtrip, then Ctrl-C kills the job (130) ----
  s.send('cat\n');
  await sleep(500);                       // cat is fg, parked in a tty read
  s.send('hello-cat\n');
  await s.expect('hello-cat\n');          // the line came back through cat
  s.send('\x03');                         // VINTR -> SIGINT to the fg pgroup
  s.send('echo A:$?\n');
  await s.expect('A:130\n');              // 128|SIGINT, and hush is back
  check('A: fg cat roundtrip + Ctrl-C death (130)', true);

  // ---- B: Ctrl-Z stops the fg job; hush stays usable; fg resumes it ----
  s.send('cat\n');
  await sleep(500);
  s.send('one\n');
  await s.expect('one\n');                // cat is alive and reading
  s.send('\x1a');                         // VSUSP -> SIGTSTP
  await sleep(400);                       // hush reaps the stop (WUNTRACED)
  s.send('jobs\n');
  await s.expect('Stopped');              // input went to HUSH, not the
  await s.expect('cat');                  // stopped cat's parked read
  s.send('echo B:$?\n');
  await s.expect('B:0\n');
  check('B1: Ctrl-Z stops cat; jobs lists it; shell responsive', true);
  s.send('fg\n');
  await sleep(500);                       // SIGCONT + tcsetpgrp back to cat
  s.send('two\n');
  await s.expect('two\n');                // cat CONSUMES input again
  s.send('\x03');
  s.send('echo C:$?\n');
  await s.expect('C:130\n');
  check('B2: fg resumes the stopped reader; Ctrl-C ends it', true);

  // ---- C0: `cat &` — hush /dev/null's a bg pipe's stdin (its documented
  // semantics, unlike bash), so the job just reads EOF and finishes ----
  s.send('cat &\n');
  await sleep(600);
  s.send('echo D0:ok\n');
  await s.expect('D0:ok\n');
  await s.expect('Done');                 // "[1] Done cat" prints at the prompt
                                          // AFTER the echo ran (checkjobs order)
  check('C0: cat& gets /dev/null stdin and finishes (hush semantics)', true);

  // ---- C: Ctrl-Z then `bg` — the resumed reader is now BACKGROUND with a
  // still-parked tty read; the next typed line must SIGTTIN-stop it and
  // reach hush (the serve-time eligibility path in _ttyNotify) ----
  s.send('cat\n');
  await sleep(500);                       // fg reader parked in the tty
  s.send('\x1a');                         // stop it
  await sleep(400);
  s.send('bg\n');                         // SIGCONT, but hush keeps the tty
  await sleep(500);                       // cat runs bg, read still parked
  s.send('jobs\n');                       // typing this wakes the queue:
  await s.expect('Stopped');              //   cat -> SIGTTIN (stopped), line -> hush
  s.send('echo D:ok\n');
  await s.expect('D:ok\n');               // shell owns the tty throughout
  check('C1: bg tty reader SIGTTIN-stopped at serve time; shell keeps the tty', true);
  s.send('fg\n');
  await sleep(500);
  s.send('three\n');
  await s.expect('three\n');              // rescued to fg, reading again
  s.send('\x03');
  s.send('echo E:$?\n');
  await s.expect('E:130\n');
  check('C2: fg rescues the SIGTTIN-stopped job', true);

  // ---- D: kill %1 terminates a stopped job; wait comes back clean ----
  s.send('cat\n');
  await sleep(500);
  s.send('\x1a');
  await sleep(400);
  s.send('kill %1\n');
  await sleep(400);                       // SIGTERM lands even while stopped
  s.send('wait; echo F:$?\n');
  await s.expect('F:');                   // wait returns: no live jobs left
  check('D: kill %1 on a stopped job; wait unblocks', true);

  // ---- clean shutdown ----
  s.send('exit\n');
  const code = await s.exited;
  check('session exits clean', code === 0, String(code));
}

const watchdog = setTimeout(() => {
  console.log('  FAIL global watchdog (360s) fired');
  process.exit(1);
}, 360000);
watchdog.unref && watchdog.unref();

main().then(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures === 0 ? '\njob control tty e2e: PASS' : `\njob control tty e2e: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}, (e) => {
  console.log('  FAIL ' + (e && e.message || e));
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\njob control tty e2e: FAILED');
  process.exit(1);
});
