#!/usr/bin/env node
// Host-clipboard bridge, kernel seam (ticket #79): the embedder side of the
// one 0090 clipboard slot — opts.onClipboard fires at every process-side
// CLIP_SET COMMIT (the OS's change signal: no poll, the choke is the event),
// and Kernel.clipSet/clipGet let the embedder feed/inspect the slot from
// outside the process world (the browser page's host-clipboard sync).
// A REAL C program (SDL clipboard API over the CLIP RPCs) proves:
//   - a C copy fires onClipboard exactly once, with the committed bytes
//   - an embedder clipSet is visible to the C side's next GetClipboardText
//     and does NOT fire the hook (the bridge's loop guard)
//   - a second C copy fires again; SDL_ClearClipboardData reports null
//   - embedder clear (fmt 0) empties the slot
//
// Run: node tests/kernel/test_hostclip_e2e.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const K = require(path.join(ROOT, 'kernel.js'));

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const APP_C = `
#include <SDL.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
int main(void) {
    /* Clipboard is usable without SDL_Init (todos/0090). */
    SDL_SetClipboardText("GUC-COPY-ONE");
    printf("SET1\\n"); fflush(stdout);
    /* Wait for the embedder to feed the slot (the host->gucOS direction). */
    for (;;) {
        char *t = SDL_GetClipboardText();
        int hit = t && strcmp(t, "HOST-FEED") == 0;
        SDL_free(t);
        if (hit) break;
        usleep(20000);
    }
    printf("SAW-HOST\\n"); fflush(stdout);
    /* Park until the harness has ASSERTED the loop guard (a second feed is
       the go signal) — otherwise SET2 races the events.length check. */
    for (;;) {
        char *t = SDL_GetClipboardText();
        int hit = t && strcmp(t, "HOST-GO") == 0;
        SDL_free(t);
        if (hit) break;
        usleep(20000);
    }
    SDL_SetClipboardText("GUC-COPY-TWO");
    printf("SET2\\n"); fflush(stdout);
    SDL_ClearClipboardData();
    printf("CLEARED\\n"); fflush(stdout);
    return 0;
}
`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hostclip-e2e-'));
const cfile = path.join(tmp, 'app.c');
const wasm = path.join(tmp, 'app.wasm');
fs.writeFileSync(cfile, APP_C);
cp.execFileSync('node', [path.join(ROOT, 'compiler.js'), cfile, '-o', wasm], { stdio: 'pipe' });
const image = fs.readFileSync(wasm);

let out = '';
const events = [];   // every onClipboard fire: 'CLEAR' or the decoded text
const kernel = new K.Kernel({
  createWorker: K.nodeCreateWorker({ hostPath: path.join(ROOT, 'host.js'), kernelPath: path.join(ROOT, 'kernel.js') }),
  loadImage: (p) => (p === '/bin/app' ? image : null),
  onOutput: (pid, fd, bytes) => { out += Buffer.from(bytes).toString(); },
  onHalt: () => {},
  onClipboard: (clip) => {
    events.push(clip === null ? 'CLEAR'
      : { fmt: clip.fmt, text: Buffer.from(clip.bytes).toString() });
  },
  log: () => {},
});

const waitOut = (needle, ms) => new Promise((resolve, reject) => {
  const t0 = Date.now();
  (function poll() {
    if (out.includes(needle)) return resolve();
    if (Date.now() - t0 > (ms || 20000)) return reject(new Error('timeout waiting for ' + JSON.stringify(needle) + '; out=' + JSON.stringify(out)));
    setTimeout(poll, 20);
  })();
});

const watchdog = setTimeout(() => {
  console.error('TIMEOUT — hostclip e2e did not finish in 90s\noutput so far:\n' + out);
  process.exit(1);
}, 90000);

(async () => {
  await kernel.boot({ path: '/bin/app', argv: ['app'], envp: [], cwd: '/' });

  // C copy -> the hook fires with the committed slot.
  await waitOut('SET1');
  check('C copy fires onClipboard once', events.length === 1, JSON.stringify(events));
  check('hook saw fmt 1 + the committed text',
    events[0] && events[0].fmt === 1 && events[0].text === 'GUC-COPY-ONE',
    JSON.stringify(events[0]));
  const slot = kernel.clipGet();
  check('clipGet mirrors the slot',
    slot && slot.fmt === 1 && Buffer.from(slot.bytes).toString() === 'GUC-COPY-ONE',
    JSON.stringify(slot));

  // Embedder feed -> visible to the C side's CLIP_GET poll, hook silent.
  kernel.clipSet(1, Buffer.from('HOST-FEED'));
  await waitOut('SAW-HOST');
  check('embedder clipSet reaches SDL_GetClipboardText', true);
  check('embedder clipSet does NOT fire onClipboard (loop guard)',
    events.length === 1, JSON.stringify(events));

  // Second C copy overwrites; clear reports null. (HOST-GO releases the
  // app's park — the loop-guard assert above ran against a quiesced world.)
  kernel.clipSet(1, Buffer.from('HOST-GO'));
  await waitOut('CLEARED');
  check('second C copy fires the hook again',
    events.length === 3 && events[1] && events[1].text === 'GUC-COPY-TWO',
    JSON.stringify(events));
  check('SDL_ClearClipboardData reports a null slot', events[2] === 'CLEAR',
    JSON.stringify(events[2]));
  check('slot empty after clear', kernel.clipGet() === null);

  // Embedder set + clear round-trip without any process involved.
  kernel.clipSet(1, Buffer.from('X'));
  check('embedder set lands', kernel.clipGet() && kernel.clipGet().fmt === 1);
  kernel.clipSet(0, null);
  check('embedder fmt-0 clear empties the slot', kernel.clipGet() === null);
  check('no stray hook fires from embedder ops', events.length === 3, JSON.stringify(events));

  clearTimeout(watchdog);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures === 0 ? '\nhostclip e2e: PASS' : `\nhostclip e2e: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); console.error('out=', out); process.exit(1); });
