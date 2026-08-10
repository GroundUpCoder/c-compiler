#!/usr/bin/env node
// #503 + #504 e2e: the bash-tool cap BOUNDS wall time, a backgrounded
// launch returns at the sh-exit reap instead of burning the cap, and both
// report honestly.
//
// The two defects this pins (measured in the #488 Pass B dogfood):
//   1. The cap did not bound. On SIGALRM the drain loop killed the direct
//      sh and kept draining to EOF — a pipe-holding descendant (hush runs
//      `sleep N` as its own child) held the read open past the cap, or
//      forever for `sleep N &`. Worse: the alarm flag was checked ONLY in
//      the EINTR branch, so a chatty child whose reads keep succeeding
//      never saw the check at all and ran unbounded.
//   2. It reported a kill that did not happen: "[command killed: exceeded
//      120s timeout]" while the command ran to completion.
//
// Machinery: the scripted fake Anthropic SSE server (one tool_use round
// per POST) + a paced boot Session, with GCODE_BASH_SECS=3 (the #503
// testability seam — same code path as the 120s default, measured in
// seconds instead of minutes). Script:
//   round 1  bash `echo PROBE-OK`                positive control: [exit 0]
//   round 2  bash `sleep 30`                     parked-read timeout (sh
//            alive at the alarm; its sleep child survives the sh kill and
//            holds the pipe — the drain-to-EOF trap)
//   round 3  bash `sleep 30 &`                   sh already gone; ONLY the
//            orphan holds the pipe. #504: the sh-exit reap returns this in
//            ~1s with the real [exit 0] + the survivors note (it used to
//            burn the cap and report [exit -1] for a launch that worked)
//   round 4  bash `while true; do echo spam; done`  chatty child: reads
//            keep succeeding, so an EINTR-only alarm check NEVER fires
//            (pre-fix: unbounded — this leg is the red control's hang)
//   round 5  bash `cd /root && winbox >/tmp/w.log 2>&1 &`   the #504
//            dogfood shape: a compound background launch, whose NOMMU
//            re-exec'd hush wrapper holds the pipe for the app's lifetime
//            (mechanism: logs/2026-08-10/504-gcode-windowed-launch.md) —
//            returns [exit 0] + note in ~1s via the same reap
//   round 6  bash `wmctl wait win winbox && echo WIN-UP`    the early
//            return must not have lost the launch: the window exists
//   round 7  text ALL-DONE-MARKER
//
// Instruments (before -> after):
//   wall time gcode-start -> ALL-DONE-MARKER: unbounded (hangs in round 4;
//     the expect timeout is the red) -> ~10s (two 3s timeouts + two ~1s
//     reaps + overhead)
//   tool_result rounds 2/4: "[exit 0]"/plain output after the cap ->
//     "[exit -1]" + "timed out after 3s" + the may-still-be-running caveat
//   tool_result rounds 3/5 (#504): "[exit -1]" + a false timeout report ->
//     "[exit 0]" + "still running; their further output is not captured"
//   tool_result round 1: "[exit 0]" + PROBE-OK (positive control, both
//     sides — proves the instrument can see a healthy round)
//
// Run: node tests/kernel/test_gcode_timeout_e2e.js
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

const { dir: tmp, image } = freshImage('os-gcode-timeout-');
const scriptPath = path.join(tmp, 'script.json');
const bodiesPath = path.join(tmp, 'bodies.jsonl');

fs.writeFileSync(scriptPath, JSON.stringify([
  { kind: 'tool', preface: 'probe.', id: 't1', name: 'bash', input: { command: 'echo PROBE-OK' } },
  { kind: 'tool', preface: 'holder-live-sh.', id: 't2', name: 'bash', input: { command: 'sleep 30' } },
  { kind: 'tool', preface: 'holder-orphan.', id: 't3', name: 'bash', input: { command: 'sleep 30 &' } },
  { kind: 'tool', preface: 'chatty.', id: 't4', name: 'bash', input: { command: 'while true; do echo spam; done' } },
  // #504: the compound background launch — hush runs `cd X && app &` in a
  // NOMMU re-exec'd subshell wrapper that inherits the capture pipe and
  // survives (waiting) for the app's whole lifetime, so pipe EOF never
  // comes. Pre-#504 this burned the full cap and reported [exit -1] for a
  // launch that succeeded; post-#504 the sh-exit reap returns it in ~1s
  // with [exit 0] + the survivors note. Same fix serves round 3.
  { kind: 'tool', preface: 'launch.', id: 't5', name: 'bash', input: { command: 'cd /root && winbox >/tmp/w.log 2>&1 &' } },
  // The early return must not have lost the launch: the window really exists.
  { kind: 'tool', preface: 'verify.', id: 't6', name: 'bash', input: { command: 'wmctl wait win winbox && echo WIN-UP' } },
  { kind: 'text', text: 'ALL-DONE-MARKER' },
]));

