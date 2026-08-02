#!/usr/bin/env node
// /bin/gcode STEP 2 e2e (todos/0174 step 2): usage accounting + durable
// resumable sessions IN the booted OS image — the runtime half of the
// gcode-step2 branch verification (its deterministic native test is the
// oracle; this proves the same paths against the real compiled binary on
// BlockFS). Deterministic: the scripted fake Anthropic SSE server
// (tests/kernel/lib/fake_anthropic.js) with per-response usage counters,
// no network beyond localhost, no API key.
//
// Legs:
//  - gcode --self-test runs green in-image (canned SSE parse, JSONL
//    ordering, 0600 mode, crash-fragment repair + resume — all on BlockFS).
//  - a real -p run prints session/turn/session-usage lines to stderr and
//    writes a 0600 .jsonl under the gucOS state root
//    (/root/.local/state/gcode/sessions).
//  - -c (continue) and --resume PATH reload it: "resumed" line, message
//    replay visible in the server's request bodies, session usage totals
//    accumulating across processes.
//
// Run: node tests/kernel/test_gcode_step2_e2e.js
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

const { dir: tmp, image } = freshImage('os-gcode2-');
const scriptPath = path.join(tmp, 'script.json');
const bodiesPath = path.join(tmp, 'bodies.jsonl');

