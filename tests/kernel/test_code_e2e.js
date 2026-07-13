#!/usr/bin/env node
// /bin/code e2e (todos/0174): the agentic coding assistant IN the booted OS
// against a scripted fake Anthropic SSE server (tests/kernel/lib/
// fake_anthropic.js — the standalone twin of os/code/test/smoke.mjs's
// server; the native smoke stays the reference oracle). Deterministic, no
// network beyond localhost, no API key.
//
// Proves the whole 0174 stack: the login-shell env plumbing (pid 1 spawns
// as "-sh" → hush sources the seeded /etc/profile then ~/.profile, where
// ANTHROPIC_* exports live and flow to code via spawn envp inheritance),
// streaming SSE over the 0173 veneer, the tool loop (write_file onto
// BlockFS, the posix_spawn bash tool with merged output + exit code), and
// the tool_result round-trip (asserted from the server's body dump).
//
// Run: node tests/kernel/test_code_e2e.js
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

const { dir: tmp, image } = freshImage('os-code-');
const scriptPath = path.join(tmp, 'script.json');
const bodiesPath = path.join(tmp, 'bodies.jsonl');

// One scripted response per POST, in order: t1 = one text turn; t2 =
// write_file round-trip; t3 = bash-tool round-trip (exit code + stderr merge).
fs.writeFileSync(scriptPath, JSON.stringify([
  { kind: 'text', text: 'Hello from the fake model.' },
  { kind: 'tool', preface: "I'll write it.", id: 'toolu_w1', name: 'write_file',
    input: { path: '/root/from-tool.txt', content: 'hi from tool\n' } },
  { kind: 'text', text: 'Done - file written.' },
  { kind: 'tool', preface: 'running', id: 'toolu_b1', name: 'bash',
    input: { command: 'echo from-bash-tool; echo on-stderr 1>&2; exit 3' } },
  { kind: 'text', text: 'bash done.' },
]));

(async () => {
  // The fake server as its own process — driveBoot is spawnSync and would
  // starve an in-process server's event loop.
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
  const base = `http://127.0.0.1:${port}`;

  try {
    // ---- session 1: prove the seed, plant ~/.profile for session 2 ----
    const s1 = driveBoot([
      'echo ==etc',
      'ls /etc/profile',
      'echo ==probe1',
      'echo v=[$ANTHROPIC_BASE_URL]',
      `echo 'export ANTHROPIC_BASE_URL=${base}' > /root/.profile`,
      "echo 'export ANTHROPIC_API_KEY=test-key' >> /root/.profile",
      'echo ==done1',
    ], { image, timeout: 300000 });
    check('/etc/profile is seeded on a fresh root volume',
      section(s1.stdout, 'etc').includes('/etc/profile'), JSON.stringify(section(s1.stdout, 'etc')));
    check('no ANTHROPIC env before ~/.profile exists',
      section(s1.stdout, 'probe1').includes('v=[]'), JSON.stringify(section(s1.stdout, 'probe1')));
    check('session 1 completed', s1.stdout.includes('==done1'), s1.stdout.slice(-300));

    // ---- session 2: login shell picks up ~/.profile; run the legs ----
    const s2 = driveBoot([
      'echo ==probe2',
      'echo v=[$ANTHROPIC_BASE_URL]',
      'echo ==t1',
      'code -p "say hi" --no-color',
      'echo rc1=$?',
      'echo ==t2',
      'code -p "create the file" --no-color',
      'echo ==t2cat',
      'cat /root/from-tool.txt',
      'echo ==t3',
      'code -p "run the command" --no-color',
      'echo ==end',
    ], { image, timeout: 300000 });
    const out = s2.stdout;

    check('login shell sourced ~/.profile (env visible at the prompt)',
      section(out, 'probe2').includes(`v=[${base}]`), JSON.stringify(section(out, 'probe2')));
    check('t1: assistant text streamed to stdout',
      section(out, 't1').includes('Hello from the fake model.'), JSON.stringify(section(out, 't1').slice(0, 200)));
    check('t1: code exited 0', section(out, 't1').includes('rc1=0'), JSON.stringify(section(out, 't1')));
    check('t2: post-tool text turn arrived',
      section(out, 't2').includes('Done - file written.'), JSON.stringify(section(out, 't2').slice(0, 300)));
    check('t2: write_file landed on BlockFS',
      section(out, 't2cat').includes('hi from tool'), JSON.stringify(section(out, 't2cat')));
    check('t3: bash tool ran and the loop finished',
      section(out, 't3').includes('bash done.'), JSON.stringify(section(out, 't3').slice(0, 300)));
    check('session 2 completed', out.includes('==end'), out.slice(-300));

    // ---- the server-side view: request shape + tool_result round-trip ----
    const bodies = fs.readFileSync(bodiesPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    check('5 requests reached the server', bodies.length === 5, String(bodies.length));
    check('requests set stream:true and send >=5 tools',
      bodies[0].stream === true && Array.isArray(bodies[0].tools) && bodies[0].tools.length >= 5,
      JSON.stringify({ stream: bodies[0].stream, tools: (bodies[0].tools || []).length }));
    const wfres = bodies[2].messages[bodies[2].messages.length - 1].content[0];
    check('write_file tool_result round-trips with matching id',
      wfres && wfres.type === 'tool_result' && wfres.tool_use_id === 'toolu_w1',
      JSON.stringify(wfres));
    const bres = bodies[4].messages[bodies[4].messages.length - 1].content[0];
    check('bash tool_result carries merged stdout+stderr and the exit code',
      bres && bres.tool_use_id === 'toolu_b1'
        && bres.content.includes('[exit 3]')
        && bres.content.includes('from-bash-tool')
        && bres.content.includes('on-stderr'),
      JSON.stringify(bres));
  } finally {
    server.kill('SIGKILL');
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nall ok');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
