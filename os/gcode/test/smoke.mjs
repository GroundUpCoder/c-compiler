// Native smoke test for /bin/gcode (todos/0174) — no network, no API key.
// Starts a scripted fake /v1/messages SSE server, builds gcode.c natively
// (real libcurl + cJSON), and drives it through a text turn and a tool-use
// round-trip. This is the reference-oracle harness; test_code_e2e.js will
// reuse the same server shape against the in-OS build.
//
// Run: node os/gcode/test/smoke.mjs   (exit 0 = pass)

import http from 'node:http';
import { execFileSync, execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const codeDir = path.dirname(here);
const bin = path.join(os.tmpdir(), 'code-smoke-bin');

let failures = 0;
function check(cond, msg) {
  if (cond) { console.log(`  ok   ${msg}`); }
  else { console.log(`  FAIL ${msg}`); failures++; }
}

// ---- SSE builders -----------------------------------------------------
function sse(type, obj) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...obj })}\n\n`;
}
function textResponse(text) {
  return sse('message_start', { message: { id: 'msg_1', role: 'assistant', content: [] } })
    + sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
    + sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text } })
    + sse('content_block_stop', { index: 0 })
    + sse('message_delta', { delta: { stop_reason: 'end_turn' } })
    + sse('message_stop', {});
}
// #738: the shape that 400'd live, 3/3, on api.anthropic.com — a thinking
// block (thinking_delta + signature_delta, and NO text_delta anywhere) then a
// tool_use with no assistant preamble. `thinkingText` of '' is the DEFAULT
// case, not an edge one: thinking.display defaults to "omitted", so a real
// Opus 5 stream carries an empty thinking body and a real signature.
function thinkingToolUseResponse(thinkingText, sig, id, name, inputObj) {
  const json = JSON.stringify(inputObj);
  let out = sse('message_start', { message: { id: 'msg_k', role: 'assistant', content: [] } })
    + sse('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } });
  if (thinkingText) out += sse('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: thinkingText } });
  out += sse('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: sig } })
    + sse('content_block_stop', { index: 0 })
    + sse('content_block_start', { index: 1, content_block: { type: 'tool_use', id, name, input: {} } })
    + sse('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: json } })
    + sse('content_block_stop', { index: 1 })
    + sse('message_delta', { delta: { stop_reason: 'tool_use' } })
    + sse('message_stop', {});
  return out;
}

function toolUseResponse(preface, id, name, inputObj) {
  const json = JSON.stringify(inputObj);
  // split the input json into two partials to exercise accumulation
  const mid = Math.floor(json.length / 2);
  return sse('message_start', { message: { id: 'msg_2', role: 'assistant', content: [] } })
    + sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
    + sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: preface } })
    + sse('content_block_stop', { index: 0 })
    + sse('content_block_start', { index: 1, content_block: { type: 'tool_use', id, name, input: {} } })
    + sse('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: json.slice(0, mid) } })
    + sse('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: json.slice(mid) } })
    + sse('content_block_stop', { index: 1 })
    + sse('message_delta', { delta: { stop_reason: 'tool_use' } })
    + sse('message_stop', {});
}

// A server that shifts one scripted response per POST, recording bodies.
// An entry is an SSE string (200) or { status, body } for an error reply
// (#305: the REPL-survives-a-failed-turn leg).
// #738: the same server, but enforcing the ONE Messages API rule this ticket
// is about — "text content blocks must be non-empty". A fake that accepts a
// body the real API refuses turns the reproduction into a no-op, so the strict
// variant answers an offending request with the REAL 400 wording instead of
// the next script entry. This is what makes the leg a red control: gcode
// before the fix constructs that body and dies here.
function startStrictServer(scripts) {
  return startServer(scripts, (body) => {
    for (const m of body.messages || []) {
      if (!Array.isArray(m.content)) continue;
      for (const b of m.content)
        if (b && b.type === 'text' && b.text === '')
          return { status: 400, body: JSON.stringify({ type: 'error', error: {
            type: 'invalid_request_error',
            message: 'messages: text content blocks must be non-empty' } }) };
    }
    return null;
  });
}

function startServer(scripts, validate) {
  const bodies = [];
  const raw = [];   // request bodies as Buffers — #386 asserts UTF-8 validity byte-level
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      raw.push(buf);
      const parsed = JSON.parse(buf.toString('utf8'));
      bodies.push(parsed);
      const reject = validate ? validate(parsed) : null;
      if (reject) {
        res.writeHead(reject.status, { 'content-type': 'application/json' });
        res.end(reject.body);
        return;
      }
      const body = scripts.shift();
      if (body === undefined) { res.writeHead(500); res.end('no script'); return; }
      if (typeof body === 'object' && body.delay) {   // #507: slow first byte
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end(body.sse);
        }, body.delay);
        return;
      }
      if (typeof body === 'object') {
        res.writeHead(body.status, { 'content-type': 'application/json' });
        res.end(body.body);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(body);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}`, bodies, raw, close: () => server.close() });
    });
  });
}

// #747 made `system` a cacheable block array (a bare JSON string cannot carry
// a cache_control breakpoint). The #530 legs are about the system prompt TEXT,
// not its container, so they read it through here and stay agnostic — and the
// #747 legs assert the container shape directly.
function systemText(body) {
  const sys = body ? body.system : undefined;
  if (typeof sys === 'string') return sys;
  if (Array.isArray(sys)) return sys.map((b) => (b && typeof b.text === 'string') ? b.text : '').join('');
  return '';
}

const execFileAsync = promisify(execFile);
// MUST be async: the fake server shares this process's event loop, so a
// synchronous spawn would deadlock (child waits on a server that can't run).
async function runCode(url, args, env = {}) {
  // detect_leaks=0: the reference build is ASan-instrumented; functional
  // smoke shouldn't gate on leak cleanup (leaks are audited separately).
  const { stdout } = await execFileAsync(bin, args, {
    env: { ...process.env, ANTHROPIC_BASE_URL: url, ANTHROPIC_API_KEY: 'test',
           ASAN_OPTIONS: 'detect_leaks=0', ...env },
    encoding: 'utf8',
    timeout: 15000,
  });
  return stdout;
}

