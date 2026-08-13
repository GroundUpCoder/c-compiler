#!/usr/bin/env node
// SDL event-queue manipulation e2e (#604): SDL_PushEvent / SDL_RegisterEvents /
// SDL_HasEvent(s) / SDL_FlushEvent(s) / SDL_PeepEvents / SDL_PumpEvents over
// the veneer's real queue — a REAL C SDL program compiled by compiler.js runs
// as a worker_thread under the kernel (the test_waitevent_e2e harness).
//
//   - SDL_RegisterEvents hands out SDL_EVENT_USER-range types, advances by the
//     grant, refuses nonpositive / unsatisfiable requests
//   - push -> poll round-trips type/code/data1/data2; a zero timestamp is
//     stamped at push, a caller-set one is preserved
//   - HasEvent / HasEvents scan without consuming; FlushEvent(s) drop exactly
//     the matching range; PeepEvents ADD/PEEK/GET semantics incl. the
//     NULL-events counting peek (upstream's cap-at-one rule)
//   - a pushed event completes SDL_WaitEventTimeout WITHOUT parking (the wake
//     contract: this runtime is single-threaded, so nothing can be parked
//     while SDL_PushEvent runs, and the wait loop re-polls before every park)
//   - SDL_PumpEvents + SDL_GetKeyboardState is the #493 no-event-loop input
//     idiom: an injected key advances the snapshot with no SDL_PollEvent, the
//     KEY_DOWN stays queued, and FlushEvent drops it
//
// Run: node tests/kernel/test_sdl_events_e2e.js
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

static int fails = 0;
static void chk(const char *name, int cond) {
    printf("%s %s\\n", cond ? "ok" : "FAIL", name);
    fflush(stdout);
    if (!cond) fails++;
}

