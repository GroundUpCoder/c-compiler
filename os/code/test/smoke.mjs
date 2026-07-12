// Native smoke test for /bin/code (todos/0174) — no network, no API key.
// Starts a scripted fake /v1/messages SSE server, builds code.c natively
// (real libcurl + cJSON), and drives it through a text turn and a tool-use
// round-trip. This is the reference-oracle harness; test_code_e2e.js will
// reuse the same server shape against the in-OS build.
//
// Run: node os/code/test/smoke.mjs   (exit 0 = pass)

import http from 'node:http';
import { execFileSync, execFile } from 'node:child_process';
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
function startServer(scripts) {
  const bodies = [];
  const server = http.createServer((req, res) => {
    let buf = '';
    req.on('data', (c) => (buf += c));
    req.on('end', () => {
      bodies.push(JSON.parse(buf));
      const body = scripts.shift();
      if (body === undefined) { res.writeHead(500); res.end('no script'); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(body);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}`, bodies, close: () => server.close() });
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

  console.log(failures === 0 ? '\nPASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
