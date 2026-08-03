#!/usr/bin/env node
// #433 e2e: ^C during a streaming gcode turn flushes queued tty type-ahead.
//
// The symptom this pins: a line typed + Entered while a turn streams goes
// into the tty's COOKED queue at its Enter; VINTR used to clear only the
// in-progress edit buffer, so after "gcode: interrupted" the queued line
// was delivered to the next read_input_line and AUTO-SUBMITTED as the next
// user message. POSIX termios: INTR flushes the input queue unless NOFLSH.
//
// Machinery: the async paced-tty Session from test_jobctl_tty_e2e.js (NOT
// driveBoot's single-shot stdin — the whole point is real keystroke pacing
// against a live turn) + the scripted fake Anthropic SSE server. Script
// entry 1 stalls forever (the #306 shape), so after its 'Thinking...'
// delta the turn is provably mid-stream when the type-ahead and the ^C
// arrive. Entry 2 is a sentinel: if the queued line IS submitted (the
// pre-fix bug), the server answers 'SHOULD-NOT-HAPPEN.' and the run still
// terminates cleanly — the red stays a check FAIL, never a hang.
//
// Instruments (before -> after):
//   bodies.jsonl POST count: 2 -> 1 (nothing auto-submitted after ^C)
//   stdout 'SHOULD-NOT-HAPPEN.': present -> absent
//
// Run: node tests/kernel/test_gcode_intr_flush_e2e.js
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { freshImage } = require('./lib/drive.js');

const ROOT = path.resolve(__dirname, '../..');
const BOOT = path.join(ROOT, 'os/boot.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

const { dir: tmp, image } = freshImage('os-gcode-intr-');
const scriptPath = path.join(tmp, 'script.json');
const bodiesPath = path.join(tmp, 'bodies.jsonl');

fs.writeFileSync(scriptPath, JSON.stringify([
  { kind: 'stall', text: 'Thinking...' },        // never ends; ^C aborts it
  { kind: 'text', text: 'SHOULD-NOT-HAPPEN.' },  // reached ONLY by the bug
]));

// test_jobctl_tty_e2e.js Session, plus a stderr expect (gcode's banner,
// speaker headers and 'gcode: interrupted' are stderr; streamed content is
// stdout). Piped mode drops tty echo, so both streams are program output.
function Session() {
  this.p = cp.spawn('node', [BOOT, '--image=' + image, '--fresh', '--tty-out', '--quiet'],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  this.out = ''; this.err = '';
  this.outCur = 0; this.errCur = 0;
  this._waiter = null;
  this.p.stdout.on('data', (d) => { this.out += d.toString('latin1'); this._poke(); });
  this.p.stderr.on('data', (d) => { this.err += d.toString('latin1'); this._poke(); });
  this.exited = new Promise((res) => this.p.on('exit', (code) => { this.code = code; res(code); }));
}
Session.prototype._poke = function () { if (this._waiter) this._waiter(); };
Session.prototype.send = function (s) { this.p.stdin.write(Buffer.from(s, 'latin1')); };
Session.prototype._expect = function (stream, cursor, pattern, timeoutMs) {
  const self = this;
  timeoutMs = timeoutMs || 60000;
  return new Promise((resolve, reject) => {
    const scan = () => {
      const i = self[stream].indexOf(pattern, self[cursor]);
      if (i >= 0) { self[cursor] = i + pattern.length; cleanup(); resolve(); return true; }
      return false;
    };
    const t = setTimeout(() => {
      cleanup();
      reject(new Error('timeout waiting for ' + JSON.stringify(pattern) + ' on ' + stream +
        '\n--- stdout tail ---\n' + JSON.stringify(self.out.slice(-400)) +
        '\n--- stderr tail ---\n' + JSON.stringify(self.err.slice(-400))));
    }, timeoutMs);
    const cleanup = () => { clearTimeout(t); self._waiter = null; };
    self._waiter = scan;
    scan();
  });
};
Session.prototype.expectOut = function (p, t) { return this._expect('out', 'outCur', p, t); };
Session.prototype.expectErr = function (p, t) { return this._expect('err', 'errCur', p, t); };

async function main() {
  const server = cp.spawn('node', [path.join(__dirname, 'lib/fake_anthropic.js'),
    scriptPath, bodiesPath], { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise((resolve, reject) => {
    let acc = '';
    server.stdout.on('data', (c) => {
      acc += c;
      const m = acc.match(/PORT (\d+)/);
      if (m) resolve(Number(m[1]));
    });
    server.on('exit', () => reject(new Error('fake server died')));
    setTimeout(() => reject(new Error('fake server: no PORT line')), 10000);
  });

  const s = new Session();
  try {
    s.send('echo BOOT-OK\n');
    await s.expectOut('BOOT-OK\n', 240000);

    // ---- interactive gcode session on the system tty (fg pgroup) ----
    s.send(`ANTHROPIC_BASE_URL=http://127.0.0.1:${port} ANTHROPIC_API_KEY=test-key ` +
      'gcode --no-color --no-persist\n');
    await s.expectErr('type a request');   // banner: gcode is up
    await s.expectErr('You:');             // at the lineedit prompt

    // ---- submit a message; the scripted stream stalls mid-flight ----
    s.send('stall it\n');
    await s.expectOut('Thinking...');      // delta arrived: turn is streaming,
                                           // lineedit exited (tty canonical)

    // ---- type-ahead while streaming, then ^C ----
    s.send('queued message\n');            // lands in the cooked queue
    await sleep(300);                      // let the line REACH the queue before
                                           // the ^C (two writes may coalesce, but
                                           // the bug needs it queued, not racing)
    s.send('\x03');                        // VINTR: SIGINT + (fixed) queue flush
    await s.expectErr('interrupted');      // the turn aborted (#306 machinery)
    await s.expectErr('You:');             // fresh prompt after the ^C

    // Pre-fix, lineedit reads the queued line at this prompt and submits it
    // as the next user message (POST 2, 'SHOULD-NOT-HAPPEN.' streamed back).
    // Give that a beat to happen if it is going to, then quit.
    await sleep(1000);
    s.send('/quit\n');

    // ---- clean shutdown: gcode exits, hush prompt, boot exits ----
    s.send('echo GDONE\n');
    await s.expectOut('GDONE\n');
    s.send('exit\n');
    const code = await s.exited;
    check('session exits clean', code === 0, String(code));

    const bodies = fs.readFileSync(bodiesPath, 'utf8').trim().split('\n').filter(Boolean);
    check('#433: exactly 1 POST reached the server (type-ahead not auto-submitted)',
      bodies.length === 1, String(bodies.length));
    check('#433: sentinel reply never streamed', !s.out.includes('SHOULD-NOT-HAPPEN.'),
      JSON.stringify(s.out.slice(-300)));
    check('turn was really mid-stream at the ^C', s.out.includes('Thinking...'));
    check('^C surfaced as "gcode: interrupted", not a transport error',
      s.err.includes('gcode: interrupted') && !s.err.includes('transport error'),
      JSON.stringify(s.err.slice(-300)));
  } finally {
    server.kill('SIGKILL');
    if (s.code == null) s.p.kill('SIGKILL');
  }
}

main().then(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nall ok');
  process.exit(failures ? 1 : 0);
}).catch((e) => { console.error(e); process.exit(1); });
