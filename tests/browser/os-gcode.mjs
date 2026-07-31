// #301 browser acceptance: /bin/gcode's CLI UX inside gucOS — ANSI colour,
// streaming, scrollback — driven end to end under Playwright against a canned
// SSE fixture (the os/gcode/test/smoke.mjs server shape: scripted
// /v1/messages responses, one per POST, no network, no real API key).
//
// The fixture server runs IN THIS PROCESS on 127.0.0.1 and answers the CORS
// preflight, because the fetch comes from the kernel worker (kernel.js
// defaults to global fetch when the embedder passes no `fetch` opt) whose
// origin is the serve.js port — a cross-origin POST with custom headers.
//
// Interaction is REAL page input throughout (the os-egress rule: driver
// shortcuts prove nothing): typing rides page.keyboard through the focused
// term window's canvas->ring->SDL->pty path, scrollback rides plain
// PageUp/PageDown (term.c:939), the resize is a real SE-corner mouse drag.
// Screenshots land in build/test-browser/gcode-shots/ — they are the #301
// deliverable ("demonstrated by screenshot, not asserted"); the assertions
// here pin the machine-checkable substrate (server round-trips, colour
// pixels appearing, view changing and snapping) so the file stays a live
// sweep guard after the assessment ships.
//
// Ctrl+C mid-stream is exercised but NOT asserted as an interrupt: the in-OS
// libcurl veneer retries on EINTR (wait_step, os/curl/libcurl.c:200) and has
// no progress callback, so gcode's g_interrupted flag is never consulted
// in-OS — the leg records whether the transfer died early and only asserts
// gcode survives. (Native gcode aborts via CURLOPT_XFERINFOFUNCTION; that
// option is unknown to the veneer.)
//
// Usage: node os-gcode.mjs
import fs from 'fs';
import http from 'node:http';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { startServer, launchBrowser, waitForServer, makeCheck, osHelpers, osUrl } from './lib/os-harness.mjs';

const PORT = 3299;
const URL = osUrl(PORT);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.resolve(__dirname, '../../build/test-browser/gcode-shots');
fs.mkdirSync(SHOTS, { recursive: true });