int main(void) {
    SDL_Event ev, got;

    if (!SDL_Init(SDL_INIT_EVENTS)) { printf("NOINIT\\n"); return 3; }

    /* ---- registration ---- */
    Uint32 base = SDL_RegisterEvents(2);
    chk("RegisterEvents hands out SDL_EVENT_USER", base == SDL_EVENT_USER);
    chk("RegisterEvents advances by the grant", SDL_RegisterEvents(1) == SDL_EVENT_USER + 2);
    chk("RegisterEvents rejects nonpositive", SDL_RegisterEvents(0) == 0);
    chk("RegisterEvents rejects an over-range grant", SDL_RegisterEvents(0x10000) == 0);

    /* ---- empty-queue scans ---- */
    chk("HasEvent false on empty queue", !SDL_HasEvent(base));
    chk("HasEvents false on empty queue", !SDL_HasEvents(SDL_EVENT_FIRST, SDL_EVENT_LAST));
    chk("PeepEvents NULL count 0 on empty queue",
        SDL_PeepEvents(NULL, 0, SDL_PEEKEVENT, SDL_EVENT_FIRST, SDL_EVENT_LAST) == 0);

    /* ---- push -> poll round-trip ---- */
    SDL_Delay(2);           /* ticks > 0, so a stamped timestamp is nonzero */
    memset(&ev, 0, sizeof ev);
    ev.type = base;
    ev.user.code = 7;
    ev.user.data1 = (void *)0x1234;
    ev.user.data2 = (void *)0x5678;
    chk("PushEvent queues", SDL_PushEvent(&ev));
    chk("PushEvent(NULL) fails", !SDL_PushEvent(NULL));
    chk("HasEvent sees the pushed type", SDL_HasEvent(base));
    chk("HasEvents sees the user range", SDL_HasEvents(SDL_EVENT_USER, SDL_EVENT_LAST));
    chk("HasEvent is type-exact", !SDL_HasEvent(base + 1));
    chk("PeepEvents NULL count sees one",
        SDL_PeepEvents(NULL, 0, SDL_PEEKEVENT, SDL_EVENT_USER, SDL_EVENT_LAST) == 1);
    chk("PollEvent returns the pushed event", SDL_PollEvent(&got) == 1);
    chk("payload round-trips", got.type == base && got.user.code == 7 &&
        got.user.data1 == (void *)0x1234 && got.user.data2 == (void *)0x5678);
    chk("zero timestamp was stamped at push", got.user.timestamp != 0);
    chk("queue drained", !SDL_PollEvent(NULL));

    memset(&ev, 0, sizeof ev);
    ev.type = base;
    ev.user.timestamp = 12345;
    SDL_PushEvent(&ev);
    SDL_PollEvent(&got);
    chk("caller timestamp is preserved", got.user.timestamp == 12345);

    /* ---- flush ---- */
    memset(&ev, 0, sizeof ev);
    ev.type = base;         SDL_PushEvent(&ev);
    ev.type = base + 1;     SDL_PushEvent(&ev);
    ev.type = base;         SDL_PushEvent(&ev);
    SDL_FlushEvent(base);
    chk("FlushEvent drops every matching event", !SDL_HasEvent(base));
    chk("FlushEvent keeps other types", SDL_HasEvent(base + 1));
    SDL_FlushEvents(SDL_EVENT_USER, SDL_EVENT_LAST);
    chk("FlushEvents empties the range", !SDL_HasEvents(SDL_EVENT_FIRST, SDL_EVENT_LAST));

    /* ---- PeepEvents ---- */
    SDL_Event batch[2];
    memset(batch, 0, sizeof batch);
    batch[0].type = base;     batch[0].user.code = 1;
    batch[1].type = base + 1; batch[1].user.code = 2;
    chk("ADDEVENT queues the batch", SDL_PeepEvents(batch, 2, SDL_ADDEVENT, 0, 0) == 2);
    SDL_Event peeked[4];
    int n = SDL_PeepEvents(peeked, 4, SDL_PEEKEVENT, SDL_EVENT_USER, SDL_EVENT_LAST);
    chk("PEEKEVENT sees both in FIFO order",
        n == 2 && peeked[0].user.code == 1 && peeked[1].user.code == 2);
    chk("PEEKEVENT leaves the queue intact", SDL_HasEvent(base) && SDL_HasEvent(base + 1));
    n = SDL_PeepEvents(peeked, 1, SDL_GETEVENT, SDL_EVENT_USER, SDL_EVENT_LAST);
    chk("GETEVENT removes only what it returned",
        n == 1 && peeked[0].user.code == 1 && !SDL_HasEvent(base) && SDL_HasEvent(base + 1));
    SDL_FlushEvents(SDL_EVENT_FIRST, SDL_EVENT_LAST);

    /* ---- a pushed event completes a wait without parking ---- */
    memset(&ev, 0, sizeof ev);
    ev.type = base;
    SDL_PushEvent(&ev);
    Uint64 t0 = SDL_GetTicks();
    chk("pushed event completes WaitEventTimeout immediately",
        SDL_WaitEventTimeout(&got, 5000) == 1 && got.type == base &&
        SDL_GetTicks() - t0 < 1000);

    printf("PHASE-A-DONE\\n");
    fflush(stdout);

    /* ---- SDL_PumpEvents + SDL_GetKeyboardState (the #493 idiom) ---- */
    if (!SDL_Init(SDL_INIT_VIDEO)) { printf("NOVIDEO\\n"); return 3; }
    SDL_Window *w = SDL_CreateWindow("evbox", 64, 48, 0);
    if (!w) { printf("NOWIN\\n"); return 3; }
    got.type = 0;
    chk("create-steal FOCUS_GAINED arrives (todos/0256)",
        SDL_WaitEventTimeout(&got, 2000) == 1 && got.type == SDL_EVENT_WINDOW_FOCUS_GAINED);
    const bool *ks = SDL_GetKeyboardState(NULL);
    printf("INJECT\\n");
    fflush(stdout);
    int spins = 0;
    while (!ks[SDL_SCANCODE_A] && spins < 1500) { SDL_PumpEvents(); SDL_Delay(10); spins++; }
    chk("PumpEvents advanced the keyboard snapshot without a poll", ks[SDL_SCANCODE_A]);
    chk("PumpEvents left the KEY_DOWN queued", SDL_HasEvent(SDL_EVENT_KEY_DOWN));
    SDL_FlushEvent(SDL_EVENT_KEY_DOWN);
    chk("FlushEvent drops the pumped key", !SDL_HasEvent(SDL_EVENT_KEY_DOWN));

    SDL_Quit();
    printf("SUMMARY fails=%d\\n", fails);
    fflush(stdout);
    return fails ? 1 : 0;
}
`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlevents-e2e-'));
const cfile = path.join(tmp, 'app.c');
const wasm = path.join(tmp, 'app.wasm');
fs.writeFileSync(cfile, APP_C);
cp.execFileSync('node', [path.join(ROOT, 'compiler.js'), cfile, '-o', wasm], { stdio: 'pipe' });
const image = fs.readFileSync(wasm);

let out = '';
const kernel = new K.Kernel({
  createWorker: K.nodeCreateWorker({ hostPath: path.join(ROOT, 'host.js'), kernelPath: path.join(ROOT, 'kernel.js') }),
  loadImage: (p) => (p === '/bin/app' ? image : null),
  onOutput: (pid, fd, bytes) => { out += Buffer.from(bytes).toString(); },
  onHalt: () => {},
  log: () => {},
});

const waitOut = (needle, ms) => new Promise((resolve, reject) => {
  const t0 = Date.now();
  (function poll() {
    if (out.includes(needle)) return resolve(Date.now() - t0);
    if (Date.now() - t0 > (ms || 30000)) return reject(new Error('timeout waiting for ' + JSON.stringify(needle) + '; out=' + JSON.stringify(out)));
    setTimeout(poll, 10);
  })();
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const watchdog = setTimeout(() => {
  console.error('TIMEOUT — sdl events e2e did not finish in 90s\noutput so far:\n' + out);
  process.exit(1);
}, 90000);

(async () => {
  await kernel.boot({ path: '/bin/app', argv: ['app'], envp: [], cwd: '/' });

  // Phase A: pure queue mechanics — the C side self-checks, we relay verdicts.
  await waitOut('PHASE-A-DONE');

  // Phase B: inject 'a' for the PumpEvents + GetKeyboardState idiom.
  await waitOut('INJECT');
  const win = kernel.wmList().find((s) => s.title === 'evbox');
  check('evbox surface exists', !!win, JSON.stringify(kernel.wmList()));
  await sleep(200);
  kernel.wmInjectKey(win.sid, true, 4, 97, 0);   // 'a' down (scancode 4)

  await waitOut('SUMMARY');
  const m = out.match(/SUMMARY fails=(\d+)/);
  check('C-side checks all passed', m && m[1] === '0',
    (out.match(/FAIL [^\n]*/g) || []).join('; '));
  const cFails = (out.match(/^FAIL /gm) || []).length;
  check('no FAIL lines in app output', cFails === 0, cFails + ' FAIL lines');

  clearTimeout(watchdog);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures === 0 ? '\nsdl events e2e: PASS' : `\nsdl events e2e: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); console.error('out=', out); process.exit(1); });
