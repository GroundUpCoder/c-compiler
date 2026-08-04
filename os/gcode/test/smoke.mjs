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
function startServer(scripts) {
  const bodies = [];
  const raw = [];   // request bodies as Buffers — #386 asserts UTF-8 validity byte-level
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      raw.push(buf);
      bodies.push(JSON.parse(buf.toString('utf8')));
      const body = scripts.shift();
      if (body === undefined) { res.writeHead(500); res.end('no script'); return; }
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
// prompt, tool blocks, Cost line, and the diff renderer).
async function runCodeBoth(url, args, env = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      env: { ...process.env, ANTHROPIC_BASE_URL: url, ANTHROPIC_API_KEY: 'test',
             ASAN_OPTIONS: 'detect_leaks=0', ...env },
      encoding: 'utf8', timeout: 15000,
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

  console.log(failures === 0 ? '\nPASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
