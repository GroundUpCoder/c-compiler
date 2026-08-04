#!/usr/bin/env node
// #509 e2e: the bash-tool ^C report is honest in the survivor edge.
//
// The defect (adjacent to #503, same honesty class): after a ^C that
// SIGKILLs the direct sh — the #412(c) survivor edge, driven here exactly
// as test_gcode_step2_e2e.js's t6 leg drives it (`kill -INT` at gcode
// ALONE, so the fg-pgroup SIGINT never reaches the child) — the
// tool_result said
//
//     [command killed: interrupted by user (^C)]
//
// while the sh's own child (sleep 30 here) was still running:
// kill(pid, SIGKILL) reaches only the direct /bin/sh. A model told the
// command died will re-run it concurrently with the survivor — the same
// failure #503 closed for the timeout path. Post-fix the message states
// what actually happened, mirroring #503's wording: the interrupt, the
// shell kill, and that processes it spawned may still be running.
//
// Instrument: the PERSISTED SESSION LOG (GCODE_STATE_DIR), not the POST
// bodies — #412 deliberately sends no tool_results POST after a ^C, so
// the session .jsonl is the surface the model reads on resume. Positive
// control: round 1's healthy probe DOES post, and its [exit 0] + PROBE-OK
// in body[1] proves the instrument chain renders tool results at all.
//
// Run: node tests/kernel/test_gcode_intr_honesty_e2e.js
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

const { dir: tmp, image } = freshImage('os-gcode-intr-honesty-');
const scriptPath = path.join(tmp, 'script.json');
const bodiesPath = path.join(tmp, 'bodies.jsonl');

fs.writeFileSync(scriptPath, JSON.stringify([
  { kind: 'tool', preface: 'probe.', id: 'toolu_509probe', name: 'bash',
    input: { command: 'echo PROBE-OK' } },
  // The survivor: hush runs `sleep 30` as its own child; it inherits the
  // pipe write end and outlives the SIGKILL aimed at the sh.
  { kind: 'tool', preface: 'interrupting.', id: 'toolu_509sleep', name: 'bash',
    input: { command: 'touch /tmp/i509.started; sleep 30' } },
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
      `GCODE_STATE_DIR=/tmp/i509state ${G} -p "go" >/tmp/g509.out 2>/tmp/g509.err &`,
      'GP=$!',
      'for i in $(seq 1 400); do [ -f /tmp/i509.started ] && break; sleep 0.05; done',  // tool 2 is running (bounded poll, 0155)
      'echo TA=$(date +%s)',
      'kill -INT $GP',
      'wait $GP',
      'echo grc=$?',
      'echo TB=$(date +%s)',
      'cat /tmp/g509.out /tmp/g509.err',
      'echo ==log',
      'cat /tmp/i509state/sessions/*.jsonl',
      'echo ==end',
    ], { image, timeout: 300000 });
    const out = s.stdout;

    const t = section(out, 't');
    const tA = /TA=(\d+)/.exec(t), tB = /TB=(\d+)/.exec(t);
    check('interrupted run returned promptly (sh killed, sleep not drained)',
      tA && tB && Number(tB[1]) - Number(tA[1]) <= 10,
      tA && tB ? `${Number(tB[1]) - Number(tA[1])}s` : JSON.stringify(t.slice(0, 200)));
    check('interrupted run exits 0', t.includes('grc=0'), JSON.stringify(t.slice(0, 300)));

    // ---- the honesty assertions, on the persisted tool_result ----
    const log = section(out, 'log');
    const line = log.split('\n').find((l) =>
      l.includes('toolu_509sleep') && l.includes('tool_result')) || '';
    check('interrupted tool_result persisted (instrument sees the line)',
      line.length > 0, JSON.stringify(log.slice(-400)));
    check('tool_result names the interrupt (^C)',
      line.includes('interrupted by user (^C)'), JSON.stringify(line.slice(-300)));
    check('tool_result reports the sh kill honestly (shell killed + may-survive caveat)',
      line.includes('shell killed') && line.includes('may still be running'),
      JSON.stringify(line.slice(-300)));
    check('tool_result never claims a completed kill of the whole command',
      !line.includes('[command killed:'), JSON.stringify(line.slice(-300)));
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