// Like runCode but returns BOTH streams (presentation lives on stderr: the
// prompt, tool blocks, Cost line, and the diff renderer). cwd is the #530
// walk-up seam — the context legs pin it to a fixture directory.
async function runCodeBoth(url, args, env = {}, cwd = undefined) {
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      env: { ...process.env, ANTHROPIC_BASE_URL: url, ANTHROPIC_API_KEY: 'test',
             ASAN_OPTIONS: 'detect_leaks=0', ...env },
      encoding: 'utf8', timeout: 15000, cwd,
    });
    return { stdout, stderr };
  } catch (e) {
    return { stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

async function main() {
  // Build the native binary.
  execFileSync('sh', [path.join(codeDir, 'build-native.sh'), bin], { stdio: 'inherit' });

  // ---- test 1: plain text turn --------------------------------------
  {
    const srv = await startServer([textResponse('Hello from the fake model.')]);
    const out = await runCode(srv.url, ['-p', 'say hi', '--no-color']);
    srv.close();
    check(out.includes('Hello from the fake model.'), 'text turn streams assistant text to stdout');
    check(srv.bodies[0].stream === true, 'request sets stream:true');
    check(Array.isArray(srv.bodies[0].tools) && srv.bodies[0].tools.length >= 5, 'tools are sent (>=5)');
  }

  // ---- test 2: tool-use round-trip (write_file) ---------------------
  {
    const target = path.join(os.tmpdir(), `code-smoke-${process.pid}.txt`);
    fs.rmSync(target, { force: true });
    const srv = await startServer([
      toolUseResponse("I'll write it.", 'toolu_1', 'write_file', { path: target, content: 'hi from tool\n' }),
      textResponse('Done — file written.'),
    ]);
    const out = await runCode(srv.url, ['-p', `create ${target}`, '--no-color']);
    srv.close();
    check(fs.existsSync(target), 'write_file tool actually created the file');
    check(fs.existsSync(target) && fs.readFileSync(target, 'utf8') === 'hi from tool\n', 'file has the tool-provided content');
    check(out.includes('Done — file written.'), 'second turn (post tool_result) text appears');
    // second request must carry the tool_result back with matching id
    const second = srv.bodies[1];
    const lastMsg = second.messages[second.messages.length - 1];
    const tr = lastMsg.content && lastMsg.content[0];
    check(tr && tr.type === 'tool_result' && tr.tool_use_id === 'toolu_1', 'tool_result round-trips with matching tool_use_id');
    check(second.messages.some((m) => m.role === 'assistant' && Array.isArray(m.content)
      && m.content.some((b) => b.type === 'tool_use' && b.name === 'write_file')),
      'assistant tool_use block echoed back in history');
    // #348: `messages` is attached to the request BY REFERENCE, so record
    // metadata (model/stop_reason/usage) must never land on the message
    // object itself — the echoed assistant turn carries ONLY role+content.
    const echoed = second.messages.filter((m) => m.role === 'assistant');
    check(echoed.length > 0 && echoed.every((m) => Object.keys(m).sort().join(',') === 'content,role'),
      '#348: history assistant messages carry only role+content (no record metadata in the payload)');
    fs.rmSync(target, { force: true });
  }

  // ---- test 3: bash tool output cap ---------------------------------
  {
    const srv = await startServer([
      toolUseResponse('running', 'toolu_2', 'bash', { command: 'yes ABCDEFGH | head -c 200000' }),
      textResponse('capped ok'),
    ]);
    await runCode(srv.url, ['-p', 'flood', '--no-color']);
    srv.close();
    const second = srv.bodies[1];
    const tr = second.messages[second.messages.length - 1].content[0];
    check(tr.content.length < 30000, `bash output capped (${tr.content.length} bytes < 30k)`);
    check(tr.content.includes('truncated'), 'bash output carries a truncation marker');
  }

  // ---- test 4 (#305): interactive REPL survives a failed turn -------
  // First send hits an HTTP 500 (recoverable), second must succeed in the
  // SAME process; /quit ends it cleanly. The failed user message stays in
  // history, so request 2 carries BOTH user messages.
  {
    const srv = await startServer([
      { status: 500, body: '{"type":"error","error":{"type":"api_error","message":"boom"}}' },
      textResponse('Recovered reply.'),
    ]);
    const child = spawn(bin, ['--no-color', '--no-persist'], {
      env: { ...process.env, ANTHROPIC_BASE_URL: srv.url, ANTHROPIC_API_KEY: 'test',
             ASAN_OPTIONS: 'detect_leaks=0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    child.stdin.write('first ask\nsecond ask\n/quit\n');
    child.stdin.end();
    const code = await new Promise((resolve, reject) => {
      const t = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('REPL leg timed out')); }, 15000);
      child.on('exit', (c) => { clearTimeout(t); resolve(c); });
    });
    srv.close();
    check(err.includes('HTTP 500'), 'failed turn printed its HTTP error');
    check(out.includes('Recovered reply.'), 'REPL survived the error: second send succeeded in the same process');
    check(srv.bodies.length === 2, `both sends reached the server (${srv.bodies.length})`);
    const users = (srv.bodies[1] ? srv.bodies[1].messages : [])
      .filter((m) => m.role === 'user')
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));
    check(users.length === 2 && users[0].includes('first ask') && users[1].includes('second ask'),
      'failed user message stays in history (request 2 carries both sends)');
    check(code === 0, `/quit after recovery exits 0 (got ${code})`);
  }

  // ---- test 5 (#302): chat-style layout + per-turn Cost -------------
  // Default (no --no-color): stdout is a pipe here, so the isatty gate
  // (#303) turns colour off — the layout must still be a speaker header +
  // an indented body, and the Cost line must be priced from the counters.
  {
    const srv = await startServer([textResponse('Line one.\nLine two.')]);
    const { stdout, stderr } = await runCodeBoth(srv.url, ['-p', 'hi']);
    srv.close();
    check(stdout.includes('gcode:'), '#302: assistant speaker header on stdout');
    check(stdout.includes('  Line one.') && stdout.includes('  Line two.'),
      '#302: assistant body indented 2 spaces');
    check(!stdout.includes('\x1b['), '#303: piped stdout carries no ANSI escapes (isatty gate)');
    check(/cost: \$\d/.test(stderr), '#302: per-turn Cost line, priced from the token counters');
  }

  // ---- test 6 (#302): coloured diff renderer for edit_file ----------
  {
    const target = path.join(os.tmpdir(), `code-diff-${process.pid}.txt`);
    fs.writeFileSync(target, 'alpha\nOLDLINE\ngamma\n');
    const srv = await startServer([
      toolUseResponse('editing', 'toolu_e', 'edit_file',
        { path: target, old_string: 'OLDLINE', new_string: 'NEWLINE' }),
      textResponse('edited ok'),
    ]);
    const { stderr } = await runCodeBoth(srv.url, ['-p', `edit ${target}`, '--no-color']);
    srv.close();
    check(fs.readFileSync(target, 'utf8').includes('NEWLINE'), 'edit_file applied the change');
    check(stderr.includes('Diff') && stderr.includes('- OLDLINE') && stderr.includes('+ NEWLINE'),
      '#302: diff renderer shows removed (-) and added (+) lines');
    fs.rmSync(target, { force: true });
  }

  // ---- test 7 (#303): --color forces ANSI even down a pipe ----------
  {
    const srv = await startServer([textResponse('forced colour')]);
    const { stdout } = await runCodeBoth(srv.url, ['-p', 'hi', '--color']);
    srv.close();
    check(stdout.includes('\x1b['), '#303: --color forces ANSI on a non-tty stdout');
  }

  // ---- test 8 (#348 display slice): provider-returned model line ----
  // The turn summary must name the model the PROVIDER returned, labelling
  // the requested alias only when it differs; a stream with no model in
  // message_start falls back to the requested name (never "(null)").
  {
    const withModel = (model, text) =>
      sse('message_start', { message: { id: 'msg_m', model, usage: { input_tokens: 5, output_tokens: 0 } } })
      + sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
      + sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text } })
      + sse('content_block_stop', { index: 0 })
      + sse('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } })
      + sse('message_stop', {});

    let srv = await startServer([withModel('actual-model-9', 'mapped')]);
    let r = await runCodeBoth(srv.url, ['-p', 'hi', '--no-color', '--model', 'requested-alias']);
    srv.close();
    check(r.stderr.includes('turn model: actual-model-9 (requested requested-alias)'),
      '#348: turn line shows the RETURNED model, requested alias secondary');

    srv = await startServer([withModel('same-model', 'equal')]);
    r = await runCodeBoth(srv.url, ['-p', 'hi', '--no-color', '--model', 'same-model']);
    srv.close();
    check(r.stderr.includes('turn model: same-model') && !r.stderr.includes('(requested'),
      '#348: equal models print ONE name, not the same string twice');

    srv = await startServer([textResponse('plain')]);
    r = await runCodeBoth(srv.url, ['-p', 'hi', '--no-color', '--model', 'fallback-model']);
    srv.close();
    check(r.stderr.includes('turn model: fallback-model') && !r.stderr.includes('(null)'),
      '#348: no model in message_start falls back to the requested name');

    // Mixed-model turn: round 1 (tool_use) runs on a priced model, round 2
    // on an unknown one — the cost line must price each round with its own
    // model and mark the unpriced rounds instead of understating silently.
    const mixedRound1 = sse('message_start', { message: { id: 'msg_r1', model: 'claude-opus-5', usage: { input_tokens: 10, output_tokens: 0 } } })
      + sse('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'toolu_m', name: 'bash', input: {} } })
      + sse('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"true"}' } })
      + sse('content_block_stop', { index: 0 })
      + sse('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 2 } })
      + sse('message_stop', {});
    srv = await startServer([mixedRound1, withModel('mystery-model-x', 'done')]);
    r = await runCodeBoth(srv.url, ['-p', 'mixed', '--no-color', '--model', 'claude-opus-5']);
    srv.close();
    check(r.stderr.includes('rounds: 2'), '#348: multi-round turn reports its API-round count');
    check(/turn cost: \$\d+\.\d{6}  \(1 round unpriced: mystery-model-x\)/.test(r.stderr),
      '#348: mixed turn prices known rounds and names the unpriced model explicitly');
  }

  // ---- test 9 (#386): non-UTF-8 tool output is scrubbed, never POSTed ----
  // A bash tool emits a lone continuation byte (0x80), a bare 0xC0 lead and
  // a truncated 3-byte sequence (0xE2 0x82) next to a VALID 2-byte é. The
  // follow-up request body must be valid UTF-8 at the BYTE level (pre-fix
  // the raw bytes ride through and this decode throws), the bad bytes must
  // surface as U+FFFD plus the visible replacement trailer, and the valid
  // sequence must survive untouched.
  {
    const srv = await startServer([
      toolUseResponse('inspecting', 'toolu_386', 'bash',
        { command: "printf 'caf\\xc3\\xa9 \\x80\\xc0 tail\\xe2\\x82'" }),
      textResponse('Scrubbed ok.'),
    ]);
    const { stdout } = await runCodeBoth(srv.url, ['-p', 'inspect the rom', '--no-color', '--no-persist']);
    srv.close();
    check(srv.bodies.length === 2, `#386: both requests reached the server (${srv.bodies.length})`);
    let valid = true;
    try { new TextDecoder('utf-8', { fatal: true }).decode(srv.raw[1] || Buffer.alloc(0)); }
    catch { valid = false; }
    check(valid, '#386: follow-up request body is valid UTF-8 at the byte level');
    const tr = srv.bodies[1].messages[srv.bodies[1].messages.length - 1].content[0];
    check(tr && tr.type === 'tool_result' && tr.content.includes('�'),
      '#386: bad bytes became U+FFFD in the tool_result');
    check(tr && tr.content.includes('[gcode: replaced 4 invalid UTF-8 bytes with U+FFFD]'),
      '#386: the substitution is announced in the tool_result itself');
    check(tr && tr.content.includes('café'), '#386: valid multi-byte sequences pass through untouched');
    check(stdout.includes('Scrubbed ok.'), '#386: the turn completes (no 400, session not bricked)');
  }

  // ---- test 10 (#387): a body-parse 400 is permanent, and diagnosable ----
  // Same REPL shape as test 4, but the first send gets HTTP 400: unlike the
  // 500 there, gcode must NOT return to the prompt — the poisoned history
  // would be re-sent identically forever — so the second ask never reaches
  // the server. The error line must carry model, base_url and payload size.
  {
    const srv = await startServer([
      { status: 400, body: '{"detail":"There was an error parsing the body"}' },
      textResponse('never reached'),
    ]);
    const child = spawn(bin, ['--no-color', '--no-persist', '--model', 'test-model-387'], {
      env: { ...process.env, ANTHROPIC_BASE_URL: srv.url, ANTHROPIC_API_KEY: 'test',
             ASAN_OPTIONS: 'detect_leaks=0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let err = '';
    child.stderr.on('data', (c) => (err += c));
    child.stdin.write('first ask\nsecond ask\n/quit\n');
    child.stdin.end();
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('400 leg timed out')); }, 15000);
      child.on('exit', () => { clearTimeout(t); resolve(); });
    });
    srv.close();
    check(err.includes('HTTP 400'), '#387: the 400 printed its HTTP error');
    check(err.includes('test-model-387') && err.includes(srv.url) && /payload \d+ bytes/.test(err),
      '#387: error line names model, base_url and payload size');
    check(err.includes('retrying cannot succeed'), '#387: 400 is reported as non-retryable');
    check(srv.bodies.length === 1, `#387: session ended — second ask never sent (${srv.bodies.length} requests)`);
  }

  // ---- test 11 (#387): a poisoned history fails LOCALLY, before the POST --
  // A hand-crafted session log (the pre-#386 world) carries a tool_result
  // with a raw 0x80; --resume replays it, and the pre-POST guard must
  // refuse to send: zero requests reach the server, the message names the
  // byte offset and the poisoned tool_use_id.
  {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcode-387-'));
    const sessDir = path.join(stateDir, 'sessions');
    fs.mkdirSync(sessDir, { recursive: true });
    const sessPath = path.join(sessDir, '20260802T000000Z_00112233445566778899aabbccddeeff.jsonl');
    const lines = [
      '{"schema_version":1,"type":"session_meta","session_id":"00112233445566778899aabbccddeeff","model":"m","base_url":"u","system_prompt_hash":"h","cwd":"/"}',
      '{"type":"message","role":"user","content":[{"type":"text","text":"inspect the rom"}]}',
      '{"type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_poison","name":"bash","input":{}}]}',
      '{"type":"message","role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_poison","content":"title: \x80"}]}',
    ];
    fs.writeFileSync(sessPath, Buffer.from(lines.join('\n') + '\n', 'latin1'));
    const srv = await startServer([textResponse('must not be reached')]);
    const { stderr } = await runCodeBoth(srv.url, ['--resume', sessPath, '-p', 'go', '--no-color'],
      { GCODE_STATE_DIR: stateDir });
    srv.close();
    check(srv.bodies.length === 0, `#387: nothing was POSTed (${srv.bodies.length} requests)`);
    check(/not valid UTF-8 at byte \d+/.test(stderr), '#387: local failure names the byte offset');
    check(stderr.includes('toolu_poison'), '#387: local failure names the poisoned tool_result');
    check(stderr.includes('retrying cannot succeed'), '#387: local failure says retrying cannot succeed');
    fs.rmSync(stateDir, { recursive: true, force: true });
  }

  // ---- test 12 (#462): a max_tokens cut must NOT brick the session ------
  // gcode used to pair tool_use with tool_result off `stop_reason` instead of
  // off message SHAPE: the assistant message (tool_use blocks included) was
  // appended unconditionally, but the matching tool_results were appended ONLY
  // when stop_reason == "tool_use" and otherwise cJSON_Delete'd — after the
  // tools had already run. A turn that ended `max_tokens` therefore left a
  // DANGLING tool_use, every later request 400'd, and gcode exited the REPL.
  //
  // Every check below except the two labelled "negative control" FAILS on the
  // pre-fix binary. The pre-fix behaviour is recorded per leg.
  {
    const tmp = os.tmpdir();
    const tag = `gcode-462-${process.pid}`;

    // -- leg A: truncated mid-input_json_delta of a write_file call --------
    // Pre-fix: the partial JSON fails cJSON_Parse, is replaced by {}, and the
    // tool RUNS anyway (jku's confusing "needs 'path' and 'content'"); the
    // results are then deleted and the turn ends -> ONE request.
    {
      const target = path.join(tmp, `${tag}-a.txt`);
      fs.rmSync(target, { force: true });
      const full = JSON.stringify({ path: target, content: 'x'.repeat(64) });
      const cutMidJson =
        sse('message_start', { message: { id: 'msg_462a', model: 'trunc-model', usage: { input_tokens: 9, output_tokens: 0 } } })
        + sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
        + sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: "I'll write the file." } })
        + sse('content_block_stop', { index: 0 })
        + sse('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'toolu_462a', name: 'write_file', input: {} } })
        // cut here: an unterminated JSON fragment, exactly as the cap leaves it
        + sse('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: full.slice(0, 25) } })
        + sse('message_delta', { delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 512 } })
        + sse('message_stop', {});

      const stateDir = fs.mkdtempSync(path.join(tmp, 'gcode-462a-'));
      const srv = await startServer([cutMidJson, textResponse('Retried smaller — done.')]);
      const { stdout } = await runCodeBoth(srv.url, ['-p', 'write the file', '--no-color', '--max-tokens', '4096'],
        { GCODE_STATE_DIR: stateDir });
      srv.close();

      check(srv.bodies.length === 2,
        `#462: the turn CONTINUED after the cut so the model can retry smaller (${srv.bodies.length} requests, pre-fix 1)`);

      // The API contract: an assistant message carrying tool_use must be
      // followed IMMEDIATELY by a user message carrying the matching results.
      const apiValid = (msgs) => {
        for (let i = 0; i < msgs.length; i++) {
          const uses = (Array.isArray(msgs[i].content) ? msgs[i].content : [])
            .filter((b) => b.type === 'tool_use').map((b) => b.id);
          if (!uses.length) continue;
          const next = msgs[i + 1];
          const got = (next && Array.isArray(next.content) ? next.content : [])
            .filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id);
          if (next?.role !== 'user' || uses.some((id) => !got.includes(id))) return false;
        }
        return true;
      };
      const sent = srv.bodies[1] ? srv.bodies[1].messages : [];
      check(sent.length > 0 && apiValid(sent),
        '#462: in-memory history is API-valid — every tool_use id has a tool_result in the very next message');

      const tr = sent.flatMap((m) => (Array.isArray(m.content) ? m.content : []))
        .find((b) => b.type === 'tool_result' && b.tool_use_id === 'toolu_462a');
      check(!!tr, '#462: the truncated call still got a tool_result (pre-fix it was deleted)');
      check(!!tr && tr.content.includes('TRUNCATED') && tr.content.includes('NOT executed'),
        '#462: the tool_result explains the truncation instead of a confusing tool error');
      check(!!tr && tr.content.includes('4096'),
        '#462: the tool_result names the actual max_tokens cap in force');

      // The PERSISTED log is a separate code path (persist_assistant_message is
      // unconditional, persist_message(..., "tool") was inside the stop_reason
      // branch) — a fixture that checked only the array would pass while
      // --resume stayed broken.
      const logFile = fs.readdirSync(path.join(stateDir, 'sessions')).filter((f) => f.endsWith('.jsonl'))[0];
      const records = fs.readFileSync(path.join(stateDir, 'sessions', logFile), 'utf8')
        .split('\n').filter(Boolean).map((l) => JSON.parse(l));
      const logged = records.filter((r) => r.type === 'message')
        .map((r) => ({ role: r.role, content: r.content }));
      check(apiValid(logged),
        '#462: the PERSISTED log is API-valid too — --resume replays a history the server accepts');
      check(logged.some((m) => (m.content || []).some((b) => b.type === 'tool_result' && b.tool_use_id === 'toolu_462a')),
        '#462: the tool_result was persisted, not just held in memory');

      check(stdout.includes('Retried smaller — done.'), '#462: the session survives the cut and completes');
      fs.rmSync(target, { force: true });
      fs.rmSync(stateDir, { recursive: true, force: true });
    }

    // -- leg B: cut at a block boundary, so the partial JSON PARSES ---------
    // Blocks stream in order, so under max_tokens only the LAST one can be
    // cut. Pre-fix BOTH bash calls run (the second is the live hazard: a
    // half-specified command executing).
    {
      const ranA = path.join(tmp, `${tag}-ran-a`);
      const ranB = path.join(tmp, `${tag}-ran-b`);
      fs.rmSync(ranA, { force: true }); fs.rmSync(ranB, { force: true });
      const twoCalls =
        sse('message_start', { message: { id: 'msg_462b', model: 'trunc-model', usage: { input_tokens: 9, output_tokens: 0 } } })
        + sse('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'toolu_462b0', name: 'bash', input: {} } })
        + sse('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command: `touch ${ranA}` }) } })
        + sse('content_block_stop', { index: 0 })
        + sse('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'toolu_462b1', name: 'bash', input: {} } })
        + sse('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command: `touch ${ranB}` }) } })
        + sse('message_delta', { delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 512 } })
        + sse('message_stop', {});

      const srv = await startServer([twoCalls, textResponse('ok')]);
      await runCodeBoth(srv.url, ['-p', 'run both', '--no-color', '--no-persist']);
      srv.close();

      // NEGATIVE CONTROL: earlier blocks are complete and must still run
      // (this one passes before AND after the fix, by design).
      check(fs.existsSync(ranA),
        '#462 negative control: an earlier, complete tool call in the same round still RUNS');
      check(!fs.existsSync(ranB),
        '#462: the LAST block under max_tokens is refused even though its JSON parses (pre-fix it executed)');
      const results = (srv.bodies[1] ? srv.bodies[1].messages : [])
        .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
        .filter((b) => b.type === 'tool_result');
      check(results.some((b) => b.tool_use_id === 'toolu_462b0') && results.some((b) => b.tool_use_id === 'toolu_462b1'),
        '#462: BOTH calls are paired — the refused one carries a marker result, never a dropped block');
      fs.rmSync(ranA, { force: true }); fs.rmSync(ranB, { force: true });
    }

    // -- leg C: a compat shim that returns end_turn alongside tool calls ----
    // The DeepSeek-class provider named in the diagnosis. Pairing is keyed on
    // SHAPE, so this round completes instead of discarding its tool output.
    {
      const target = path.join(tmp, `${tag}-c.txt`);
      fs.rmSync(target, { force: true });
      const endTurnWithTool =
        sse('message_start', { message: { id: 'msg_462c', model: 'shim-model', usage: { input_tokens: 9, output_tokens: 0 } } })
        + sse('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'toolu_462c', name: 'write_file', input: {} } })
        + sse('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ path: target, content: 'shim\n' }) } })
        + sse('content_block_stop', { index: 0 })
        + sse('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 12 } })
        + sse('message_stop', {});

      const srv = await startServer([endTurnWithTool, textResponse('Shim round completed.')]);
      const { stdout } = await runCodeBoth(srv.url, ['-p', 'shim', '--no-color', '--no-persist']);
      srv.close();
      check(srv.bodies.length === 2,
        `#462: end_turn alongside a tool call still completes the round (${srv.bodies.length} requests, pre-fix 1)`);
      const tr = (srv.bodies[1] ? srv.bodies[1].messages : [])
        .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
        .find((b) => b.type === 'tool_result' && b.tool_use_id === 'toolu_462c');
      check(!!tr, '#462: a shim end_turn no longer leaves a dangling tool_use');
      check(stdout.includes('Shim round completed.'), '#462: the shim round reaches its follow-up turn');
      fs.rmSync(target, { force: true });
    }

    // -- leg D: the truncation-continuation cap, and it says why -----------
    // Independent of --max-turns (unlimited here, #353). Four truncated
    // rounds: three continuations, then a loud stop.
    {
      const target = path.join(tmp, `${tag}-d.txt`);
      const full = JSON.stringify({ path: target, content: 'y'.repeat(64) });
      const cut = (n) =>
        sse('message_start', { message: { id: `msg_462d${n}`, model: 'trunc-model', usage: { input_tokens: 3, output_tokens: 0 } } })
        + sse('content_block_start', { index: 0, content_block: { type: 'tool_use', id: `toolu_462d${n}`, name: 'write_file', input: {} } })
        + sse('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: full.slice(0, 25) } })
        + sse('message_delta', { delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 512 } })
        + sse('message_stop', {});

      const srv = await startServer([cut(1), cut(2), cut(3), cut(4)]);
      const { stderr } = await runCodeBoth(srv.url, ['-p', 'storm', '--no-color', '--no-persist']);
      srv.close();
      check(srv.bodies.length === 4,
        `#462: a truncation storm stops after 3 consecutive continuations (${srv.bodies.length} requests, pre-fix 1)`);
      check(/consecutive rounds ended in an unusable tool call/.test(stderr)
        && /max_tokens cap/.test(stderr),
        '#462: hitting the truncation cap PRINTS why — never a silent turn-budget burn');
      check(stderr.includes('--max-tokens'),
        '#462: the give-up line names the fix (raise the cap)');
      fs.rmSync(target, { force: true });
    }

    // -- leg F (#462 review): malformed args are NOT a max_tokens truncation
    // Unparseable tool arguments on a stop reason that is not max_tokens are a
    // MALFORMED stream. Refusing to execute is right either way, but reporting
    // it as "truncated at the max_tokens cap" would send the next debugger
    // into the cap code for a problem that has nothing to do with it.
    {
      const bad =
        sse('message_start', { message: { id: 'msg_462f', model: 'malformed-model', usage: { input_tokens: 4, output_tokens: 0 } } })
        + sse('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'toolu_462f', name: 'bash', input: {} } })
        + sse('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"command": "echo oops' } })
        + sse('content_block_stop', { index: 0 })
        + sse('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } })
        + sse('message_stop', {});

      const srv = await startServer([bad, textResponse('recovered')]);
      const { stderr } = await runCodeBoth(srv.url, ['-p', 'malformed', '--no-color', '--no-persist']);
      srv.close();
      const tr = (srv.bodies[1] ? srv.bodies[1].messages : [])
        .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
        .find((b) => b.type === 'tool_result' && b.tool_use_id === 'toolu_462f');
      check(!!tr && tr.content.includes('MALFORMED') && !tr.content.includes('TRUNCATED'),
        '#462: unparseable args on end_turn are reported as MALFORMED, not as a max_tokens truncation');
      check(!!tr && tr.content.includes('end_turn'),
        '#462: the malformed result names the actual stop_reason it arrived with');
      check(/malformed tool arguments \(stop_reason end_turn\)/.test(stderr),
        '#462: the console line attributes the cause correctly too');
      check(!!tr && tr.content.includes('NOT executed'),
        '#462 negative control: a call with unreadable arguments is still refused, whatever the cause');
    }

    // -- leg E: the cap itself — default, env override, clamp, --help ------
    {
      const srv = await startServer([textResponse('cap ok'), textResponse('cap ok')]);
      let r = await runCodeBoth(srv.url, ['-p', 'hi', '--no-color', '--no-persist']);
      check(srv.bodies[0] && srv.bodies[0].max_tokens === 32768,
        `#462: default max_tokens is 32768, not 4096 (got ${srv.bodies[0] && srv.bodies[0].max_tokens})`);

      r = await runCodeBoth(srv.url, ['-p', 'hi', '--no-color', '--no-persist', '--max-tokens', '999999']);
      srv.close();
      check(srv.bodies[1] && srv.bodies[1].max_tokens === 128000,
        `#462: an out-of-range cap is CLAMPED, never posted as-is (got ${srv.bodies[1] && srv.bodies[1].max_tokens})`);
      check(/clamped to 128000/.test(r.stderr), '#462: the clamp is announced, not silent');

      const help = execFileSync(bin, ['--help'], { encoding: 'utf8', env: { ...process.env, ASAN_OPTIONS: 'detect_leaks=0' } });
      check(help.includes('ANTHROPIC_MAX_TOKENS'), '#462: --help documents the ANTHROPIC_MAX_TOKENS override');

      const srv2 = await startServer([textResponse('env ok')]);
      await runCodeBoth(srv2.url, ['-p', 'hi', '--no-color', '--no-persist'], { ANTHROPIC_MAX_TOKENS: '16384' });
      srv2.close();
      check(srv2.bodies[0] && srv2.bodies[0].max_tokens === 16384,
        `#462: ANTHROPIC_MAX_TOKENS is honoured (got ${srv2.bodies[0] && srv2.bodies[0].max_tokens})`);
    }
  }

  // ---- test 13 (#463): recover from a history that is ALREADY invalid ----
  // #462 stops gcode CREATING a dangling tool_use. This is the other half:
  // a log poisoned by the shipped bug (jku's 900k-token session is one) or
  // torn by a crash between the assistant record and its results is loaded
  // by --resume and must be REPAIRED at the send seam, not refused.
  //
  // The fake server accepts anything, so "it did not crash" proves nothing
  // here: every leg asserts the SENT BODY is API-valid, which is the property
  // the real provider enforces with a 400. Legs A/B/E/F FAIL on the pre-fix
  // binary; C/D are labelled negative controls and pass on both.
  {
    const META = '{"schema_version":1,"type":"session_meta","session_id":"463463463463463463463463463463ab","model":"m","base_url":"u","system_prompt_hash":"h","cwd":"/"}';
    // Mirror of history_is_valid() in gcode.c: every tool_use answered in the
    // message immediately after it, and no tool_result answering anything else.
    function historyFaults(messages) {
      const faults = [];
      const uses = (m) => (m && m.role === 'assistant' && Array.isArray(m.content)
        ? m.content.filter((b) => b.type === 'tool_use') : []);
      messages.forEach((m, i) => {
        const next = messages[i + 1];
        for (const u of uses(m)) {
          const answers = (next && next.role === 'user' && Array.isArray(next.content))
            ? next.content.filter((b) => b.type === 'tool_result' && b.tool_use_id === u.id) : [];
          if (!answers.length) faults.push(`dangling tool_use ${u.id}`);
        }
        const prevUses = uses(messages[i - 1]).map((u) => u.id);
        for (const b of (Array.isArray(m.content) ? m.content : []))
          if (b.type === 'tool_result' && !prevUses.includes(b.tool_use_id))
            faults.push(`orphan tool_result ${b.tool_use_id}`);
      });
      return faults;
    }
    function writeLog(tag, lines) {
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), `gcode-463-${tag}-`));
      const sessDir = path.join(stateDir, 'sessions');
      fs.mkdirSync(sessDir, { recursive: true });
      const sessPath = path.join(sessDir, '20260804T000000Z_463463463463463463463463463463ab.jsonl');
      fs.writeFileSync(sessPath, [META, ...lines].join('\n') + '\n');
      return { stateDir, sessPath };
    }

    // -- leg A: the #462 incident's exact poisoned log ---------------------
    // assistant(tool_use) with NO tool_result, then the user's next question.
    // PRE-FIX: gcode replays it verbatim and POSTs a body with a dangling
    // tool_use — the body the real API answers with the 400 that killed the
    // session. The repair inserts a marker result ahead of the user's text.
    {
      const { stateDir, sessPath } = writeLog('a', [
        '{"type":"message","role":"user","content":[{"type":"text","text":"write the file"}]}',
        '{"type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_463dangle","name":"write_file","input":{}}]}',
        '{"type":"message","role":"user","content":[{"type":"text","text":"what happened?"}]}',
      ]);
      const before = fs.readFileSync(sessPath, 'utf8');
      const srv = await startServer([textResponse('repaired and answered.')]);
      const { stdout, stderr } = await runCodeBoth(srv.url, ['--resume', sessPath, '-p', 'go', '--no-color'],
        { GCODE_STATE_DIR: stateDir });
      srv.close();
      const sent = srv.bodies[0] ? srv.bodies[0].messages : [];
      const faults = historyFaults(sent);
      check(srv.bodies.length === 1, `#463: the poisoned resume still SENT (${srv.bodies.length} requests)`);
      check(faults.length === 0, `#463: the SENT history is API-valid — every tool_use answered (faults: ${faults.join('; ') || 'none'})`);
      const marker = sent.flatMap((m) => (Array.isArray(m.content) ? m.content : []))
        .find((b) => b.type === 'tool_result' && b.tool_use_id === 'toolu_463dangle');
      check(!!marker && /session repaired/.test(marker.content),
        '#463: the inserted result is the VISIBLE marker, not a plausible fake result');
      check(/repaired the message history/.test(stderr) && stderr.includes('toolu_463dangle'),
        '#463: the repair is LOUD and names the id it repaired');
      check(stdout.includes('repaired and answered.'), '#463: the session continued instead of exiting');
      // Deliberately NOT persisted: the JSONL is append-only, so a dropped
      // orphan could never be un-written and the log would disagree with
      // memory. The pass is deterministic, so every load re-derives it.
      check(fs.readFileSync(sessPath, 'utf8').startsWith(before),
        '#463: the repair is applied in memory — the on-disk log is only appended to, never rewritten');
      fs.rmSync(stateDir, { recursive: true, force: true });
    }

    // -- leg B: the REVERSE orphan --------------------------------------
    // A tool_result answering no tool_use is just as fatal as a dangling
    // tool_use — repairing only the forward half trades one 400 for another.
    {
      const { stateDir, sessPath } = writeLog('b', [
        '{"type":"message","role":"user","content":[{"type":"text","text":"hello"}]}',
        '{"type":"message","role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_463orphan","content":"stranded"}]}',
      ]);
      const srv = await startServer([textResponse('orphan dropped.')]);
      const { stdout, stderr } = await runCodeBoth(srv.url, ['--resume', sessPath, '-p', 'go', '--no-color'],
        { GCODE_STATE_DIR: stateDir });
      srv.close();
      const sent = srv.bodies[0] ? srv.bodies[0].messages : [];
      check(historyFaults(sent).length === 0,
        `#463: the reverse orphan is repaired too (faults: ${historyFaults(sent).join('; ') || 'none'})`);
      check(!JSON.stringify(sent).includes('toolu_463orphan'),
        '#463: the stranded tool_result is DROPPED, not answered with an invented tool_use');
      check(/orphan tool_result/.test(stderr) && stderr.includes('toolu_463orphan'),
        '#463: the drop is announced and names the orphan id');
      check(stdout.includes('orphan dropped.'), '#463: the session continued after the orphan repair');
      fs.rmSync(stateDir, { recursive: true, force: true });
    }

    // -- leg C (NEGATIVE CONTROL): a clean history is not touched --------
    // Passes before and after on purpose. "No gratuitous rewriting" is a
    // requirement, and a repair pass that quietly reshapes valid histories
    // would be a worse bug than the one it fixes.
    {
      const { stateDir, sessPath } = writeLog('c', [
        '{"type":"message","role":"user","content":[{"type":"text","text":"list it"}]}',
        '{"type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_463clean","name":"bash","input":{}}]}',
        '{"type":"message","role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_463clean","content":"a\\nb\\n"}]}',
      ]);
      const srv = await startServer([textResponse('clean.')]);
      const { stderr } = await runCodeBoth(srv.url, ['--resume', sessPath, '-p', 'go', '--no-color'],
        { GCODE_STATE_DIR: stateDir });
      srv.close();
      const sent = srv.bodies[0] ? srv.bodies[0].messages : [];
      check(!/repaired the message history/.test(stderr),
        '#463 negative control: a clean history reports NO repair');
      check(JSON.stringify(sent.slice(0, 3)) === JSON.stringify([
        { role: 'user', content: [{ type: 'text', text: 'list it' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_463clean', name: 'bash', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_463clean', content: 'a\nb\n' }] },
      ]), '#463 negative control: a clean history is replayed byte-for-byte unmodified');
      fs.rmSync(stateDir, { recursive: true, force: true });
    }

    // -- leg D (🔴 THE NEGATIVE CONTROL THAT MATTERS): a genuinely permanent
    // 400 still fails FAST and does not retry. The risk this ticket carries
    // is a classifier narrowed until real errors start looping; the gate is
    // "did the repair mutate the history", and an unknown model mutates
    // nothing. Same numbers as the pre-#463 binary: one request, then out.
    {
      const srv = await startServer([
        { status: 400, body: '{"type":"error","error":{"type":"invalid_request_error","message":"model: nonexistent-model-9000"}}' },
        textResponse('MUST NOT BE REACHED'),
      ]);
      const child = spawn(bin, ['--no-color', '--no-persist', '--model', 'nonexistent-model-9000'], {
        env: { ...process.env, ANTHROPIC_BASE_URL: srv.url, ANTHROPIC_API_KEY: 'test', ASAN_OPTIONS: 'detect_leaks=0' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let out = '', err = '';
      child.stdout.on('data', (c) => (out += c));
      child.stderr.on('data', (c) => (err += c));
      child.stdin.write('first ask\nsecond ask\n/quit\n');
      child.stdin.end();
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('#463 leg D timed out')); }, 15000);
        child.on('exit', () => { clearTimeout(t); resolve(); });
      });
      srv.close();
      check(srv.bodies.length === 1,
        `#463 negative control: a permanent 400 is NOT retried — exactly 1 request (got ${srv.bodies.length})`);
      check(/retrying cannot succeed/.test(err),
        '#463 negative control: the unchanged permanent verdict is still reported');
      check(!/retrying this round once/.test(err),
        '#463 negative control: no repair-retry was announced for an unknown-model 400');
      check(!out.includes('MUST NOT BE REACHED'), '#463 negative control: the REPL still exits on a permanent 400');
    }

    // -- leg H (NEGATIVE CONTROL): 401/403 are terminal UNCONDITIONALLY ---
    // Not "terminal unless the repair mutates" — no credential was ever fixed
    // by rewriting the conversation. The history here IS repairable, so this
    // separates the auth rule from the mutation gate: a leak would show up as
    // a retry.
    {
      const { stateDir, sessPath } = writeLog('h', [
        '{"type":"message","role":"user","content":[{"type":"text","text":"run it"}]}',
        '{"type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_463auth","name":"bash","input":{}}]}',
        '{"type":"message","role":"user","content":[{"type":"text","text":"note"},{"type":"tool_result","tool_use_id":"toolu_463auth","content":"out"}]}',
      ]);
      const srv = await startServer([
        { status: 401, body: JSON.stringify({ type: 'error', error: { type: 'authentication_error',
          message: 'invalid x-api-key; `tool_use` id toolu_463auth appears here only to bait the id matcher' } }) },
        textResponse('MUST NOT BE REACHED'),
      ]);
      const { stdout, stderr } = await runCodeBoth(srv.url, ['--resume', sessPath, '-p', 'go', '--no-color'],
        { GCODE_STATE_DIR: stateDir });
      srv.close();
      check(srv.bodies.length === 1,
        `#463 negative control: a 401 is terminal even with a repairable history (${srv.bodies.length} requests, expected 1)`);
      check(!/retrying this round once/.test(stderr) && !/repaired the message history after/.test(stderr),
        '#463 negative control: no repair is even attempted on an auth failure');
      check(!stdout.includes('MUST NOT BE REACHED'), '#463 negative control: the 401 ended the turn');
      fs.rmSync(stateDir, { recursive: true, force: true });
    }

    // -- leg E: a 400 NAMING dangling ids is repaired and retried ONCE ----
    // The structural pass runs before every POST, so by the time a 400 comes
    // back it has already had its say. What is new is the SERVER'S reading:
    // here the result IS in the next message (gcode's invariant holds) but
    // not at the FRONT of it, which Anthropic requires. The server names the
    // id, the named pass relocates the REAL output, and the round is re-sent.
    // PRE-FIX: one request, then the REPL exits.
    {
      const { stateDir, sessPath } = writeLog('e', [
        '{"type":"message","role":"user","content":[{"type":"text","text":"run it"}]}',
        '{"type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_463skewed","name":"bash","input":{}}]}',
        '{"type":"message","role":"user","content":[{"type":"text","text":"a stray note"},{"type":"tool_result","tool_use_id":"toolu_463skewed","content":"REAL OUTPUT"}]}',
      ]);
      const srv = await startServer([
        { status: 400, body: JSON.stringify({ type: 'error', error: { type: 'invalid_request_error',
          message: 'messages.2: `tool_use` ids were found without `tool_result` blocks immediately after: toolu_463skewed. Each `tool_use` block must have a corresponding `tool_result` block in the next message.' } }) },
        textResponse('recovered after repair.'),
      ]);
      const { stdout, stderr } = await runCodeBoth(srv.url, ['--resume', sessPath, '-p', 'go', '--no-color'],
        { GCODE_STATE_DIR: stateDir });
      srv.close();
      check(srv.bodies.length === 2,
        `#463: a history-shaped 400 was repaired and retried ONCE (${srv.bodies.length} requests)`);
      const first = srv.bodies[0] ? srv.bodies[0].messages[2] : null;
      check(!!first && first.content[0].type === 'text',
        '#463: the FIRST request went out as the log had it — the structural pass found nothing to change');
      const second = srv.bodies[1] ? srv.bodies[1].messages[2] : null;
      check(!!second && second.content[0].type === 'tool_result' && second.content[0].tool_use_id === 'toolu_463skewed',
        '#463: the retry moved the tool_result to the slot the server named');
      check(!!second && second.content[0].content === 'REAL OUTPUT',
        '#463: the REAL tool output was relocated, not replaced by a marker');
      check(/retrying this round once/.test(stderr), '#463: the repair-and-retry is announced, never silent');
      check(stdout.includes('recovered after repair.'), '#463: the turn completed instead of killing the REPL');
      fs.rmSync(stateDir, { recursive: true, force: true });
    }

    // -- leg F: the retry is bounded — a second 400 is permanent ----------
    // After the repair the history is canonical, so repairing it again is a
    // no-op and the gate refuses a second retry. This is what stops the
    // recovery path becoming an infinite loop against a server that 400s
    // for a reason gcode cannot fix.
    {
      const { stateDir, sessPath } = writeLog('f', [
        '{"type":"message","role":"user","content":[{"type":"text","text":"run it"}]}',
        '{"type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_463stubborn","name":"bash","input":{}}]}',
        '{"type":"message","role":"user","content":[{"type":"text","text":"note"},{"type":"tool_result","tool_use_id":"toolu_463stubborn","content":"out"}]}',
      ]);
      const err400 = { status: 400, body: JSON.stringify({ type: 'error', error: { type: 'invalid_request_error',
        message: '`tool_use` ids were found without `tool_result` blocks immediately after: toolu_463stubborn.' } }) };
      const srv = await startServer([err400, err400, textResponse('MUST NOT BE REACHED')]);
      const { stdout, stderr } = await runCodeBoth(srv.url, ['--resume', sessPath, '-p', 'go', '--no-color'],
        { GCODE_STATE_DIR: stateDir });
      srv.close();
      check(srv.bodies.length === 2,
        `#463: the repair-retry fires at most ONCE per turn (${srv.bodies.length} requests, expected 2)`);
      check(/retrying cannot succeed/.test(stderr),
        '#463: a second unfixable 400 falls back to the pre-#463 permanent verdict');
      check(!stdout.includes('MUST NOT BE REACHED'), '#463: no third request was made');
      fs.rmSync(stateDir, { recursive: true, force: true });
    }

    // -- leg G: idempotence, end to end ----------------------------------
    // The repair is not persisted (see leg A), so the SAME poisoned log is
    // repaired again on the next resume — and must produce exactly the same
    // history. repair(repair(h)) == repair(h) is asserted per-fixture in the
    // C self-test; this is the same property across two processes.
    {
      const lines = [
        '{"type":"message","role":"user","content":[{"type":"text","text":"twice"}]}',
        '{"type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_463twice","name":"bash","input":{}}]}',
      ];
      const sends = [];
      for (const tag of ['g1', 'g2']) {
        const { stateDir, sessPath } = writeLog(tag, lines);
        const srv = await startServer([textResponse('same both times.')]);
        await runCodeBoth(srv.url, ['--resume', sessPath, '-p', 'go', '--no-color'], { GCODE_STATE_DIR: stateDir });
        srv.close();
        sends.push(JSON.stringify(srv.bodies[0] ? srv.bodies[0].messages : null));
        fs.rmSync(stateDir, { recursive: true, force: true });
      }
      check(sends[0] === sends[1] && sends[0] !== 'null',
        '#463: repairing the same poisoned log twice yields the identical history (idempotent across processes)');
      check(historyFaults(JSON.parse(sends[0])).length === 0, '#463: and that history is API-valid');
    }
  }

  // ---- #509: ^C mid-bash — honest survivor-edge report ----------------
  // kill -INT at gcode ALONE (the #412(c) survivor edge — a tty ^C would
  // signal the whole fg pgroup): gcode SIGKILLs the direct sh, whose own
  // child (sleep 30) survives the kill. The tool_result must state what
  // actually happened — the interrupt, the shell kill, and that spawned
  // processes may still be running — and never claim the whole command
  // was killed. Instrument: the persisted session log; #412 deliberately
  // sends no tool_results POST after a ^C.
  {
    const marker = path.join(os.tmpdir(), `g509-${process.pid}.started`);
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'g509-state-'));
    fs.rmSync(marker, { force: true });
    const srv = await startServer([
      toolUseResponse('interrupting.', 'toolu_509', 'bash',
        { command: `touch ${marker}; sleep 30` }),
    ]);
    const t0 = Date.now();
    const child = spawn(bin, ['-p', 'interrupt me', '--no-color'], {
      env: { ...process.env, ANTHROPIC_BASE_URL: srv.url, ANTHROPIC_API_KEY: 'test',
             ASAN_OPTIONS: 'detect_leaks=0', GCODE_STATE_DIR: stateDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    while (!fs.existsSync(marker) && Date.now() - t0 < 10000)
      await new Promise((r) => setTimeout(r, 50));
    check(fs.existsSync(marker), '#509: bash tool is running (marker file exists)');
    child.kill('SIGINT');   // gcode alone — the survivor edge
    const code = await new Promise((resolve, reject) => {
      const t = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('#509 leg timed out')); }, 20000);
      child.on('exit', (c) => { clearTimeout(t); resolve(c); });
    });
    srv.close();
    check(Date.now() - t0 < 15000, '#509: returned promptly (sh killed, sleep not drained)');
    check(code === 0, `#509: interrupted run exits 0 (got ${code})`);
    const sessDir = path.join(stateDir, 'sessions');
    const log = fs.readdirSync(sessDir)
      .map((f) => fs.readFileSync(path.join(sessDir, f), 'utf8')).join('');
    const line = log.split('\n')
      .find((l) => l.includes('toolu_509') && l.includes('tool_result')) || '';
    check(line.includes('interrupted by user (^C)'), '#509: tool_result names the interrupt');
    check(line.includes('shell killed') && line.includes('may still be running'),
      '#509: tool_result reports the sh kill honestly (shell killed + may-survive caveat)');
    check(!line.includes('[command killed:'),
      '#509: tool_result never claims a completed kill of the whole command');
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(marker, { force: true });
  }

  // ---- #510: ^C mid-bash with a CHATTY child — the kill still fires ----
  // The interrupt twin of #503(b): `g_interrupted` was checked only in the
  // poll EINTR branch, but a chatty child keeps the pipe readable, so poll
  // keeps returning POLLIN (r > 0) and a SIGINT landing outside the poll
  // syscall never produces EINTR — the kill branch never ran and the ^C did
  // nothing until the wall-time cap. Composition of the #509 leg's driving
  // (kill -INT at gcode ALONE — the survivor edge) with the chatty command
  // from the gucOS timeout e2e's round 4. GCODE_BASH_SECS=45 bounds the
  // pre-fix red (the 20s watchdog fires first, loudly); post-fix the ^C
  // returns in well under a second and the cap never matters.
  {
    const marker = path.join(os.tmpdir(), `g510-${process.pid}.started`);
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'g510-state-'));
    fs.rmSync(marker, { force: true });
    const srv = await startServer([
      toolUseResponse('interrupting.', 'toolu_510', 'bash',
        { command: `touch ${marker}; while true; do echo spam; done` }),
    ]);
    const t0 = Date.now();
    const child = spawn(bin, ['-p', 'interrupt me', '--no-color'], {
      env: { ...process.env, ANTHROPIC_BASE_URL: srv.url, ANTHROPIC_API_KEY: 'test',
             ASAN_OPTIONS: 'detect_leaks=0', GCODE_STATE_DIR: stateDir,
             GCODE_BASH_SECS: '45' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    while (!fs.existsSync(marker) && Date.now() - t0 < 10000)
      await new Promise((r) => setTimeout(r, 50));
    check(fs.existsSync(marker), '#510: chatty bash tool is running (marker file exists)');
    const tKill = Date.now();
    child.kill('SIGINT');   // gcode alone — the sh keeps spamming through it
    const code = await new Promise((resolve, reject) => {
      const t = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('#510 leg timed out')); }, 20000);
      child.on('exit', (c) => { clearTimeout(t); resolve(c); });
    });
    srv.close();
    check(Date.now() - tKill < 10000, '#510: ^C killed the chatty sh promptly (no stall to the cap)');
    check(code === 0, `#510: interrupted run exits 0 (got ${code})`);
    const sessDir = path.join(stateDir, 'sessions');
    const log = fs.readdirSync(sessDir)
      .map((f) => fs.readFileSync(path.join(sessDir, f), 'utf8')).join('');
    const line = log.split('\n')
      .find((l) => l.includes('toolu_510') && l.includes('tool_result')) || '';
    check(line.includes('interrupted by user (^C)'), '#510: tool_result names the interrupt');
    check(line.includes('shell killed') && line.includes('may still be running'),
      '#510: tool_result reports the sh kill honestly (shell killed + may-survive caveat)');
    check(!line.includes('timed out after'),
      '#510: tool_result does NOT carry the timeout message (the ^C ended the round, not the cap)');
    check(line.includes('spam'), '#510: pre-^C output was preserved (spam present)');
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(marker, { force: true });
  }

  // ---- #506: bounded search tools (grep + glob) ------------------------
  // A scripted four-round turn: a content grep, a name glob, a grep rooted
  // at / (must be REFUSED, not walked), and a grep that floods the result
  // cap. The fixture tree carries a symlink loop — a walker that follows
  // symlinks hangs here and the 15s exec timeout turns that into a FAIL.
  {
    const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'gcode-506-'));
    fs.mkdirSync(path.join(tree, 'sub', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(tree, 'sub', 'needle.c'), '// filler\nint MAGIC_NEEDLE_506 = 1;\n');
    fs.writeFileSync(path.join(tree, 'sub', 'deep', 'other.h'), 'no match here\n');
    fs.writeFileSync(path.join(tree, 'noise.txt'), 'MAGIC_NEEDLE_506 in a txt\n');
    fs.symlinkSync(tree, path.join(tree, 'sub', 'loop'));
    fs.writeFileSync(path.join(tree, 'flood.txt'), Array(300).fill('CAP_TRIP_506 line').join('\n') + '\n');

    const srv = await startServer([
      toolUseResponse('searching', 'toolu_506g', 'grep', { pattern: 'MAGIC_NEEDLE_506', root: tree }),
      toolUseResponse('globbing', 'toolu_506n', 'glob', { pattern: '*.c', root: tree }),
      toolUseResponse('refusing', 'toolu_506r', 'grep', { pattern: 'x', root: '/' }),
      toolUseResponse('flooding', 'toolu_506c', 'grep', { pattern: 'CAP_TRIP_506', root: tree }),
      textResponse('search done'),
    ]);
    await runCodeBoth(srv.url, ['-p', 'search', '--no-color', '--no-persist']);
    srv.close();
    check(!!srv.bodies[0] && Array.isArray(srv.bodies[0].tools)
      && ['grep', 'glob'].every((n) => srv.bodies[0].tools.some((t) => t.name === n)),
      '#506: grep and glob tools are advertised in the tool list');
    const trOf = (i, id) => ((srv.bodies[i] && srv.bodies[i].messages[srv.bodies[i].messages.length - 1].content) || [])
      .find((b) => b.type === 'tool_result' && b.tool_use_id === id);
    const g = trOf(1, 'toolu_506g');
    check(!!g && g.content.includes('needle.c:2:') && g.content.includes('MAGIC_NEEDLE_506'),
      '#506: grep returns path:line: matches for a fixed string');
    check(!!g && g.content.includes('noise.txt'),
      '#506: grep walked the whole tree (found the second match, not just the first)');
    const nm = trOf(2, 'toolu_506n');
    check(!!nm && nm.content.includes('needle.c') && !nm.content.includes('other.h'),
      '#506: glob matches file names by wildcard pattern');
    const rf = trOf(3, 'toolu_506r');
    check(!!rf && rf.content.startsWith('error:') && rf.content.includes('refus'),
      '#506: a search rooted at / is REFUSED, not walked');
    const cp = trOf(4, 'toolu_506c');
    check(!!cp && cp.content.includes('truncated'),
      '#506: grep results are hard-capped with a visible truncation marker');
    fs.rmSync(tree, { recursive: true, force: true });
  }

  // ---- #507: progress signal during a long tool call --------------------
  // The heartbeat is tty-gated with GCODE_PROGRESS as the forced test seam
  // (the GCODE_BASH_SECS precedent): =1 forces it on down a pipe (plain
  // newline lines, no \r games), unset on a pipe means silent — that is the
  // non-tty degradation the harness itself relies on. The Result-line
  // duration is unconditional (a one-shot line, honest in logs).
  {
    const srv = await startServer([
      toolUseResponse('sleeping', 'toolu_507a', 'bash', { command: 'sleep 3' }),
      textResponse('slept ok'),
    ]);
    const forced = await runCodeBoth(srv.url, ['-p', 'nap', '--no-color', '--no-persist'],
      { GCODE_PROGRESS: '1' });
    srv.close();
    check(/running [0-9]+s/.test(forced.stderr),
      '#507: a long tool call renders a live elapsed heartbeat (GCODE_PROGRESS=1)');
    check(/Result \([0-9]+s\)/.test(forced.stderr),
      '#507: the Result line names the tool call duration');

    const srv2 = await startServer([
      toolUseResponse('sleeping', 'toolu_507b', 'bash', { command: 'sleep 3' }),
      textResponse('slept ok'),
    ]);
    const piped = await runCodeBoth(srv2.url, ['-p', 'nap', '--no-color', '--no-persist']);
    srv2.close();
    check(!/running [0-9]+s/.test(piped.stderr),
      '#507: piped (non-tty) stderr stays heartbeat-free by default');
    check(/Result \([0-9]+s\)/.test(piped.stderr),
      '#507: the duration still lands on the Result line without a tty');

    const srv3 = await startServer([{ delay: 3200, sse: textResponse('slow hello') }]);
    const waiting = await runCodeBoth(srv3.url, ['-p', 'hi', '--no-color', '--no-persist'],
      { GCODE_PROGRESS: '1' });
    srv3.close();
    check(/waiting for model [0-9]+s/.test(waiting.stderr),
      '#507: a slow first byte renders a waiting-for-model heartbeat');
    check(waiting.stdout.includes('slow hello'),
      '#507 negative control: the delayed turn still completes normally');
  }

  // ---- #530: layered GCODE.md context files ----------------------------
  // The fake server records request bodies, so `system` is asserted
  // directly. GCODE_CONTEXT_ROOT redirects the two absolute system-layer
  // paths into a fixture (the GCODE_STATE_DIR precedent); HOME and cwd
  // control the user layer and the project walk-up.
  {
    const fx = fs.mkdtempSync(path.join(os.tmpdir(), 'gcode-530-'));
    const emptyRoot = path.join(fx, 'emptyroot');
    fs.mkdirSync(emptyRoot, { recursive: true });
    const BASE = 'You are `gcode`, a terminal coding assistant. Use the tools to '
      + 'explore, create, and edit files and run shell commands. Be '
      + 'concise. Prefer small, verifiable steps.';

    // -- leg A: no files anywhere -> byte-identical bare literal ---------
    // The cfgstore "nothing baked" property, plus the #551 inherited-scope
    // acceptance: the literal no longer carries platform content.
    {
      const home = path.join(fx, 'homeA'); const cwd = path.join(home, 'work');
      fs.mkdirSync(cwd, { recursive: true });
      const srv = await startServer([textResponse('bare')]);
      await runCodeBoth(srv.url, ['-p', 'hi', '--no-color', '--no-persist'],
        { HOME: home, GCODE_CONTEXT_ROOT: emptyRoot }, cwd);
      srv.close();
      const sys = systemText(srv.bodies[0]);
      check(sys === BASE,
        '#530: with no GCODE.md anywhere the POSTed system prompt is the bare literal, byte-identical');
      check(typeof sys === 'string' && !sys.includes('SDL_MAIN_USE_CALLBACKS') && !sys.includes('gucOS'),
        '#530: the binary literal carries no platform content (the #551 SDL rule moved to the file layer)');
    }

    // -- leg B: all four layers, emitted general-first / specific-last ---
    {
      const ctxRoot = path.join(fx, 'ctxroot');
      fs.mkdirSync(path.join(ctxRoot, 'usr/share/gcode'), { recursive: true });
      fs.mkdirSync(path.join(ctxRoot, 'etc/gcode'), { recursive: true });
      fs.writeFileSync(path.join(ctxRoot, 'usr/share/gcode/GCODE.md'), 'USR-LAYER-530 platform facts\n');
      fs.writeFileSync(path.join(ctxRoot, 'etc/gcode/GCODE.md'), 'ETC-LAYER-530 admin adds\n');
      const home = path.join(fx, 'homeB');
      fs.mkdirSync(path.join(home, '.config/gcode'), { recursive: true });
      fs.writeFileSync(path.join(home, '.config/gcode/GCODE.md'), 'USER-LAYER-530\n');
      fs.writeFileSync(path.join(fx, 'GCODE.md'), 'ABOVE-HOME-530\n');   // above $HOME — must not load
      const proj = path.join(home, 'proj'); const sub = path.join(proj, 'sub');
      fs.mkdirSync(sub, { recursive: true });
      fs.writeFileSync(path.join(proj, 'GCODE.md'), 'PROJ-TOP-530\n');
      fs.writeFileSync(path.join(sub, 'GCODE.md'), 'PROJ-SUB-530\n');

      let srv = await startServer([textResponse('layered')]);
      await runCodeBoth(srv.url, ['-p', 'hi', '--no-color', '--no-persist'],
        { HOME: home, GCODE_CONTEXT_ROOT: ctxRoot }, sub);
      srv.close();
      const sys = systemText(srv.bodies[0]);
      const order = ['USR-LAYER-530', 'ETC-LAYER-530', 'USER-LAYER-530', 'PROJ-TOP-530', 'PROJ-SUB-530']
        .map((m) => sys.indexOf(m));
      check(order.every((i) => i >= 0) && order.every((i, k) => k === 0 || i > order[k - 1]),
        `#530: /usr/share + /etc + ~/.config + walk-up all load, stable-and-general first, specific last (indices ${order.join(',')})`);
      check(sys.startsWith(BASE), '#530: the base prompt stays the stable cache prefix');
      check(sys.includes(`[GCODE.md context: ${path.join(ctxRoot, 'etc/gcode/GCODE.md')}]`),
        '#530: each block is headed by the path it came from');
      check(!sys.includes('ABOVE-HOME-530'), '#530: the walk-up never reads above $HOME');

      // -- leg F: --no-context turns all of it off ----------------------
      srv = await startServer([textResponse('off')]);
      await runCodeBoth(srv.url, ['-p', 'hi', '--no-color', '--no-persist', '--no-context'],
        { HOME: home, GCODE_CONTEXT_ROOT: ctxRoot }, sub);
      srv.close();
      check(srv.bodies[0] && systemText(srv.bodies[0]) === BASE,
        '#530: --no-context sends the bare literal even with every layer present');
    }

    // -- leg C: editing a project GCODE.md must NOT make --resume warn ---
    // Design point (ii): context files are excluded from system_prompt_hash,
    // so the warning keeps meaning "the BASE prompt changed". A regression
    // that folds context into the hash fails the first check; the negative
    // control proves the warning itself still works.
    {
      const home = path.join(fx, 'homeC'); const p = path.join(home, 'p');
      fs.mkdirSync(p, { recursive: true });
      fs.writeFileSync(path.join(p, 'GCODE.md'), 'EDITABLE-530 v1\n');
      const stateDir = path.join(fx, 'stateC');
      const envC = { HOME: home, GCODE_CONTEXT_ROOT: emptyRoot, GCODE_STATE_DIR: stateDir };
      let srv = await startServer([textResponse('one')]);
      await runCodeBoth(srv.url, ['-p', 'one', '--no-color'], envC, p);
      srv.close();
      const sessDir = path.join(stateDir, 'sessions');
      const sessPath = path.join(sessDir, fs.readdirSync(sessDir).filter((f) => f.endsWith('.jsonl'))[0]);
      const meta = JSON.parse(fs.readFileSync(sessPath, 'utf8').split('\n')[0]);
      // realpath: walk-up paths derive from getcwd, which resolves the
      // macOS /var -> /private/var tmpdir symlink the fixture path spells.
      check(Array.isArray(meta.context_files)
        && meta.context_files[meta.context_files.length - 1] === path.join(fs.realpathSync(p), 'GCODE.md'),
        '#530: session_meta records the loaded context files');

      fs.appendFileSync(path.join(p, 'GCODE.md'), 'EDITED-530 v2\n');
      srv = await startServer([textResponse('two')]);
      const r2 = await runCodeBoth(srv.url, ['--resume', sessPath, '-p', 'two', '--no-color'], envC, p);
      srv.close();
      check(!r2.stderr.includes('resumed system prompt differs'),
        '#530: editing a project GCODE.md does NOT make --resume warn (context excluded from the hash)');
      check(srv.bodies[0] && systemText(srv.bodies[0]).includes('EDITED-530 v2'),
        '#530: the resumed request carries the freshly loaded (edited) context');

      srv = await startServer([textResponse('three')]);
      const r3 = await runCodeBoth(srv.url,
        ['--resume', sessPath, '-p', 'three', '--no-color', '--system-prompt', 'a different base'], envC, p);
      srv.close();
      check(r3.stderr.includes('resumed system prompt differs'),
        '#530 negative control: a changed BASE prompt still warns on resume');
    }

    // -- leg D: the total byte cap is loud, in-band and on stderr --------
    {
      const home = path.join(fx, 'homeD'); const s = path.join(home, 's');
      fs.mkdirSync(s, { recursive: true });
      fs.writeFileSync(path.join(home, 'GCODE.md'), 'A'.repeat(60 * 1024));
      fs.writeFileSync(path.join(s, 'GCODE.md'), 'DROPPED-530\n');
      const srv = await startServer([textResponse('capped')]);
      const r = await runCodeBoth(srv.url, ['-p', 'hi', '--no-color', '--no-persist'],
        { HOME: home, GCODE_CONTEXT_ROOT: emptyRoot }, s);
      srv.close();
      const sys = systemText(srv.bodies[0]);
      check(sys.includes('[gcode: context truncated at the 49152-byte total cap]'),
        '#530: the file crossing the cap gets an in-band truncation marker');
      check(sys.length < BASE.length + 49152 + 300,
        `#530: the POSTed system prompt stays bounded by the cap (${sys.length} bytes)`);
      check(!sys.includes('DROPPED-530'), '#530: files past a spent budget are dropped, not half-included');
      check(r.stderr.includes('truncated at the 49152-byte context cap')
        && r.stderr.includes('dropped (the 49152-byte context cap is spent)'),
        '#530: both the truncation and the drop are announced on stderr — never a silent trim');
    }

    // -- leg E: the walk-up is depth-bounded (CAP_CONTEXT_DEPTH = 32) ----
    {
      const home = path.join(fx, 'deep'); let d = home;
      for (let i = 0; i < 40; i++) d = path.join(d, 'd' + i);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(home, 'GCODE.md'), 'TOO-FAR-530\n');
      fs.writeFileSync(path.join(d, 'GCODE.md'), 'NEAR-530\n');
      const srv = await startServer([textResponse('deep')]);
      await runCodeBoth(srv.url, ['-p', 'hi', '--no-color', '--no-persist'],
        { HOME: home, GCODE_CONTEXT_ROOT: emptyRoot }, d);
      srv.close();
      const sys = systemText(srv.bodies[0]);
      check(sys.includes('NEAR-530'), '#530: a file inside the walk bound is read');
      check(!sys.includes('TOO-FAR-530'),
        '#530: a file 41 directories up is beyond the depth bound and is not read');
    }
    fs.rmSync(fx, { recursive: true, force: true });
  }

  // ---- #511: signal-before-poll race — the self-pipe closes the window --
  // GCODE_TEST_INTR_BEFORE_POLL=1 makes native run_command raise SIGINT
  // exactly between the loop-top g_interrupted check and poll(2) entering —
  // the raced window, unreachable deterministically from outside the
  // process. Pre-#511 the handler ran before poll blocked, poll got no
  // EINTR, and against a SILENT child the ^C stayed latent for the full 1s
  // slice (the #507 clamp). Post-fix the handler's self-pipe byte makes
  // poll return immediately. ANNOTATED TIMING ASSERTION: the latency is the
  // mechanism's only externally visible effect, so the third check is
  // differential timing against a control run of the same shape — the
  // pre-fix floor is a hard +1000ms (poll always sleeps its full slice),
  // the post-fix path is a few ms, and the 800ms margin rides on the
  // control so shared load cancels out.
  {
    const srv0 = await startServer([
      toolUseResponse('ctl', 'toolu_511c', 'bash', { command: 'true' }),
      textResponse('done'),
    ]);
    const c0 = Date.now();
    await runCodeBoth(srv0.url, ['-p', 'control', '--no-color', '--no-persist']);
    const ctlMs = Date.now() - c0;
    srv0.close();

    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcode-511-'));
    const srv = await startServer([
      toolUseResponse('race', 'toolu_511', 'bash', { command: 'sleep 30' }),
    ]);
    const t0 = Date.now();
    await runCodeBoth(srv.url, ['-p', 'race', '--no-color'],
      { GCODE_TEST_INTR_BEFORE_POLL: '1', GCODE_BASH_SECS: '45', GCODE_STATE_DIR: stateDir });
    const raceMs = Date.now() - t0;
    srv.close();

    const sessDir = path.join(stateDir, 'sessions');
    const log = fs.readdirSync(sessDir)
      .map((f) => fs.readFileSync(path.join(sessDir, f), 'utf8')).join('');
    const line = log.split('\n')
      .find((l) => l.includes('toolu_511') && l.includes('tool_result')) || '';
    check(line.includes('interrupted by user (^C)'),
      '#511: the in-window SIGINT killed the silent child (tool_result names the ^C)');
    check(!line.includes('timed out after'),
      '#511: the round ended on the ^C, not on the wall-time cap');
    check(raceMs < ctlMs + 800,
      `#511: the in-window ^C woke poll immediately (race ${raceMs}ms vs control ${ctlMs}ms; pre-fix floor is control+1000ms)`);
    fs.rmSync(stateDir, { recursive: true, force: true });
  }

  // ---- test 14 (#467): compaction at the context ceiling -----------------
  // gcode used to grow its history unbounded until the provider returned a
  // context-length 400, which the permanent classifier turned into a REPL
  // exit — a destroyed session. Ruled (night decider, 2026-08-03): gcode
  // COMPACTS — loudly — and keeps going. Legs A/C/E/F FAIL on the pre-#467
  // binary (leg C is the ticket's positive control: the same script exits the
  // REPL there); legs B and D are the guard rails.
  {
    // Big numbers ride in message_delta usage (merge_usage overlays them on
    // message_start's). Leg A deliberately puts the bulk in CACHE_READ with a
    // small input_tokens: a compactor thresholding on input_tokens alone —
    // the plausible wrong field — never fires, and this leg goes red.
    const usageTool = (id, cmd, usage) =>
      sse('message_start', { message: { id: `msg_${id}`, model: 'compact-model', usage: { input_tokens: 5, output_tokens: 0 } } })
      + sse('content_block_start', { index: 0, content_block: { type: 'tool_use', id, name: 'bash', input: {} } })
      + sse('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command: cmd }) } })
      + sse('content_block_stop', { index: 0 })
      + sse('message_delta', { delta: { stop_reason: 'tool_use' }, usage })
      + sse('message_stop', {});
    // GCODE_CONTEXT_TOKENS=20000 with --max-tokens 2000 -> an 18000-token
    // usable budget: warn at 13500 (75%), compact at 15300 (85%).
    const ENV467 = { GCODE_CONTEXT_TOKENS: '20000' };
    const ARGS467 = ['--no-color', '--max-tokens', '2000'];
    const apiValid = (msgs) => {
      for (let i = 0; i < msgs.length; i++) {
        const uses = (Array.isArray(msgs[i].content) ? msgs[i].content : [])
          .filter((b) => b.type === 'tool_use').map((b) => b.id);
        if (!uses.length) continue;
        const next = msgs[i + 1];
        const got = (next && Array.isArray(next.content) ? next.content : [])
          .filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id);
        if (next?.role !== 'user' || uses.some((id) => !got.includes(id))) return false;
      }
      return true;
    };
    const MARKER = '[gcode: compacted history]';

    // -- leg A: the firm threshold compacts, loudly, without splitting a pair
    // (and leg F below resumes the same log). Round 2 reports 16300 tokens —
    // 200 input + 300 cache-create + 15800 CACHE-READ — so round 3's send is
    // compacted first. Pre-fix: nothing fires and all 4 requests carry the
    // full history.
    const stateA = fs.mkdtempSync(path.join(os.tmpdir(), 'gcode-467a-'));
    {
      const srv = await startServer([
        usageTool('t467a1', 'true', { output_tokens: 2, input_tokens: 300, cache_read_input_tokens: 200 }),
        usageTool('t467a2', 'true', { output_tokens: 2, input_tokens: 200, cache_creation_input_tokens: 300, cache_read_input_tokens: 15800 }),
        usageTool('t467a3', 'true', { output_tokens: 2, input_tokens: 400, cache_read_input_tokens: 100 }),
        textResponse('finished after compaction.'),
      ]);
      const { stdout, stderr } = await runCodeBoth(srv.url, ['-p', 'long session', ...ARGS467],
        { ...ENV467, GCODE_STATE_DIR: stateA });
      srv.close();
      check(srv.bodies.length === 4, `#467: the session ran all 4 rounds (${srv.bodies.length})`);
      const sent = srv.bodies[2] ? srv.bodies[2].messages : [];
      check(sent.length === 4 && JSON.stringify(sent[1]).includes(MARKER),
        `#467: round 3 went out COMPACTED — oldest round folded into a summary at index 1 (${sent.length} messages)`);
      check(apiValid(sent), '#467: the compacted history is API-valid — no tool pair was split by the fold');
      check(!JSON.stringify(sent).includes('t467a1') && JSON.stringify(sent).includes('t467a2'),
        '#467: the folded round\'s tool id is gone, the kept round\'s survives verbatim');
      check(Array.isArray(sent[0]?.content) && JSON.stringify(sent[0]).includes('long session'),
        '#467: the ORIGINAL first user message is kept verbatim ahead of the summary');
      check(/context is at 9\d% of the ~18000-token budget/.test(stderr),
        '#467: the compaction names the numbers (percent + budget) before folding');
      check(/compacted the history \(auto\) — folded 2 message\(s\), 1 assistant round\(s\)/.test(stderr),
        '#467: the compaction announces itself — rounds folded and resulting size, never silent');
      check(stdout.includes('finished after compaction.'),
        '#467: the session CONTINUES past the ceiling instead of exiting the REPL');
    }

    // -- leg B (guard rail): the soft threshold warns and does NOT compact --
    // 14000 of 18000 is 77% — inside [75, 85). The user must get the warning
    // while they can still act, and the history must go out untouched.
    {
      const srv = await startServer([
        usageTool('t467b1', 'true', { output_tokens: 2, input_tokens: 14000 }),
        textResponse('done b.'),
      ]);
      const { stderr } = await runCodeBoth(srv.url, ['-p', 'warn only', ...ARGS467, '--no-persist'], ENV467);
      srv.close();
      check(/context is at 77% of the ~18000-token budget .*will compact automatically at 85%/.test(stderr)
        && stderr.includes('/compact') && stderr.includes('/clear'),
        '#467: the soft threshold warns with the numbers and names /compact and /clear');
      const sent = srv.bodies[1] ? srv.bodies[1].messages : [];
      check(sent.length === 3 && !JSON.stringify(sent).includes(MARKER),
        '#467: a warned history still goes out UNcompacted (warn is not compact)');
      check(!/compacted the history/.test(stderr), '#467: no compaction below the firm threshold');
    }

    // -- legs C/D need a resumable log of complete rounds -------------------
    const writeLog467 = (tag, ids) => {
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), `gcode-467-${tag}-`));
      const sessDir = path.join(stateDir, 'sessions');
      fs.mkdirSync(sessDir, { recursive: true });
      const sessPath = path.join(sessDir, '20260811T000000Z_467467467467467467467467467467ab.jsonl');
      const lines = [
        '{"schema_version":1,"type":"session_meta","session_id":"467467467467467467467467467467ab","model":"m","base_url":"u","system_prompt_hash":"h","cwd":"/"}',
        '{"type":"message","role":"user","content":[{"type":"text","text":"long-running ask"}]}',
        `{"type":"message","role":"assistant","content":[{"type":"tool_use","id":"${ids[0]}","name":"bash","input":{"command":"true"}}]}`,
        `{"type":"message","role":"user","content":[{"type":"tool_result","tool_use_id":"${ids[0]}","content":"out one"}]}`,
        '{"type":"message","role":"assistant","content":[{"type":"text","text":"step one done"}]}',
        '{"type":"message","role":"user","content":[{"type":"text","text":"keep going"}]}',
        `{"type":"message","role":"assistant","content":[{"type":"tool_use","id":"${ids[1]}","name":"bash","input":{"command":"true"}}]}`,
        `{"type":"message","role":"user","content":[{"type":"tool_result","tool_use_id":"${ids[1]}","content":"out two"}]}`,
        '{"type":"message","role":"assistant","content":[{"type":"text","text":"step two done"}]}',
      ];
      fs.writeFileSync(sessPath, lines.join('\n') + '\n');
      return { stateDir, sessPath };
    };

    // -- leg C (THE POSITIVE CONTROL): a context-length 400 is recovered ----
    // by compact-and-retry-once. On the pre-#467 binary this exact script is
    // a permanent verdict after ONE request and the REPL dies — the brick the
    // ticket exists to remove.
    {
      const { stateDir, sessPath } = writeLog467('c', ['toolu_467c1', 'toolu_467c2']);
      const srv = await startServer([
        { status: 400, body: '{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 22000 tokens > 18000 maximum"}}' },
        textResponse('recovered after compaction.'),
      ]);
      const { stdout, stderr } = await runCodeBoth(srv.url, ['--resume', sessPath, '-p', 'go', ...ARGS467],
        { ...ENV467, GCODE_STATE_DIR: stateDir });
      srv.close();
      check(srv.bodies.length === 2,
        `#467: a context-length 400 was compacted and retried ONCE (${srv.bodies.length} requests; pre-fix 1 and the REPL exits)`);
      check(srv.bodies[0] && !JSON.stringify(srv.bodies[0].messages).includes(MARKER),
        '#467: the first request went out as the log had it — the guard had no usage signal yet');
      const retry = srv.bodies[1] ? srv.bodies[1].messages : [];
      check(retry.length > 0 && JSON.stringify(retry).includes(MARKER) && retry.length < srv.bodies[0].messages.length,
        '#467: the retry is COMPACTED — fewer messages plus the summary');
      check(apiValid(retry), '#467: the post-400 compacted history is API-valid');
      check(/compacted the history \(rejected\)/.test(stderr) && /retrying this round once/.test(stderr),
        '#467: the recovery is announced — compaction plus the once-only retry');
      check(stdout.includes('recovered after compaction.'),
        '#467: the session survives the rejection instead of exiting the REPL');
      fs.rmSync(stateDir, { recursive: true, force: true });
    }

    // -- leg D (🔴 the guard rail that matters): a genuinely permanent 400 --
    // still fails fast. Same repairable-looking long history, but the body
    // names an unknown model — nothing about length — so no compaction, no
    // retry, the pre-#467 verdict verbatim. This is the "do NOT blanket-
    // narrow the permanent classifier" clause, asserted.
    {
      const { stateDir, sessPath } = writeLog467('d', ['toolu_467d1', 'toolu_467d2']);
      const srv = await startServer([
        { status: 400, body: '{"type":"error","error":{"type":"invalid_request_error","message":"model: nonexistent-model-9000"}}' },
        textResponse('MUST NOT BE REACHED'),
      ]);
      const { stdout, stderr } = await runCodeBoth(srv.url, ['--resume', sessPath, '-p', 'go', ...ARGS467],
        { ...ENV467, GCODE_STATE_DIR: stateDir });
      srv.close();
      check(srv.bodies.length === 1,
        `#467 negative control: an unknown-model 400 is NOT compact-retried (${srv.bodies.length} requests)`);
      check(/retrying cannot succeed/.test(stderr) && !/compacted the history/.test(stderr),
        '#467 negative control: the permanent verdict is unchanged and no compaction fired');
      check(!stdout.includes('MUST NOT BE REACHED'), '#467 negative control: the REPL still exits');
      fs.rmSync(stateDir, { recursive: true, force: true });
    }

    // -- leg E: manual /compact beside an unchanged /clear ------------------
    {
      const srv = await startServer([
        toolUseResponse('working', 'toolu_467e1', 'bash', { command: 'true' }),
        textResponse('first done.'),
        textResponse('second done.'),
        textResponse('third done.'),
      ]);
      const child = spawn(bin, ['--no-color', '--no-persist'], {
        env: { ...process.env, ANTHROPIC_BASE_URL: srv.url, ANTHROPIC_API_KEY: 'test',
               ASAN_OPTIONS: 'detect_leaks=0' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let out = '', err = '';
      child.stdout.on('data', (c) => (out += c));
      child.stderr.on('data', (c) => (err += c));
      child.stdin.write('first ask\nsecond ask\n/compact\n/compact\nthird ask\n/clear\n/quit\n');
      child.stdin.end();
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('#467 leg E timed out')); }, 15000);
        child.on('exit', () => { clearTimeout(t); resolve(); });
      });
      srv.close();
      check(/compacted the history \(manual\) — folded 3 message\(s\)/.test(err),
        '#467: /compact folds on demand and announces what it folded');
      check(err.includes('nothing to compact'),
        '#467: a second /compact with only the summary left says so instead of churning');
      // request indices: 0 = first ask (tool round), 1 = its follow-up,
      // 2 = second ask, 3 = the post-/compact third ask.
      const sent = srv.bodies[3] ? srv.bodies[3].messages : [];
      check(sent.length > 0 && JSON.stringify(sent[1]).includes(MARKER) && apiValid(sent)
        && !JSON.stringify(sent).includes('toolu_467e1'),
        '#467: the post-/compact request carries the summary, valid, folded tool id gone');
      check(err.includes('[history cleared]'), '#467: /clear is unchanged beside /compact');
    }

    // -- leg F: persistence + --resume of the compacted leg-A log -----------
    // The compacted history is what the log carries forward: the resume must
    // load the spliced shape (ONE summary), not the pre-compact history, and
    // must not immediately re-compact (idempotence across processes).
    {
      const sessDir = path.join(stateA, 'sessions');
      const logFile = fs.readdirSync(sessDir).filter((f) => f.endsWith('.jsonl'))[0];
      const records = fs.readFileSync(path.join(sessDir, logFile), 'utf8')
        .split('\n').filter(Boolean).map((l) => JSON.parse(l));
      const comp = records.find((r) => r.type === 'compact');
      check(!!comp && comp.reason === 'auto' && comp.folded === 2 && comp.summary?.role === 'user',
        '#467: the compaction is PERSISTED — a compact record with the splice and the summary');
      const srv = await startServer([textResponse('resumed fine.')]);
      const { stderr } = await runCodeBoth(srv.url,
        ['--resume', path.join(sessDir, logFile), '-p', 'go', ...ARGS467],
        { ...ENV467, GCODE_STATE_DIR: stateA });
      srv.close();
      const sent = srv.bodies[0] ? srv.bodies[0].messages : [];
      const markers = (JSON.stringify(sent).match(/\[gcode: compacted history\]/g) || []).length;
      check(markers === 1 && !JSON.stringify(sent).includes('t467a1'),
        `#467: --resume replays the COMPACTED history — one summary, folded round gone (${markers} markers)`);
      check(apiValid(sent), '#467: the resumed compacted history is API-valid');
      check(!/compacted the history/.test(stderr) && !/does not match/.test(stderr),
        '#467: the resume does not immediately re-compact and the splice applied cleanly');
      fs.rmSync(stateA, { recursive: true, force: true });
    }
  }

  // ---- test 15 (#670): read_image — real pixels in front of the model ----
  // The #508 Pass B r2 finding: pixel statistics are mirror-invariant, so a
  // game shipped with every glyph mirrored as "HUD confirmed". read_image
  // transports a file's EXACT bytes as an image content block; these legs pin
  // the transport (byte-exact base64, media type by magic), the capability
  // gate, the honest refusals, and the strip-and-retry belt for providers
  // that reject images. The transport legs are the verification-independence
  // contract: the tool must never transform pixels, only carry them.
  {
    // minimal PNG writer (real zlib IDAT — the bytes must round-trip, and a
    // hand-faked IDAT would still round-trip; what matters is the header is
    // REAL so the sniff reads real dimensions)
    const zlib = await import('node:zlib');
    const crc32 = (buf) => {
      let c; const table = [];
      for (let n = 0; n < 256; n++) {
        c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
      }
      let crc = 0xFFFFFFFF;
      for (const b of buf) crc = table[(crc ^ b) & 0xFF] ^ (crc >>> 8);
      return (crc ^ 0xFFFFFFFF) >>> 0;
    };
    const chunk = (type, data) => {
      const t = Buffer.from(type, 'ascii');
      const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
      const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
      return Buffer.concat([len, t, data, crc]);
    };
    const mkpng = (w, h) => {
      const ihdr = Buffer.alloc(13);
      ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
      ihdr[8] = 8; ihdr[9] = 6;                       // 8-bit RGBA
      const raw = Buffer.alloc(h * (1 + w * 4));
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++)
          Buffer.from([255, 0, 0, 255]).copy(raw, y * (1 + w * 4) + 1 + x * 4);
      return Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
        chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
    };
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gcode-670-'));
    const pngPath = path.join(tmp, 'shot.png');
    const pngBytes = mkpng(16, 8);
    fs.writeFileSync(pngPath, pngBytes);
    const lastToolResult = (body) => {
      const m = body.messages[body.messages.length - 1];
      return Array.isArray(m.content) ? m.content.find((b) => b.type === 'tool_result') : null;
    };
    const hasReadImage = (body) => (body.tools || []).some((t) => t.name === 'read_image');

    // -- leg A: byte-exact transport + block shape (the core contract) ------
    {
      const srv = await startServer([
        toolUseResponse('looking', 'toolu_670a', 'read_image', { path: pngPath }),
        textResponse('I looked at it.'),
      ]);
      const { stderr } = await runCodeBoth(srv.url, ['-p', 'look at the shot', '--no-color', '--no-persist']);
      srv.close();
      check(hasReadImage(srv.bodies[0]), '#670: read_image is offered on the (vision) default model');
      check(!/read_image.*disabled|does not support image input/.test(stderr),
        '#670: no disabled-vision note on a vision model');
      const tr = lastToolResult(srv.bodies[1]);
      check(!!tr && tr.tool_use_id === 'toolu_670a' && Array.isArray(tr.content),
        '#670: the image tool_result content is a block ARRAY');
      const img = tr && Array.isArray(tr.content) ? tr.content[0] : null;
      check(!!img && img.type === 'image' && img.source?.type === 'base64'
        && img.source?.media_type === 'image/png',
        '#670: image block shape — type/source/base64/media_type');
      check(!!img && Buffer.from(img.source.data, 'base64').equals(pngBytes),
        '#670: the base64 decodes to the EXACT file bytes (no transform, no re-encode)');
      const capText = tr && Array.isArray(tr.content) ? tr.content[1] : null;
      check(!!capText && capText.type === 'text' && capText.text.includes('16x8')
        && capText.text.includes(`${pngBytes.length} bytes`),
        '#670: the caption text block names dimensions and byte count');
    }

    // -- leg B: media type comes from the MAGIC, never the file name --------
    {
      const fakePng = path.join(tmp, 'liar.png');
      // a JPEG header (SOI + APP0 + SOF0 500x800) wearing a .png name
      fs.writeFileSync(fakePng, Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x04, 0, 0,
        0xFF, 0xC0, 0x00, 0x0B, 8, 0x01, 0xF4, 0x03, 0x20, 1, 0, 0, 0]));
      const srv = await startServer([
        toolUseResponse('looking', 'toolu_670b', 'read_image', { path: fakePng }),
        textResponse('ok.'),
      ]);
      await runCode(srv.url, ['-p', 'look', '--no-color', '--no-persist']);
      srv.close();
      const img = lastToolResult(srv.bodies[1])?.content?.[0];
      check(!!img && img.source?.media_type === 'image/jpeg',
        '#670: a JPEG named .png is sent as image/jpeg (content decides, not the name)');
    }

    // -- leg C: honest refusals, each a STRING result naming the reason -----
    {
      const textFile = path.join(tmp, 'notes.txt');
      fs.writeFileSync(textFile, 'just text\n');
      const hugePng = path.join(tmp, 'huge.png');       // header claims 9000 px
      const hugeIhdr = Buffer.alloc(13);
      hugeIhdr.writeUInt32BE(9000, 0); hugeIhdr.writeUInt32BE(10, 4);
      hugeIhdr[8] = 8; hugeIhdr[9] = 6;
      fs.writeFileSync(hugePng, Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), chunk('IHDR', hugeIhdr)]));
      const fatPng = path.join(tmp, 'fat.png');         // over the byte cap
      fs.writeFileSync(fatPng, Buffer.concat([pngBytes, Buffer.alloc(4 * 1024 * 1024)]));
      const srv = await startServer([
        toolUseResponse('a', 'toolu_670c1', 'read_image', { path: textFile }),
        toolUseResponse('b', 'toolu_670c2', 'read_image', { path: path.join(tmp, 'absent.png') }),
        toolUseResponse('c', 'toolu_670c3', 'read_image', { path: hugePng }),
        toolUseResponse('d', 'toolu_670c4', 'read_image', { path: fatPng }),
        textResponse('done refusing.'),
      ]);
      await runCode(srv.url, ['-p', 'try them', '--no-color', '--no-persist']);
      srv.close();
      const trOf = (i) => lastToolResult(srv.bodies[i]);
      check(typeof trOf(1)?.content === 'string' && trOf(1).content.includes('not a recognized image'),
        '#670: a non-image refuses by content sniff (string result, no image block)');
      check(typeof trOf(2)?.content === 'string' && trOf(2).content.startsWith('error: cannot open'),
        '#670: a missing file errors with errno');
      check(typeof trOf(3)?.content === 'string' && /9000x10.*8000/.test(trOf(3).content),
        '#670: an over-dimension image refuses naming its size and the limit');
      check(typeof trOf(4)?.content === 'string' && /larger than the \d+-byte cap/.test(trOf(4).content)
        && trOf(4).content.includes('wmctl shot'),
        '#670: an oversize image refuses naming the cap and the region-crop fix');
      fs.rmSync(fatPng, { force: true });
    }

    // -- leg D: the capability gate (table + GCODE_VISION override) ---------
    {
      // deepseek: measured no-vision (images silently swallowed server-side)
      let srv = await startServer([textResponse('hi.')]);
      let r = await runCodeBoth(srv.url, ['-p', 'hi', '--no-color', '--no-persist',
        '--model', 'deepseek-v4-flash']);
      srv.close();
      check(!hasReadImage(srv.bodies[0]), '#670: deepseek gets NO read_image tool');
      check(r.stderr.includes('does not support image input'),
        '#670: the disabled gate is LOUD at startup (deepseek)');
      // read_file on an image under a blind model says so honestly
      srv = await startServer([
        toolUseResponse('r', 'toolu_670d1', 'read_file', { path: pngPath }),
        textResponse('understood.'),
      ]);
      await runCode(srv.url, ['-p', 'read the png', '--no-color', '--no-persist',
        '--model', 'deepseek-v4-flash']);
      srv.close();
      const tr = lastToolResult(srv.bodies[1]);
      check(typeof tr?.content === 'string' && tr.content.includes('cannot show it')
        && tr.content.includes('statistics'),
        '#670: read_file on an image under a blind model says it cannot see (no statistics substitute)');
      // GCODE_VISION=1 forces the tool on (the wrong-table escape hatch)
      srv = await startServer([textResponse('hi.')]);
      await runCode(srv.url, ['-p', 'hi', '--no-color', '--no-persist',
        '--model', 'deepseek-v4-flash'], { GCODE_VISION: '1' });
      srv.close();
      check(hasReadImage(srv.bodies[0]), '#670: GCODE_VISION=1 forces read_image on');
      // GCODE_VISION=0 forces it off, loudly, even on a vision model
      srv = await startServer([textResponse('hi.')]);
      r = await runCodeBoth(srv.url, ['-p', 'hi', '--no-color', '--no-persist'], { GCODE_VISION: '0' });
      srv.close();
      check(!hasReadImage(srv.bodies[0]) && r.stderr.includes('GCODE_VISION=0'),
        '#670: GCODE_VISION=0 forces read_image off, loudly');
      // an unknown model defaults off with the enable hint
      srv = await startServer([textResponse('hi.')]);
      r = await runCodeBoth(srv.url, ['-p', 'hi', '--no-color', '--no-persist',
        '--model', 'mystery-9']);
      srv.close();
      check(!hasReadImage(srv.bodies[0]) && r.stderr.includes('not known to support image input'),
        '#670: an unknown model defaults off with the GCODE_VISION=1 hint');
      // a model that names the tool anyway (or a resumed session) is refused
      srv = await startServer([
        toolUseResponse('sneaky', 'toolu_670d2', 'read_image', { path: pngPath }),
        textResponse('ok.'),
      ]);
      await runCode(srv.url, ['-p', 'look', '--no-color', '--no-persist',
        '--model', 'deepseek-v4-flash']);
      srv.close();
      const tr2 = lastToolResult(srv.bodies[1]);
      check(typeof tr2?.content === 'string' && tr2.content.includes('read_image is disabled'),
        '#670: a gated-off read_image call is refused as a string, never an image block');
    }

    // -- leg E: read_file on an image redirects to read_image (vision on) ---
    {
      const srv = await startServer([
        toolUseResponse('r', 'toolu_670e', 'read_file', { path: pngPath }),
        textResponse('redirected.'),
      ]);
      await runCode(srv.url, ['-p', 'read the png', '--no-color', '--no-persist']);
      srv.close();
      const tr = lastToolResult(srv.bodies[1]);
      check(typeof tr?.content === 'string' && tr.content.includes('image/png')
        && tr.content.includes('read_image'),
        '#670: read_file on an image redirects to read_image by content sniff');
    }

    // -- leg F: an image round persists and --resume replays it intact ------
    {
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcode-670f-'));
      let srv = await startServer([
        toolUseResponse('looking', 'toolu_670f', 'read_image', { path: pngPath }),
        textResponse('seen.'),
      ]);
      await runCode(srv.url, ['-p', 'look', '--no-color'], { GCODE_STATE_DIR: stateDir });
      srv.close();
      const sessDir = path.join(stateDir, 'sessions');
      const logFile = fs.readdirSync(sessDir).filter((f) => f.endsWith('.jsonl'))[0];
      srv = await startServer([textResponse('resumed.')]);
      const { stderr } = await runCodeBoth(srv.url,
        ['--resume', path.join(sessDir, logFile), '-p', 'go on', '--no-color'],
        { GCODE_STATE_DIR: stateDir });
      srv.close();
      const sent = srv.bodies[0] ? srv.bodies[0].messages : [];
      const rtr = sent.flatMap((m) => (Array.isArray(m.content) ? m.content : []))
        .find((b) => b.type === 'tool_result' && b.tool_use_id === 'toolu_670f');
      check(!!rtr && Array.isArray(rtr.content)
        && Buffer.from(rtr.content[0]?.source?.data ?? '', 'base64').equals(pngBytes),
        '#670: --resume replays the image block byte-identical');
      check(!/session repaired|tool_result\(s\)/.test(stderr),
        '#670: the resumed image round needs no repair (structurally valid history)');
      fs.rmSync(stateDir, { recursive: true, force: true });
    }

    // -- leg G: compaction folds an image round to its caption --------------
    // The #467 leg-A numbers with the image as round 1: the fold must drop
    // the base64 payload and keep the caption line in the summary.
    {
      const usageToolNamed = (id, name, input, usage) =>
        sse('message_start', { message: { id: `msg_${id}`, model: 'compact-model', usage: { input_tokens: 5, output_tokens: 0 } } })
        + sse('content_block_start', { index: 0, content_block: { type: 'tool_use', id, name, input: {} } })
        + sse('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } })
        + sse('content_block_stop', { index: 0 })
        + sse('message_delta', { delta: { stop_reason: 'tool_use' }, usage })
        + sse('message_stop', {});
      const srv = await startServer([
        usageToolNamed('t670g1', 'read_image', { path: pngPath },
          { output_tokens: 2, input_tokens: 300, cache_read_input_tokens: 200 }),
        usageToolNamed('t670g2', 'bash', { command: 'true' },
          { output_tokens: 2, input_tokens: 200, cache_creation_input_tokens: 300, cache_read_input_tokens: 15800 }),
        usageToolNamed('t670g3', 'bash', { command: 'true' },
          { output_tokens: 2, input_tokens: 400, cache_read_input_tokens: 100 }),
        textResponse('compacted past the image.'),
      ]);
      const imageData = pngBytes.toString('base64');
      await runCodeBoth(srv.url, ['-p', 'long visual session', '--no-color', '--no-persist',
        '--max-tokens', '2000'], { GCODE_CONTEXT_TOKENS: '20000' });
      srv.close();
      check(srv.bodies.length === 4, `#670: the compaction session ran all 4 rounds (${srv.bodies.length})`);
      const sent = JSON.stringify(srv.bodies[2] ? srv.bodies[2].messages : []);
      check(srv.bodies[1] && JSON.stringify(srv.bodies[1].messages).includes(imageData),
        '#670: round 2 still carried the image payload');
      check(sent.includes('[gcode: compacted history]') && !sent.includes(imageData),
        '#670: the fold DROPS the base64 payload');
      // NB the caption must be pinned by its ": media WxH" tail — the summary's
      // "tool: read_image PATH" line already contains the substring
      // "image PATH", so a path-only check is vacuous (caught by mutation).
      check(sent.includes(`${pngPath}: image/png 16x8`) && !sent.includes('t670g1'),
        '#670: the folded image round leaves its caption in the summary');
    }

    // -- leg H: a provider that REJECTS images -> strip and retry once ------
    // (the belt; the DeepSeek measurement shows the silent-swallow case that
    // only the gate can catch, so leg D is the primary defense)
    {
      const srv = await startServer([
        toolUseResponse('looking', 'toolu_670h', 'read_image', { path: pngPath }),
        { status: 400, body: '{"type":"error","error":{"type":"invalid_request_error","message":"messages.1.content.0.image: this model does not support image input"}}' },
        textResponse('recovered without the image.'),
      ]);
      const { stdout, stderr } = await runCodeBoth(srv.url,
        ['-p', 'look then continue', '--no-color', '--no-persist'], { GCODE_VISION: '1' });
      srv.close();
      check(srv.bodies.length === 3, `#670: the image rejection retried exactly once (${srv.bodies.length} requests)`);
      const rejected = JSON.stringify(srv.bodies[1] ? srv.bodies[1].messages : []);
      const retried = JSON.stringify(srv.bodies[2] ? srv.bodies[2].messages : []);
      check(rejected.includes('"image"'), '#670: the rejected request really carried the image');
      check(!retried.includes('"type":"image"') && retried.includes('provider rejected image input'),
        '#670: the retry carries the loud marker instead of the image');
      check(stderr.includes('removed 1 image'), '#670: the strip says what it removed');
      check(stdout.includes('recovered without the image.'),
        '#670: the session SURVIVES the image rejection');
    }

    // -- leg H negative control: a 400 without image wording never strips ---
    {
      const srv = await startServer([
        toolUseResponse('looking', 'toolu_670i', 'read_image', { path: pngPath }),
        { status: 400, body: '{"type":"error","error":{"type":"invalid_request_error","message":"max_tokens: invalid value"}}' },
      ]);
      const { stderr } = await runCodeBoth(srv.url,
        ['-p', 'look', '--no-color', '--no-persist']);
      srv.close();
      check(srv.bodies.length === 2, `#670 negative control: no strip-retry on an unrelated 400 (${srv.bodies.length} requests)`);
      check(stderr.includes('retrying cannot succeed') && !stderr.includes('removed 1 image'),
        '#670 negative control: the permanent verdict is unchanged, the images stay');
    }

    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // ---- #738: thinking blocks replay, empty text blocks never ship ------
  // The defect: every non-tool_use block was collapsed to text, thinking_delta
  // was never read, so a thinking block replayed as {"type":"text","text":""}
  // and the Messages API refused the whole request. gcode reports that 400 as
  // permanent, so the turn died. Reproduced 3/3 live (#678 Pass B round 3).
  {
    const tmp738 = fs.mkdtempSync(path.join(os.tmpdir(), 'gcode-738-'));

    // -- leg A: the live reproduction, against a server that enforces the rule
    {
      const srv = await startStrictServer([
        thinkingToolUseResponse('', 'SIGLIVE', 'toolu_738a', 'write_file',
          { path: path.join(tmp738, 'a.txt'), content: 'hi' }),
        textResponse('finished the build.'),
      ]);
      const { stdout, stderr } = await runCodeBoth(srv.url,
        ['-p', 'build it', '--no-color', '--no-persist']);
      srv.close();
      // The turn COMPLETES: before the fix the strict server 400s round 2 and
      // gcode prints "retrying cannot succeed" instead of ever reaching here.
      check(stdout.includes('finished the build.'),
        '#738: a thinking-then-tool_use round completes end to end');
      check(!stderr.includes('retrying cannot succeed'),
        '#738: no permanent-rejection verdict on the replayed round');
      // Not a reproduction leg (base gcode also sends 2 requests — the second
      // is the one that 400s). What it pins is the SHAPE of the fix: a
      // repair-and-retry that let the bad body go out and recovered on the
      // rebound would cost a third round, and would keep shipping a body the
      // API refuses. The fix must be at construction, not at recovery.
      check(srv.bodies.length === 2 && stdout.includes('finished the build.'),
        `#738: two rounds, no 400-and-retry detour (${srv.bodies.length})`);
      const replay = srv.bodies[1] ? srv.bodies[1].messages : [];
      const flat = replay.flatMap((m) => Array.isArray(m.content) ? m.content : []);
      check(!flat.some((b) => b.type === 'text' && b.text === ''),
        '#738: the replayed history carries NO empty text block');
      const think = flat.find((b) => b.type === 'thinking');
      check(!!think && think.signature === 'SIGLIVE',
        '#738: the thinking block is replayed as thinking, signature preserved');
      check(!!think && think.thinking === '',
        '#738: an empty thinking body is preserved, not dropped (display:"omitted")');
    }

    // -- leg B: a summarized thinking body round-trips unchanged -----------
    {
      const srv = await startStrictServer([
        thinkingToolUseResponse('weigh the options', 'SIGSUM', 'toolu_738b', 'write_file',
          { path: path.join(tmp738, 'b.txt'), content: 'hi' }),
        textResponse('done b.'),
      ]);
      const { stdout, stderr } = await runCodeBoth(srv.url,
        ['-p', 'build it', '--no-color', '--no-persist']);
      srv.close();
      const flat = (srv.bodies[1] ? srv.bodies[1].messages : [])
        .flatMap((m) => Array.isArray(m.content) ? m.content : []);
      const think = flat.find((b) => b.type === 'thinking');
      check(stdout.includes('done b.') && !!think && think.thinking === 'weigh the options'
            && think.signature === 'SIGSUM',
        '#738: a summarized thinking body replays verbatim with its signature');
      // The summary must not be laundered into the stdout transcript as if it
      // were the assistant's answer — that was the other half of the collapse.
      check(stdout.includes('done b.') && !stdout.includes('weigh the options'),
        '#738: thinking is not printed as assistant prose on stdout');
      // It DOES reach stderr (a summary must not be silently swallowed), and
      // its line is closed before the tool marker — a run-on there is the
      // same rendering shape #301/#302 fixed.
      const kline = stderr.split('\n').find((l) => l.includes('weigh the options'));
      check(!!kline && !kline.includes('write_file'),
        '#738: a streamed thinking summary reaches stderr on its own line');
    }

    // -- leg C: strict-server control — the rule really does reject ---------
    // Proves the instrument can produce a RED. Without this leg a fake that
    // silently accepted anything would make legs A and B vacuous.
    {
      const emptyText = sse('message_start', { message: { id: 'msg_e', role: 'assistant', content: [] } })
        + sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
        + sse('content_block_stop', { index: 0 })
        + sse('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'toolu_738c', name: 'write_file', input: {} } })
        + sse('content_block_delta', { index: 1, delta: { type: 'input_json_delta',
            partial_json: JSON.stringify({ path: path.join(tmp738, 'c.txt'), content: 'hi' }) } })
        + sse('content_block_stop', { index: 1 })
        + sse('message_delta', { delta: { stop_reason: 'tool_use' } })
        + sse('message_stop', {});
      const srv = await startStrictServer([emptyText, textResponse('unreachable.')]);
      const { stdout } = await runCodeBoth(srv.url,
        ['-p', 'build it', '--no-color', '--no-persist']);
      srv.close();
      // gcode itself now drops the empty text block on the way out, so the
      // strict server never sees one and the turn survives. What this leg
      // pins is that the SERVER's rule is live: bodies[1] reaching it at all
      // means the drop happened client-side.
      const flat = (srv.bodies[1] ? srv.bodies[1].messages : [])
        .flatMap((m) => Array.isArray(m.content) ? m.content : []);
      check(srv.bodies.length === 2 && !flat.some((b) => b.type === 'text' && b.text === ''),
        '#738: a genuinely empty text block from the provider is dropped, not forwarded');
      check(stdout.includes('unreachable.'),
        '#738: and the round it came from still completes');
    }

    fs.rmSync(tmp738, { recursive: true, force: true });
  }

  // ---- #747: prompt-cache breakpoints ---------------------------------
  // gcode sent no cache_control at all, so every round re-paid for every
  // round before it. Measured cacheRead 0 across 7 Anthropic rounds (#678
  // Pass B r3). Invisible on DeepSeek, which auto-caches server-side.
  {
    const tmp747 = fs.mkdtempSync(path.join(os.tmpdir(), 'gcode-747-'));
    const bpsIn = (body) => {
      let n = 0;
      const walk = (blocks) => { for (const b of blocks || []) if (b && b.cache_control) n++; };
      if (Array.isArray(body.system)) walk(body.system);
      walk(body.tools);
      for (const m of body.messages || []) if (Array.isArray(m.content)) walk(m.content);
      return n;
    };

    // -- leg A: three rounds. Breakpoints in the right places, never over the
    //    4-per-request ceiling, and the history one MOVES rather than piling up.
    {
      const srv = await startServer([
        toolUseResponse('one', 'toolu_747a', 'write_file', { path: path.join(tmp747, '1'), content: 'x' }),
        toolUseResponse('two', 'toolu_747b', 'write_file', { path: path.join(tmp747, '2'), content: 'x' }),
        textResponse('all done.'),
      ]);
      const { stdout } = await runCodeBoth(srv.url, ['-p', 'go', '--no-color', '--no-persist']);
      srv.close();
      check(stdout.includes('all done.') && srv.bodies.length === 3,
        `#747: the three-round turn completes (${srv.bodies.length} rounds)`);
      const [r1, r2, r3] = srv.bodies;

      // system carries the breakpoint that covers tools + system
      check(Array.isArray(r1.system) && r1.system.length === 1
            && r1.system[0].type === 'text'
            && r1.system[0].cache_control && r1.system[0].cache_control.type === 'ephemeral',
        '#747: system is a block array with an ephemeral breakpoint (tools+system prefix)');
      check(typeof r1.system[0].text === 'string' && r1.system[0].text.length > 100,
        '#747: the system prompt text is unchanged by the reshaping');

      // round 1 has one message, so no history breakpoint yet
      check(bpsIn(r1) === 1, `#747: round 1 marks the stable prefix only (${bpsIn(r1)} breakpoints)`);
      // later rounds add exactly one moving history breakpoint
      check(bpsIn(r2) === 2 && bpsIn(r3) === 2,
        `#747: rounds 2-3 add exactly one history breakpoint (${bpsIn(r2)}, ${bpsIn(r3)})`);
      check(bpsIn(r1) <= 4 && bpsIn(r2) <= 4 && bpsIn(r3) <= 4,
        '#747: never exceeds the 4-breakpoint-per-request ceiling');

      // the history breakpoint is on the LAST block of the LAST message, and
      // it MOVED between rounds — a stationary one caches nothing new, and a
      // stale one left behind is what would eventually blow the ceiling.
      const lastMarked = (b) => {
        const m = b.messages[b.messages.length - 1];
        const c = Array.isArray(m.content) ? m.content : [];
        return c.length && c[c.length - 1].cache_control ? b.messages.length : -1;
      };
      check(lastMarked(r2) === r2.messages.length && lastMarked(r3) === r3.messages.length,
        '#747: the history breakpoint sits on the last block of the last message');
      check(r3.messages.length > r2.messages.length,
        `#747: and it moved forward with the conversation (${r2.messages.length} -> ${r3.messages.length})`);

      // 🔴 The one that would rot silently: an EARLIER round's marker must not
      // survive into a later request. `messages` is attached by reference and
      // persisted, so a leaked marker accumulates one slot per round.
      const stale = r3.messages.slice(0, -1)
        .flatMap((m) => Array.isArray(m.content) ? m.content : [])
        .filter((b) => b && b.cache_control).length;
      check(stale === 0, `#747: no stale breakpoint left on earlier messages (${stale} found)`);
    }

    // -- leg B: the persisted session log must be marker-free ---------------
    // The #348 record contract: `messages` is the live history AND the thing
    // that gets written to disk. A marker left on it would be replayed by
    // --resume, one per round, forever.
    {
      const state = fs.mkdtempSync(path.join(os.tmpdir(), 'gcode-747-state-'));
      const srv = await startServer([
        toolUseResponse('one', 'toolu_747c', 'write_file', { path: path.join(tmp747, '3'), content: 'x' }),
        textResponse('logged.'),
      ]);
      await runCodeBoth(srv.url, ['-p', 'go', '--no-color'], { GCODE_STATE_DIR: state });
      srv.close();
      const logs = fs.readdirSync(path.join(state, 'sessions'));
      const text = logs.map((f) => fs.readFileSync(path.join(state, 'sessions', f), 'utf8')).join('');
      check(logs.length === 1 && text.length > 0 && !text.includes('cache_control'),
        '#747: the persisted session log carries no cache_control marker');
      fs.rmSync(state, { recursive: true, force: true });
    }

    // -- leg C: GCODE_CACHE=0 restores the byte-identical pre-#747 body -----
    // The escape hatch exists because array-form `system` is canonical
    // Messages API but untested against the third-party Anthropic-compatible
    // endpoints gcode also targets — and one of those is the standing route.
    {
      const srv = await startServer([
        toolUseResponse('one', 'toolu_747d', 'write_file', { path: path.join(tmp747, '4'), content: 'x' }),
        textResponse('uncached.'),
      ]);
      const { stdout } = await runCodeBoth(srv.url,
        ['-p', 'go', '--no-color', '--no-persist'], { GCODE_CACHE: '0' });
      srv.close();
      check(stdout.includes('uncached.'), '#747: the turn still completes with caching off');
      check(typeof srv.bodies[0].system === 'string',
        '#747: GCODE_CACHE=0 sends system as a bare string again');
      check(srv.bodies.every((b) => bpsIn(b) === 0),
        '#747: GCODE_CACHE=0 sends no breakpoint anywhere');
    }

    // -- leg D: an EMPTY GCODE_CACHE means UNSET, not off -------------------
    // Matches the GCODE_VISION rule (`s && *s`). An exported-but-blank
    // variable disabling a feature is a surprise nobody would debug quickly.
    {
      const srv = await startServer([textResponse('still cached.')]);
      await runCodeBoth(srv.url, ['-p', 'go', '--no-color', '--no-persist'], { GCODE_CACHE: '' });
      srv.close();
      check(Array.isArray(srv.bodies[0].system) && bpsIn(srv.bodies[0]) === 1,
        '#747: an empty GCODE_CACHE leaves caching ON (empty means unset)');
    }

    fs.rmSync(tmp747, { recursive: true, force: true });
  }

  console.log(failures === 0 ? '\nPASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