// ---- SSE builders (the smoke.mjs shapes) ------------------------------
function sse(type, obj) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...obj })}\n\n`;
}
function textResponse(text) {
  // split into 3 deltas so the in-OS pipeline streams more than one chunk
  const third = Math.max(1, Math.floor(text.length / 3));
  return sse('message_start', { message: { id: 'msg_t', role: 'assistant', content: [] } })
    + sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
    + sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: text.slice(0, third) } })
    + sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: text.slice(third, 2 * third) } })
    + sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: text.slice(2 * third) } })
    + sse('content_block_stop', { index: 0 })
    + sse('message_delta', { delta: { stop_reason: 'end_turn' } })
    + sse('message_stop', {});
}
function toolUseResponse(preface, id, name, inputObj) {
  const json = JSON.stringify(inputObj);
  const mid = Math.floor(json.length / 2);
  return sse('message_start', { message: { id: 'msg_u', role: 'assistant', content: [] } })
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

// The long reply: an early sentinel that must scroll into history, a >80-col
// line that must wrap (each wrapped row becomes its own captured-width
// history line), then enough numbered lines to push ~40 rows off the top.
function longText() {
  // sentinel + wrap line FIRST: the deep-scroll screenshots clamp to the top
  // of history, so the earliest lines are the ones the shots must show.
  const lines = ['SCROLL-TOP-SENTINEL alpha bravo charlie'];
  lines.push('WRAP-BEGIN-' + 'abcdefghij'.repeat(15) + '-WRAP-END');
  for (let i = 3; i <= 58; i++) lines.push(`L${String(i).padStart(3, '0')} ${'-'.repeat(24)} mid`);
  lines.push('STREAM-END');
  return lines.join('\n');
}

// Scripted fixture server with CORS (kernel-worker fetch is cross-origin).
// Scripts: a string (whole SSE body at once) or {pre, delayMs, rest} (stall
// mid-stream). Exhausted queue answers 500 — that IS a scripted leg (the
// CRED error path). Tracks parsed request bodies + early-close flags.
function startSse(scripts) {
  const bodies = [];
  const stall = { closedEarly: false, restWritten: false };
  const server = http.createServer((req, res) => {
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': req.headers['access-control-request-headers'] || '*',
      'access-control-allow-methods': 'POST, OPTIONS',
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    let buf = '';
    req.on('data', (c) => (buf += c));
    req.on('end', () => {
      try { bodies.push(JSON.parse(buf)); } catch { bodies.push({ raw: buf }); }
      const script = scripts.shift();
      if (script === undefined) { res.writeHead(500, cors); res.end('no script'); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream', ...cors });
      if (typeof script === 'string') { res.end(script); return; }
      res.write(script.pre);
      let closed = false;
      res.on('close', () => { closed = true; if (!stall.restWritten) stall.closedEarly = true; });
      setTimeout(() => {
        if (!closed) { stall.restWritten = true; res.end(script.rest); }
      }, script.delayMs);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ port: server.address().port, bodies, stall, close: () => server.close() });
    });
  });
}

const STALL = {
  pre: sse('message_start', { message: { id: 'msg_s', role: 'assistant', content: [] } })
    + sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
    + sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'STALL-PART one, stream now holds for 8s...' } }),
  delayMs: 8000,
  rest: sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: ' STALL-DONE.' } })
    + sse('content_block_stop', { index: 0 })
    + sse('message_delta', { delta: { stop_reason: 'end_turn' } })
    + sse('message_stop', {}),
};

const srv = await startSse([
  textResponse('VT1 hello — colours over the tty. END-VT1'),
  toolUseResponse('Let me run it.', 'toolu_b1', 'bash', { command: 'echo hello-gcode' }),
  textResponse('The command printed hello-gcode. TOOL-TURN-DONE'),
  textResponse(longText()),
  STALL,
]);

const server = startServer(PORT);
const browser = await launchBrowser();
const { check, state } = makeCheck();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await waitForServer(URL, { tries: 240, interval: 500 });
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const page = await context.newPage();
  page.on('console', m => { if (m.type() === 'error') process.stderr.write('[page] ' + m.text() + '\n'); });

  await page.goto(URL);
  await page.waitForFunction(() => window.__osState === 'ready', { timeout: 180000, polling: 250 });
  check('boots to ready', true);
  await page.waitForFunction(() => /~ #/.test(window.__osOut), { timeout: 30000, polling: 200 });

  const { setVt, sample, near, waitOut, waitScreen } = osHelpers(page);

  // Region scanners over the composited canvas (the drawImage trick — a
  // bare page.screenshot of the transferred OffscreenCanvas is blank).
  const scan = (x, y, w, h, predSrc) => page.evaluate(([rx, ry, rw, rh, ps]) => {
    const c = document.getElementById('screen');
    const s = window.__osScreen || { w: 0, h: 0 };
    const r = c.getBoundingClientRect();
    const t = document.createElement('canvas');
    t.width = Math.max(Math.round(r.width), s.w);
    t.height = Math.max(Math.round(r.height), s.h);
    const ctx = t.getContext('2d');
    ctx.drawImage(c, 0, 0);
    const d = ctx.getImageData(rx, ry, rw, rh).data;
    const pred = new Function('r', 'g', 'b', 'return ' + ps);
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (pred(d[i], d[i + 1], d[i + 2])) n++;
    return n;
  }, [x, y, w, h, predSrc]);
  const bright = (x, y, w, h) => scan(x, y, w, h, 'r + g + b > 300');
  // glyph cores of PAL cyan (17,168,205) / PAL red (205,49,49) on black
  const cyan = (x, y, w, h) => scan(x, y, w, h, 'r < 90 && g > 110 && b > 140 && b > r + 80');
  const red = (x, y, w, h) => scan(x, y, w, h, 'r > 150 && g < 100 && b < 100 && r > g + 80');
  const quiesce = async (x, y, w, h, ms = 20000) => {
    let prev = -1; const t0 = Date.now();
    for (;;) {
      const n = await bright(x, y, w, h);
      if (n === prev && n > 0) return n;
      prev = n;
      if (Date.now() - t0 > ms) return n;
      await sleep(500);   // genuine no-marker settle: grid text has no DOM/tty mirror
    }
  };
  const shot = async (name) => {
    const data = await page.evaluate(() => {
      const c = document.getElementById('screen');
      const s = window.__osScreen || { w: 0, h: 0 };
      const r = c.getBoundingClientRect();
      const t = document.createElement('canvas');
      t.width = Math.max(Math.round(r.width), s.w);
      t.height = Math.max(Math.round(r.height), s.h);
      t.getContext('2d').drawImage(c, 0, 0);
      return t.toDataURL('image/png');
    });
    fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(data.split(',')[1], 'base64'));
  };
  const waitBodies = async (n, ms = 30000) => {
    const t0 = Date.now();
    while (srv.bodies.length < n) {
      if (Date.now() - t0 > ms) throw new Error(`fixture saw ${srv.bodies.length} POSTs, wanted ${n}`);
      await sleep(200);
    }
  };

  // -- VT1 shell helper (split markers; the 0089 echo trap) --
  const shLine = async (cmd, mark, ms) => {
    await page.keyboard.type(`${cmd} && echo ${mark[0]}""${mark.slice(1)}\r`, { delay: 40 });
    try {
      await page.waitForFunction(m => window.__osOut.includes(m), mark,
        { timeout: ms || 30000, polling: 200 });
    } catch { throw new Error(`shLine: ${mark} never echoed (after: ${cmd})`); }
  };
  const wmRow = async (needle, tag) => {
    const [b, e] = [`${tag}-BEG`, `${tag}-END`];
    await page.keyboard.type(
      `echo ${b[0]}""${b.slice(1)}; wmctl list | grep -F '${needle}'; echo ${e[0]}""${e.slice(1)}\r`,
      { delay: 40 });
    await page.waitForFunction(m => window.__osOut.includes(m), e, { timeout: 20000, polling: 200 });
    const out = await page.evaluate(() => window.__osOut);
    const seg = out.slice(out.lastIndexOf(b) + b.length, out.lastIndexOf(e));
    const m = /(\d+)x(\d+)\+(-?\d+)\+(-?\d+)/.exec(seg);
    return m ? { w: +m[1], h: +m[2], x: +m[3], y: +m[4] } : null;
  };

  // ---- leg 0: env + a one-shot gcode on VT1 (xterm renderer) ----------
  await setVt(1);
  await sleep(300);   // VT switch settles before typing (no page-side marker)
  await shLine(`export ANTHROPIC_BASE_URL=http://127.0.0.1:${srv.port} ANTHROPIC_API_KEY=gcode-browser-fixture ANTHROPIC_MODEL=fixture-model`, 'ENV-OK');
  await page.keyboard.type('gcode -p hi\r', { delay: 40 });
  await waitOut('END-VT1', 45000);
  check('VT1 one-shot: fixture reply streamed to the tty', true);
  check('VT1 one-shot: exactly one POST, carrying the -p prompt',
    srv.bodies.length === 1 && JSON.stringify(srv.bodies[0].messages).includes('hi'),
    srv.bodies.length);
  await page.screenshot({ path: path.join(SHOTS, '0-vt1-oneshot.png') });

  // ---- launch gcode inside a term window ------------------------------
  // term spawns its child with a FIXED env (term.c:2077 — PATH/HOME/TERM
  // only), so `term gcode` can never see ANTHROPIC_*. The designed route
  // (0174, noted in the baked /etc/profile) is exports in ~/.profile + the
  // login shell a bare `term` runs — so seed ~/.profile and type `gcode`
  // at the windowed hush prompt like a user would.
  await shLine(`echo 'export ANTHROPIC_BASE_URL=http://127.0.0.1:${srv.port} ANTHROPIC_API_KEY=gcode-browser-fixture ANTHROPIC_MODEL=fixture-model' > /root/.profile`, 'PROFILE-OK');
  await page.keyboard.type('term &\r', { delay: 40 });
  await shLine('wmctl wait win term 30000', 'TERMWIN-OK', 35000);
  const W = await wmRow('\tterm', 'TROW');
  check('term window up with derived geometry', !!W && W.w > 0, W);
  await setVt(2);
  await waitScreen();
  const rect = await page.evaluate(() => {
    const r = document.getElementById('screen').getBoundingClientRect();
    return { x: r.x, y: r.y };
  });
  // grid band starts 30px below the client top (0273c menu bar)
  const G = { x: W.x, y: W.y + 30, w: W.w, h: W.h - 30 };
  await page.mouse.click(rect.x + W.x + Math.floor(W.w / 2), rect.y + W.y + Math.floor(W.h / 2));
  const hushBase = await quiesce(G.x, G.y, G.w, G.h);   // windowed hush prompt
  if (hushBase < 10) throw new Error('windowed hush prompt never rendered');
  await page.keyboard.type('gcode\r', { delay: 30 });
  const t0 = Date.now();
  for (;;) {   // session line + banner + "> " prompt rendered
    if (await bright(G.x, G.y, G.w, G.h) > hushBase + 60) break;
    if (Date.now() - t0 > 60000) throw new Error('gcode banner never rendered in term');
    await sleep(400);
  }
  await quiesce(G.x, G.y, G.w, G.h);   // full banner + "> " prompt before typing
  check('gcode banner rendered in the term grid', true);
  await shot('1-gcode-banner');

  // ---- leg 1: tool-use turn — cyan tool name, streamed text -----------
  const cyanBefore = await cyan(G.x, G.y, G.w, G.h);
  await page.keyboard.type('run echo for me\r', { delay: 30 });
  await waitBodies(3);   // initial POST + tool_result POST
  await quiesce(G.x, G.y, G.w, G.h);
  const cyanAfter = await cyan(G.x, G.y, G.w, G.h);
  check('cyan glyphs appeared (the "· bash" tool line, SGR 36)',
    cyanAfter > cyanBefore + 8, `${cyanBefore} -> ${cyanAfter}`);
  const tr = srv.bodies[2].messages[srv.bodies[2].messages.length - 1].content[0];
  check('bash tool really ran in-OS (tool_result carries its output)',
    tr && tr.type === 'tool_result' && tr.content.includes('hello-gcode')
    && tr.content.includes('[exit 0]'), tr && tr.content);
  check('typed text reached the request body',
    JSON.stringify(srv.bodies[1].messages).includes('run echo for me'));
  await shot('2-gcode-tool-colours');

  // ---- leg 2: long streamed reply, then scrollback --------------------
  await page.keyboard.type('tell me a long story\r', { delay: 30 });
  await waitBodies(4);
  await quiesce(G.x, G.y, G.w, G.h);
  await shot('3-long-reply-live-bottom');
  const liveSig = await bright(G.x, G.y, G.w, 100);   // top rows fingerprint
  await page.keyboard.press('PageUp');
  await page.keyboard.press('PageUp');
  await sleep(600);   // no-marker settle: view_off render has no completion signal
  const upSig = await bright(G.x, G.y, G.w, 100);
  check('PageUp changed the viewport (scrolled into history)',
    upSig !== liveSig, `${liveSig} -> ${upSig}`);
  await shot('4-scrollback-up-2pages');
  await page.keyboard.press('PageUp');
  await page.keyboard.press('PageUp');
  await sleep(600);   // same no-marker settle
  await shot('5-scrollback-up-4pages');
  // snap-to-live: any non-scroll key returns the view to the bottom
  await page.keyboard.type('x');
  await sleep(600);   // same no-marker settle
  await page.keyboard.press('Backspace');
  const backSig = await bright(G.x, G.y, G.w, 100);
  check('non-scroll keypress snapped the view back to live',
    backSig === liveSig, `${upSig} -> ${backSig} (live ${liveSig})`);
  await shot('6-snap-back-live');

  // ---- leg 3: widen the window (real SE drag), history keeps width ----
  await page.mouse.move(rect.x + W.x + W.w + 2, rect.y + W.y + W.h + 2);
  await page.mouse.down();
  await page.mouse.move(rect.x + W.x + 920, rect.y + W.y + 520, { steps: 8 });
  await page.mouse.up();
  await setVt(1);
  await shLine('wmctl wait win term 5000', 'RESIZED-OK', 15000);
  const W2 = await wmRow('\tterm', 'TROW2');
  await setVt(2);
  check('drag-resize widened the term window', !!W2 && W2.w > W.w + 100, W2);
  const G2 = { x: W2.x, y: W2.y + 30, w: W2.w, h: W2.h - 30 };
  await sleep(1000);   // no-marker settle: reflow + SIGWINCH repaint
  await page.mouse.click(rect.x + W2.x + Math.floor(W2.w / 2), rect.y + W2.y + Math.floor(W2.h / 2));
  await page.keyboard.press('PageUp');
  await page.keyboard.press('PageUp');
  await page.keyboard.press('PageUp');
  await sleep(600);   // no-marker settle (view_off render)
  await shot('7-scrollback-after-widen');
  check('history renders after resize (glyphs in the scrolled view)',
    await bright(G2.x, G2.y, G2.w, G2.h) > 100);
  await page.keyboard.type('x');
  await sleep(400);   // no-marker settle (snap repaint)
  await page.keyboard.press('Backspace');

  // ---- leg 4: Ctrl+C aborts a stalled stream (#306 — judged since the
  // xferinfo path landed; was recorded-only while interrupt was dead) ----
  await page.keyboard.type('stall please\r', { delay: 30 });
  await waitBodies(5);
  await sleep(1500);   // partial delta rendered; server now holds for 8s
  await shot('8-mid-stream-stall');
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyC');
  await page.keyboard.up('Control');
  await sleep(10000);  // covers the 8s stall either way (abort or completion)
  await quiesce(G2.x, G2.y, G2.w, G2.h);
  await shot('9-after-ctrlc');
  check('Ctrl+C mid-stream aborts the in-flight transfer (#306)', srv.stall.closedEarly,
    srv.stall.restWritten ? 'stream ran to completion' : 'no early close observed');

  // ---- leg 5: /clear, the CRED error path, /quit ----------------------
  const clearBefore = await bright(G2.x, G2.y, G2.w, G2.h);
  await page.keyboard.type('/clear\r', { delay: 30 });
  const t1 = Date.now();
  for (;;) {   // "[history cleared]" + new session line appended
    if (await bright(G2.x, G2.y, G2.w, G2.h) !== clearBefore) break;
    if (Date.now() - t1 > 20000) throw new Error('/clear produced no grid change');
    await sleep(400);
  }
  check('/clear appended its notice (grid changed, no screen wipe)', true);
  await quiesce(G2.x, G2.y, G2.w, G2.h);   // new session line + prompt before typing
  const redBefore = await red(G2.x, G2.y, G2.w, G2.h);
  await page.keyboard.type('error demo\r', { delay: 30 });
  await waitBodies(6);   // exhausted queue -> HTTP 500
  await quiesce(G2.x, G2.y, G2.w, G2.h);
  const redAfter = await red(G2.x, G2.y, G2.w, G2.h);
  check('HTTP error rendered in red (SGR 31)', redAfter > redBefore + 8,
    `${redBefore} -> ${redAfter}`);
  check('gcode alive after Ctrl+C + /clear (kept serving turns)', true);
  await shot('10-clear-and-red-error');
  // #305: the failed turn must NOT exit the REPL — a follow-up send from
  // the SAME gcode must reach the API (a dead gcode drops the line into
  // hush and never POSTs; pre-#305 this was the crash-to-shell).
  await page.keyboard.type('again please\r', { delay: 30 });
  await waitBodies(7);   // exhausted queue answers 500 again; the POST is the proof
  await quiesce(G2.x, G2.y, G2.w, G2.h);
  check('REPL survived the HTTP 500: follow-up send reached the API (#305)', true);
  await page.keyboard.type('/quit\r', { delay: 30 });
  await sleep(800);   // no-marker settle: gcode exits back to the hush prompt
  await page.keyboard.type('exit\r', { delay: 30 });
  await setVt(1);
  await shLine('wmctl wait nowin term 20000', 'TERMGONE-OK', 25000);
  check('/quit ended gcode; exit closed the term window', true);
  await page.keyboard.type("echo GCODE-SHELL-O''K\r", { delay: 40 });
  await waitOut('GCODE-SHELL-OK');
  check('shell alive after the run', true);
} catch (e) {
  console.error('FAIL: ' + (e && e.message));
  state.failures++;
} finally {
  await browser.close();
  server.kill();
  srv.close();
}
console.log(state.failures === 0 ? '\nos gcode (browser): PASS' : `\nos gcode (browser): ${state.failures} FAILED`);
process.exit(state.failures === 0 ? 0 : 1);
