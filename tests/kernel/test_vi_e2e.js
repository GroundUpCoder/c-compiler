#!/usr/bin/env node
// vi e2e (todos/0011): busybox vi — a full-screen editor driven through the
// REAL stack: boot.js --tty-out (fd 0/1/2 are the kernel tty, isatty true),
// keystrokes fed through the tty's line discipline into vi's raw mode,
// screen output (cursor addressing, alternate screen) observed on stdout.
//
// Sync model: expect() scans the accumulated stdout from a moving cursor —
// vi renders what we type, so insert-mode text and colon/search lines are
// our progress markers. After every :wq the FILE BYTES are asserted via a
// `cat`+marker roundtrip in the same hush session (the screen is scenery;
// the file is the assertion).
//
// ESC is always sent alone and followed by a short pause: read_key resolves
// a lone ESC by timeout, and bundling ESC with the next keys would let it
// parse "ESC :" as a (failed) escape-sequence prefix instead.
//
// Run: node tests/kernel/test_vi_e2e.js
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

const { dir: tmp, image } = freshImage('os-vi-');

function Session() {
  this.p = cp.spawn('node', [BOOT, '--image=' + image, '--fresh', '--tty-out', '--quiet'],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  this.out = '';        // stdout: program output + vi screen writes
  this.err = '';        // stderr: hush prompts land here (tty-kind fd 2)
  this.cursor = 0;      // expect() consumes forward; redraw echoes behind it can't re-match
  this._waiter = null;
  this.p.stdout.on('data', (d) => { this.out += d.toString('latin1'); this._poke(); });
  this.p.stderr.on('data', (d) => { this.err += d.toString('latin1'); });
  this.exited = new Promise((res) => this.p.on('exit', (code) => { this.code = code; res(code); }));
}
Session.prototype._poke = function () { if (this._waiter) this._waiter(); };
Session.prototype.send = function (s) { this.p.stdin.write(Buffer.from(s, 'latin1')); };
// expect(pattern): resolve when pattern (string) appears at/after cursor;
// cursor advances past the match. Rejects loudly on timeout with a tail of
// what WAS seen (escape codes made printable) — the debugging you want.
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
        '\n--- stderr tail ---\n' + JSON.stringify(self.err.slice(-200))));
    }, timeoutMs);
    const cleanup = () => { clearTimeout(t); self._waiter = null; };
    self._waiter = scan;
    scan();
  });
};

async function main() {
  const s = new Session();
  const ESC = '\x1b';
  // A lone ESC needs read_key's escape-sequence timeout to resolve; give it
  // clear air on both sides.
  const esc = async () => { await sleep(120); s.send(ESC); await sleep(200); };
  // File-content assertion: authoritative, independent of screen scraping.
  // The echoed command line shows the literal "$?" so the marker string with
  // the real exit code below it can only come from execution.
  let markN = 0;
  const catIs = async (file, expectText, label) => {
    const m = 'MARK' + (markN++);
    s.send('echo ' + m + '-S; cat ' + file + '; echo ' + m + '-E:$?\n');
    await s.expect(m + '-E:0');
    const start = s.out.lastIndexOf(m + '-S\n');
    const body = s.out.slice(start + (m + '-S\n').length, s.out.lastIndexOf(m + '-E:0'));
    check(label, body === expectText, JSON.stringify(body));
  };

  // ---- boot (fresh: seeds hush + coreutils + cc) ----
  s.send('echo BOOT-OK\n');
  await s.expect('BOOT-OK\n', 240000);

  // ---- A: create a file — insert, ESC, :wq ----
  s.send('vi /tmp/a.txt\n');
  await s.expect('\x1b[?1049h');            // vi enters the alternate screen
  await s.expect('a.txt');                  // status line shows the filename
  s.send('ihello world');
  await s.expect('hello world');            // insert-mode text rendered
  await esc();
  s.send(':wq\r');
  await s.expect('\x1b[?1049l');            // left the alternate screen: vi exited
  await catIs('/tmp/a.txt', 'hello world\n', 'A: insert + :wq writes the file');

  // ---- B: reopen — append with A, :wq ----
  s.send('vi /tmp/a.txt\n');
  await s.expect('\x1b[?1049h');
  await s.expect('hello world');            // existing content loaded + rendered
  s.send('A!');
  await sleep(250);   // '!' renders as a positioned single char, never "world!"
  await esc();
  s.send(':wq\r');
  await s.expect('\x1b[?1049l');
  await catIs('/tmp/a.txt', 'hello world!\n', 'B: append to existing file');

  // ---- C: search + change-word ----
  s.send('vi /tmp/a.txt\n');
  await s.expect('\x1b[?1049h');
  s.send('/world\r');
  await sleep(250);
  s.send('cwWASM');
  await sleep(250);   // cw redraw + per-char inserts: no contiguous "WASM"
  await esc();
  s.send(':wq\r');
  await s.expect('\x1b[?1049l');
  await catIs('/tmp/a.txt', 'hello WASM!\n', 'C: /search + cw rewrite');

  // ---- D: dd then u (undo) — file must be unchanged after :wq ----
  s.send('vi /tmp/a.txt\n');
  await s.expect('\x1b[?1049h');
  await s.expect('hello WASM!');
  await sleep(120);
  s.send('dd');
  await sleep(200);
  s.send('u');
  await s.expect('restored');               // VERBOSE_STATUS: "Undo [1] restored N chars"
  s.send(':wq\r');
  await s.expect('\x1b[?1049l');
  await catIs('/tmp/a.txt', 'hello WASM!\n', 'D: dd + u leaves file intact');

  // ---- E: multi-line file, delete middle line, :q! discards ----
  s.send('vi /tmp/m.txt\n');
  await s.expect('\x1b[?1049h');
  s.send('iaaa\rbbb\rccc');
  await s.expect('ccc');
  await esc();
  s.send(':wq\r');
  await s.expect('\x1b[?1049l');
  await catIs('/tmp/m.txt', 'aaa\nbbb\nccc\n', 'E1: multi-line insert (CR -> newline)');

  s.send('vi /tmp/m.txt\n');
  await s.expect('\x1b[?1049h');
  await s.expect('bbb');
  await sleep(120);
  s.send('2Gdd');                           // goto line 2, delete it
  await sleep(250);
  s.send(':wq\r');
  await s.expect('\x1b[?1049l');
  await catIs('/tmp/m.txt', 'aaa\nccc\n', 'E2: 2G + dd deletes the middle line');

  s.send('vi /tmp/m.txt\n');
  await s.expect('\x1b[?1049h');
  await s.expect('ccc');
  await sleep(120);
  s.send('dd');
  await sleep(250);
  s.send(':q!\r');
  await s.expect('\x1b[?1049l');
  await catIs('/tmp/m.txt', 'aaa\nccc\n', 'E3: :q! discards the dd');

  // ---- screen sanity: real full-screen behavior was observed ----
  check('cursor addressing used (ESC[row;colH)', /\x1b\[\d+;\d+H/.test(s.out));
  check('empty-line tildes rendered', s.out.includes('\x1b[2;1H~') || /\n~/.test(s.out) || /H~/.test(s.out));

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
  console.log(failures === 0 ? '\nvi e2e: PASS' : `\nvi e2e: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}, (e) => {
  console.log('  FAIL ' + (e && e.message || e));
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\nvi e2e: FAILED');
  process.exit(1);
});