// The paced Session from test_gcode_intr_flush_e2e.js (itself from
// test_jobctl_tty_e2e.js): incremental expect over live stdout/stderr —
// needed here because the instrument is WALL TIME between two markers.
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

    // One-shot gcode run; every tool round is scripted server-side.
    const t0 = Date.now();
    s.send(`GCODE_BASH_SECS=3 ANTHROPIC_BASE_URL=http://127.0.0.1:${port} ` +
      'ANTHROPIC_API_KEY=test-key gcode --no-color --no-persist -p go ' +
      '&& echo GCODE-EXIT-0\n');
    // Pre-fix this expect is the red: round 4 (chatty) never returns — the
    // 90s budget is many times the fixed cost of the two timeout rounds
    // and strictly less than any pre-fix completion path.
    await s.expectOut('ALL-DONE-MARKER', 90000);
    const elapsed = Date.now() - t0;

    // The cap BOUNDS: two 3s-capped rounds (live-sh, chatty) plus fast
    // rounds — the orphan and launch rounds return at the ~1s sh-exit reap
    // (#504), not the cap. 60s (~5x the post-fix measurement) tolerates
    // load; every pre-fix path is >= 60s here (two 30s sleeps + an
    // unbounded round).
    check('cap bounds wall time (' + elapsed + 'ms for 2 capped + 2 reaped rounds)', elapsed < 60000);

    await s.expectOut('GCODE-EXIT-0', 30000);
    check('gcode exited 0 after the capped rounds', true);

    // ---- tool_result honesty, from the POST bodies the server recorded ----
    const bodies = fs.readFileSync(bodiesPath, 'utf8').trim().split('\n');
    check('seven POSTs recorded (6 tool rounds + final)', bodies.length === 7,
      'got ' + bodies.length);

    // body[i] carries the tool_result for script round i (body[0] is the
    // bare prompt). Positive control first: the instrument sees a healthy
    // round's exit code and output.
    const probe = bodies[1] || '';
    check('probe round: [exit 0] + PROBE-OK (positive control)',
      probe.includes('[exit 0]') && probe.includes('PROBE-OK'));

    for (const [i, name] of [[2, 'live-sh holder'], [4, 'chatty']]) {
      const b = bodies[i] || '';
      check(name + ': reports [exit -1]', b.includes('[exit -1]'),
        JSON.stringify(b.slice(0, 300)));
      check(name + ': names the real cap (timed out after 3s)',
        b.includes('timed out after 3s'));
      check(name + ': admits survivors may still be running',
        b.includes('may still be running'));
      check(name + ': does NOT claim a completed kill of the whole command',
        !b.includes('command killed: exceeded'));
    }
    // #504: rounds whose direct sh exits while a survivor holds the pipe
    // return promptly with the REAL exit status and the honest note — no
    // cap burn, no [exit -1] for a launch that succeeded. Round 3 is the
    // simple orphan (`sleep 30 &` — the orphan itself inherits fds 1/2);
    // round 5 is the compound launch (`cd X && winbox &` — the NOMMU
    // re-exec'd hush wrapper holds the pipe; the #504 dogfood shape).
    // Pre-#504 both burned the cap and reported [exit -1]: these checks
    // are the red control against unfixed gcode (verified red 2026-08-10).
    // NB assert on the round's OWN tool_result (the request's last
    // message), not the whole body — every body accumulates the earlier
    // rounds' results, so a whole-body substring check is vacuous.
    const lastResult = (i) => {
      try {
        const msgs = JSON.parse(bodies[i]).messages || [];
        return JSON.stringify(msgs[msgs.length - 1].content) || '';
      } catch (e) { return ''; }
    };
    for (const [i, name] of [[3, 'orphan holder'], [5, 'compound launch']]) {
      const b = lastResult(i);
      check(name + ': returns the real [exit 0]', b.includes('[exit 0]'),
        JSON.stringify(b.slice(0, 300)));
      check(name + ': notes survivors\' output is not captured',
        b.includes('still running; their further output is not captured'));
      check(name + ': did NOT burn the cap (no timeout report)',
        b !== '' && !b.includes('timed out after'));
    }
    // The early return must not have LOST the launch: the window exists.
    check('launch verify: wmctl saw the winbox window (WIN-UP)',
      lastResult(6).includes('[exit 0]') && lastResult(6).includes('WIN-UP'));
    // Output produced BEFORE the cap must still reach the model.
    check('chatty: pre-cap output was delivered (spam present)',
      (bodies[4] || '').includes('spam'));
  } finally {
    try { s.p.kill('SIGKILL'); } catch (e) { /* already gone */ }
    try { server.kill('SIGKILL'); } catch (e) { /* already gone */ }
  }

  if (failures) { console.log('\n' + failures + ' FAILURE(S)'); process.exit(1); }
  console.log('\nPASS');
}

main().catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
