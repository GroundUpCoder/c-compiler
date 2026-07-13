'use strict';
// A scripted fake Anthropic /v1/messages SSE server (todos/0174) — the
// standalone-process twin of the inline server in os/code/test/smoke.mjs.
// The kernel e2e drives os/boot.js with spawnSync, which would deadlock an
// in-process server (the smoke.mjs lesson, inverted) — so this runs as its
// own child: `node fake_anthropic.js <script.json> <bodies.jsonl>` prints
// "PORT <n>" when listening, serves one scripted response per POST (in
// order), and appends each request body as a JSON line to <bodies.jsonl>
// for the caller's assertions.
//
// script.json: an array of either
//   { "kind": "text", "text": "..." }
//   { "kind": "tool", "preface": "...", "id": "toolu_x", "name": "bash",
//     "input": {...} }   (input json split in two partials on the wire)
const fs = require('fs');
const http = require('http');

const [scriptPath, bodiesPath] = process.argv.slice(2);
const scripts = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
fs.writeFileSync(bodiesPath, '');

function sse(type, obj) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...obj })}\n\n`;
}
function render(s) {
  if (s.kind === 'text') {
    return sse('message_start', { message: { id: 'msg', role: 'assistant', content: [] } })
      + sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
      + sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: s.text } })
      + sse('content_block_stop', { index: 0 })
      + sse('message_delta', { delta: { stop_reason: 'end_turn' } })
      + sse('message_stop', {});
  }
  const json = JSON.stringify(s.input);
  const mid = Math.floor(json.length / 2);
  return sse('message_start', { message: { id: 'msg', role: 'assistant', content: [] } })
    + sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
    + sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: s.preface } })
    + sse('content_block_stop', { index: 0 })
    + sse('content_block_start', { index: 1, content_block: { type: 'tool_use', id: s.id, name: s.name, input: {} } })
    + sse('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: json.slice(0, mid) } })
    + sse('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: json.slice(mid) } })
    + sse('content_block_stop', { index: 1 })
    + sse('message_delta', { delta: { stop_reason: 'tool_use' } })
    + sse('message_stop', {});
}

let n = 0;
const server = http.createServer((req, res) => {
  let buf = '';
  req.on('data', (c) => (buf += c));
  req.on('end', () => {
    fs.appendFileSync(bodiesPath, buf.replace(/\n/g, ' ') + '\n');
    const s = scripts[n++];
    if (!s) { res.writeHead(500); res.end('script exhausted'); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(render(s));
  });
});
server.listen(0, '127.0.0.1', () => {
  console.log('PORT ' + server.address().port);
});
