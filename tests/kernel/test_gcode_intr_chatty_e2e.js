#!/usr/bin/env node
// #510 e2e: a CHATTY child must not defeat the ^C survivor-edge kill.
//
// The defect (the interrupt twin of #503's finding (b)): the `g_interrupted`
// check that SIGKILLs the sh after a ^C lived ONLY in the drain loop's EINTR
// branch. gucOS signals are cooperative — the handler runs at an env-import
// safe point (host.js wraps every env import; the claim is at the import's
// RETURN), so a chatty child whose reads keep returning data never parks,
// never EINTRs, and the kill branch never runs. The ^C then does NOTHING
// until the #503 wall-time cap fires (120s default). #503 measured exactly
// this shape for `g_bash_alarm` and moved that check to the top of the loop,
// but left `g_interrupted` in the pre-#503 form.
//
// This test is the COMPOSITION of two existing patterns:
//   - the survivor-edge driving from test_gcode_intr_honesty_e2e.js (#509):
//     `kill -INT` at gcode ALONE, so the fg-pgroup SIGINT never reaches the
//     child — and here the chatty producer IS the direct sh (hush runs the
//     echo loop in-process), so it keeps spamming through the ^C;
//   - the chatty-child pattern from test_gcode_timeout_e2e.js round 4
//     (`while true; do echo spam; done`): reads keep succeeding, so an
//     EINTR-only check never fires.
//
// Instruments (before -> after, with GCODE_BASH_SECS=60 bounding the red):
//   wall time kill -INT -> gcode exit: ~60s (the cap, not the ^C, ends the
//     round; the tool_result says "timed out after 60s") -> prompt (<=10s),
//     with the #509 honest ^C message (interrupt + shell killed + caveat).
//   Positive control: round 1's healthy probe posts [exit 0] + PROBE-OK.
//
// Run: node tests/kernel/test_gcode_intr_chatty_e2e.js
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { driveBoot, freshImage, section } = require('./lib/drive.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const { dir: tmp, image } = freshImage('os-gcode-intr-chatty-');
const scriptPath = path.join(tmp, 'script.json');
const bodiesPath = path.join(tmp, 'bodies.jsonl');

fs.writeFileSync(scriptPath, JSON.stringify([
  { kind: 'tool', preface: 'probe.', id: 'toolu_510probe', name: 'bash',
    input: { command: 'echo PROBE-OK' } },
  // The chatty survivor: hush runs the echo loop IN-PROCESS (echo is a
  // builtin), so the direct sh is the producer — reads keep succeeding and
  // the drain loop never parks. kill -INT at gcode alone leaves it spamming.
  { kind: 'tool', preface: 'interrupting.', id: 'toolu_510chatty', name: 'bash',
    input: { command: 'touch /tmp/i510.started; while true; do echo spam; done' } },
]));

(async () => {
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
  const G = `ANTHROPIC_BASE_URL=http://127.0.0.1:${port} ANTHROPIC_API_KEY=test-key gcode --no-color`;

  try {
    const s = driveBoot([
      'echo ==t',
      // GCODE_BASH_SECS=60 bounds the PRE-FIX run (red = the cap returns at
      // ~60s with the timeout message); post-fix the ^C returns in seconds
      // and the cap never fires.
      `GCODE_STATE_DIR=/tmp/i510state GCODE_BASH_SECS=60 ${G} -p "go" >/tmp/g510.out 2>/tmp/g510.err &`,
      'GP=$!',
      'for i in $(seq 1 400); do [ -f /tmp/i510.started ] && break; sleep 0.05; done',  // tool 2 is running (bounded poll, 0155)
      'echo TA=$(date +%s)',
      'kill -INT $GP',
      'wait $GP',
      'echo grc=$?',
      'echo TB=$(date +%s)',
      'echo ==log',
      'cat /tmp/i510state/sessions/*.jsonl',
      'echo ==end',
    ], { image, timeout: 300000 });
    const out = s.stdout;

    const t = section(out, 't');
    const tA = /TA=(\d+)/.exec(t), tB = /TB=(\d+)/.exec(t);
    check('^C kills the chatty sh promptly (no stall to the 60s cap)',
      tA && tB && Number(tB[1]) - Number(tA[1]) <= 10,
      tA && tB ? `${Number(tB[1]) - Number(tA[1])}s` : JSON.stringify(t.slice(0, 200)));
    check('interrupted run exits 0', t.includes('grc=0'), JSON.stringify(t.slice(0, 300)));

    // ---- the persisted tool_result: the ^C message, never the cap's ----
    const log = section(out, 'log');
    const line = log.split('\n').find((l) =>
      l.includes('toolu_510chatty') && l.includes('tool_result')) || '';
    check('interrupted tool_result persisted (instrument sees the line)',
      line.length > 0, JSON.stringify(log.slice(-400)));
    check('tool_result names the interrupt (^C), not the timeout',
      line.includes('interrupted by user (^C)'), JSON.stringify(line.slice(-300)));
    check('tool_result reports the sh kill honestly (shell killed + may-survive caveat)',
      line.includes('shell killed') && line.includes('may still be running'),
      JSON.stringify(line.slice(-300)));
    check('tool_result does NOT carry the timeout message (the ^C ended the round, not the cap)',
      !line.includes('timed out after'), JSON.stringify(line.slice(-300)));
    check('pre-^C output was preserved (spam present)',
      line.includes('spam'), JSON.stringify(line.slice(0, 200)));
    check('tool_result carries the sh\'s real exit (137 = 128+SIGKILL)',
      line.includes('[exit 137]'), JSON.stringify(line.slice(-300)));

    // ---- positive control: a healthy round's tool_result is visible ----
    const bodies = fs.readFileSync(bodiesPath, 'utf8').trim().split('\n');
    check('two POSTs recorded (probe round + its tool_results; none after the ^C)',
      bodies.length === 2, 'got ' + bodies.length);
    check('probe round: [exit 0] + PROBE-OK (positive control)',
      (bodies[1] || '').includes('[exit 0]') && (bodies[1] || '').includes('PROBE-OK'),
      JSON.stringify((bodies[1] || '').slice(0, 300)));
  } finally {
    try { server.kill('SIGKILL'); } catch (e) { /* already gone */ }
  }

  if (failures) { console.log('\n' + failures + ' FAILURE(S)'); process.exit(1); }
  console.log('\nPASS');
})().catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