// Three one-round text turns with distinct usage so the cross-process
// accumulation is unambiguous: totals 11/7 -> 32/12 -> 63/16.
fs.writeFileSync(scriptPath, JSON.stringify([
  { kind: 'text', text: 'First reply.',
    usage: { input_tokens: 11, output_tokens: 7, cache_creation_input_tokens: 2, cache_read_input_tokens: 3 } },
  { kind: 'text', text: 'Continued reply.',
    usage: { input_tokens: 21, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
  { kind: 'text', text: 'Resumed reply.',
    usage: { input_tokens: 31, output_tokens: 4, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
  // #386: a bash tool whose stdout is NOT valid UTF-8 (lone 0x80, bare 0xC0
  // lead) next to a valid 2-byte é — the scrub must mark the bad bytes and
  // the follow-up request must complete instead of bricking the session.
  { kind: 'tool', preface: 'inspecting', id: 'toolu_386', name: 'bash',
    input: { command: "printf 'caf\\xc3\\xa9 \\x80\\xc0'" } },
  { kind: 'text', text: 'Scrub done.' },
  // #306: a stream that starts (one delta) and never ends — the SIGINT leg
  // must abort it mid-flight; without the xferinfo path this run HANGS.
  { kind: 'stall', text: 'Thinking...' },
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
  // env via hush prefix assignments — the /etc/profile -> ~/.profile
  // plumbing is test_code_e2e.js's coverage, not re-proven here.
  const G = `ANTHROPIC_BASE_URL=http://127.0.0.1:${port} ANTHROPIC_API_KEY=test-key gcode --no-color`;
  const SESS = '/root/.local/state/gcode/sessions';

  try {
    const s = driveBoot([
      // every gcode run 2>&1: the session/usage/resumed lines are stderr,
      // and the assertions below want them inside their stdout section
      'echo ==selftest',
      'gcode --no-color --self-test 2>&1',
      'echo st=$?',
      'echo ==t1',
      `${G} -p "say hi" 2>&1`,
      'echo rc1=$?',
      'echo ==perm',
      `ls -l ${SESS}/`,
      'echo ==log',
      `cat ${SESS}/*.jsonl`,
      'echo ==t2',
      `${G} -c -p "again" 2>&1`,
      'echo rc2=$?',
      'echo ==t3',
      `${G} --resume ${SESS}/*.jsonl -p "once more" 2>&1`,
      'echo rc3=$?',
      // ---- #386: raw high bytes in tool output are scrubbed in-OS ----
      'echo ==t5',
      `${G} --no-persist -p "inspect the rom" 2>&1`,
      'echo rc5=$?',
      // ---- #306: Ctrl+C (SIGINT) aborts an in-flight response ----
      'echo ==t4',
      `${G} -p "interrupt me" >/tmp/g4.out 2>/tmp/g4.err &`,
      'G4=$!',
      'for i in $(seq 1 200); do grep -q Thinking /tmp/g4.out 2>/dev/null && break; sleep 0.05; done',  // stream mid-flight: the delta reached stdout (bounded poll, 0155)
      'kill -INT $G4',
      'wait $G4',
      'echo irc=$?',
      'cat /tmp/g4.out',
      'cat /tmp/g4.err',
      'echo ==end',
    ], { image, timeout: 300000 });
    const out = s.stdout;

    // ---- self-test: the whole canned-SSE + persistence + resume battery ----
    const st = section(out, 'selftest');
    check('in-image self-test PASS', st.includes('gcode self-test: PASS'), JSON.stringify(st.slice(-300)));
    check('in-image self-test exit 0', st.includes('st=0'), JSON.stringify(st.slice(-100)));

    // ---- run 1: fresh session, usage to stderr, JSONL on BlockFS ----
    const t1 = section(out, 't1');
    check('t1: assistant text streamed', t1.includes('First reply.'), JSON.stringify(t1.slice(0, 200)));
    check('t1: session line names the state root',
      /session [0-9a-f]{32}: \/root\/\.local\/state\/gcode\/sessions\/.*\.jsonl/.test(t1), JSON.stringify(t1));
    check('t1: turn usage on stderr',
      t1.includes('turn usage: input=11 output=7 cache-create=2 cache-read=3'), JSON.stringify(t1));
    check('t1: session usage on stderr',
      t1.includes('session usage: input=11 output=7 cache-create=2 cache-read=3'), JSON.stringify(t1));
    check('t1: exit 0', t1.includes('rc1=0'), JSON.stringify(t1));

    const perm = section(out, 'perm');
    check('session log is 0600', /-rw-------.*\.jsonl/.test(perm), JSON.stringify(perm));
    check('exactly one session file', (perm.match(/\.jsonl/g) || []).length === 1, JSON.stringify(perm));

    const log = section(out, 'log');
    for (const t of ['session_meta', 'turn_start', 'message', 'api_round', 'turn_end', 'session_end'])
      check(`log has a ${t} record`, log.includes(`"type":"${t}"`), JSON.stringify(log.slice(0, 300)));
    check('log carries the raw usage pass-through', log.includes('"raw_usage"'), JSON.stringify(log.slice(0, 300)));

    // ---- run 2: -c reloads the latest session in a NEW process ----
    const t2 = section(out, 't2');
    check('t2: resumed line (2 replayed messages)',
      /resumed [0-9a-f]{32} \(2 messages\):/.test(t2), JSON.stringify(t2));
    check('t2: session usage accumulates across processes',
      t2.includes('session usage: input=32 output=12 cache-create=2 cache-read=3'), JSON.stringify(t2));
    check('t2: exit 0', t2.includes('rc2=0'), JSON.stringify(t2));

    // ---- run 3: --resume by explicit path ----
    const t3 = section(out, 't3');
    check('t3: resumed line (4 replayed messages)',
      /resumed [0-9a-f]{32} \(4 messages\):/.test(t3), JSON.stringify(t3));
    check('t3: session usage keeps accumulating',
      t3.includes('session usage: input=63 output=16 cache-create=2 cache-read=3'), JSON.stringify(t3));
    check('t3: exit 0', t3.includes('rc3=0'), JSON.stringify(t3));

    // ---- run 5 (#386): tool output with raw high bytes, in-OS ----
    // busybox printf emits 0x80/0xC0 through the real spawn path; the turn
    // completing (second script entry streamed, exit 0) is the bricked-
    // session regression proof, the trailer the visible-substitution one.
    const t5 = section(out, 't5');
    check('t5: scrub trailer rendered in the tool result',
      t5.includes('replaced 2 invalid UTF-8 bytes with U+FFFD'), JSON.stringify(t5.slice(0, 400)));
    check('t5: follow-up turn completed (session not bricked)',
      t5.includes('Scrub done.'), JSON.stringify(t5.slice(0, 400)));
    check('t5: no HTTP error', !t5.includes('gcode: HTTP'), JSON.stringify(t5.slice(0, 400)));
    check('t5: exit 0', t5.includes('rc5=0'), JSON.stringify(t5));

    // ---- run 4 (#306): SIGINT aborts the in-flight stalled stream ----
    // The stream never ends server-side, so this leg COMPLETING at all is
    // the early-close proof — without the xferinfo abort it hangs into the
    // driveBoot timeout.
    const t4 = section(out, 't4');
    check('t4: stream was mid-flight when killed (delta reached stdout)',
      t4.includes('Thinking...'), JSON.stringify(t4));
    check('t4: SIGINT surfaced as "gcode: interrupted", not a transport error',
      t4.includes('gcode: interrupted') && !t4.includes('transport error'), JSON.stringify(t4));
    check('t4: interrupted run exits 0', t4.includes('irc=0'), JSON.stringify(t4));
    check('session completed', out.includes('==end'), out.slice(-300));

    // ---- server side: the replayed history really reached the API ----
    const bodies = fs.readFileSync(bodiesPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    check('6 requests reached the server', bodies.length === 6, String(bodies.length));
    const flat = (b) => JSON.stringify(b.messages);
    check('request 2 replays turn 1 (user + assistant)',
      bodies[1].messages.length === 3 && flat(bodies[1]).includes('say hi') && flat(bodies[1]).includes('First reply.'),
      flat(bodies[1] || {}).slice(0, 300));
    check('request 3 replays turns 1+2',
      bodies[2].messages.length === 5 && flat(bodies[2]).includes('again') && flat(bodies[2]).includes('Continued reply.'),
      flat(bodies[2] || {}).slice(0, 300));
    // #386: the tool_result that crossed the wire is scrubbed — U+FFFD plus
    // the trailer, with the VALID 2-byte é untouched. bodies[4] is t5's
    // follow-up request (the one that carried the tool_result back).
    {
      const b = bodies[4] || { messages: [] };
      const last = b.messages[b.messages.length - 1] || {};
      const tr = Array.isArray(last.content) ? last.content[0] : null;
      check('#386: wire tool_result carries U+FFFD, the trailer, and the intact é',
        tr && tr.type === 'tool_result' && tr.content.includes('�') &&
        tr.content.includes('[gcode: replaced 2 invalid UTF-8 bytes with U+FFFD]') &&
        tr.content.includes('café'),
        JSON.stringify(tr || {}).slice(0, 300));
    }
  } finally {
    server.kill('SIGKILL');
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nall ok');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
