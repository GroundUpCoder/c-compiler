#!/usr/bin/env node
// SDL gamepad subsystem end-to-end (#607): a REAL C SDL program compiled by
// compiler.js runs as a worker_thread under the kernel and receives pad
// input over the OS input ring (WMEV 0x650-0x654, SDL3 numbers verbatim).
// Proves, end to end:
//   - connect-BEFORE-boot + focus reconcile: a pad registered while nothing
//     is focused (with a button already held) reaches the app at its
//     window's focus steal via _padSyncTo — ADDED plus the held-state replay
//   - SDL_Init(SDL_INIT_GAMEPAD) succeeds and queues ADDED for the
//     already-known pad (the upstream already-connected contract)
//   - list/open/name: SDL_GetGamepads, SDL_OpenGamepad, SDL_GetGamepadName
//     over the PAD_NAME RPC (the kernel-side name, not a canned string)
//   - a pad BUTTON wakes a parked SDL_WaitEvent (ring futex wake), events
//     carry gbutton/gaxis payloads, and SDL_GetGamepadButton/Axis state
//     tracks them
//   - kernel-side dedup: a same-state report pushes NO duplicate event
//   - hotplug: a second pad ADDED live; disconnect delivers REMOVED, the
//     open handle reads disconnected + all-zero, and the name SURVIVES
//     disconnect (the bounded kernel name cache)
//   - errno surface: padButton on a nonexistent slot returns ENODEV
// Then Part 2 boots the REAL OS (os/boot.js) and drives the baked
// /bin/padbox through `wmctl pad ...` — the WMP PAD_* ops end to end.
//
// Run: node tests/kernel/test_gamepad_e2e.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { driveBoot } = require('./lib/drive.js');

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

/* Drain until an event of type t arrives (skipping focus/window noise);
   returns 1 and fills ev, or 0 on timeout. */
static int wait_type(SDL_Event *ev, Uint32 t, int ms) {
    Uint64 t0 = SDL_GetTicks();
    while ((Uint64)(SDL_GetTicks() - t0) < (Uint64)ms) {
        if (!SDL_WaitEventTimeout(ev, ms)) return 0;
        if (ev->type == t) return 1;
    }
    return 0;
}

int main(void) {
    SDL_Event ev;
    if (!SDL_Init(SDL_INIT_VIDEO | SDL_INIT_GAMEPAD)) { printf("NOINIT\\n"); return 3; }
    SDL_Window *w = SDL_CreateWindow("padwin", 64, 48, 0);
    if (!w) { printf("NOWIN\\n"); return 3; }

    /* Leg A: the pre-boot pad reaches us via the focus reconcile. */
    int got = wait_type(&ev, SDL_EVENT_GAMEPAD_ADDED, 5000);
    printf("A got=%d id=%u\\n", got, (unsigned)ev.gdevice.which);
    fflush(stdout);

    int n = -1;
    SDL_JoystickID *ids = SDL_GetGamepads(&n);
    SDL_Gamepad *g = ids ? SDL_OpenGamepad(ids[0]) : NULL;
    const char *nm = g ? SDL_GetGamepadName(g) : NULL;
    /* The held-state replay: NORTH was down before we ever had focus. */
    printf("OPEN n=%d open=%d name=[%s] north=%d conn=%d type=%d\\n",
           n, g != NULL, nm ? nm : "?",
           (int)SDL_GetGamepadButton(g, SDL_GAMEPAD_BUTTON_NORTH),
           (int)SDL_GamepadConnected(g), (int)SDL_GetGamepadType(g));
    SDL_free(ids);
    fflush(stdout);

    /* Leg B: parked WaitEvent woken by an injected button. */
    printf("PARKB\\n");
    fflush(stdout);
    Uint64 t0 = SDL_GetTicks();
    got = wait_type(&ev, SDL_EVENT_GAMEPAD_BUTTON_DOWN, 10000);
    printf("B got=%d btn=%d down=%d state=%d dt=%d\\n", got,
           (int)ev.gbutton.button, (int)ev.gbutton.down,
           (int)SDL_GetGamepadButton(g, SDL_GAMEPAD_BUTTON_SOUTH),
           (int)(SDL_GetTicks() - t0));
    got = wait_type(&ev, SDL_EVENT_GAMEPAD_BUTTON_UP, 5000);
    printf("B2 got=%d btn=%d down=%d state=%d\\n", got,
           (int)ev.gbutton.button, (int)ev.gbutton.down,
           (int)SDL_GetGamepadButton(g, SDL_GAMEPAD_BUTTON_SOUTH));
    fflush(stdout);

    /* Leg C: axis event + state (and the dedup probe rides behind it:
       the test re-sends the same value, then a sentinel button — if the
       duplicate had queued, the next event would be the axis again). */
    printf("PARKC\\n");
    fflush(stdout);
    got = wait_type(&ev, SDL_EVENT_GAMEPAD_AXIS_MOTION, 10000);
    printf("C got=%d axis=%d value=%d state=%d\\n", got,
           (int)ev.gaxis.axis, (int)ev.gaxis.value,
           (int)SDL_GetGamepadAxis(g, SDL_GAMEPAD_AXIS_LEFTY));
    got = SDL_WaitEventTimeout(&ev, 10000);
    printf("C2 got=%d isb=%d btn=%d\\n", got,
           ev.type == SDL_EVENT_GAMEPAD_BUTTON_DOWN, (int)ev.gbutton.button);
    fflush(stdout);

    /* Leg D: hotplug — a second pad live, name for an UNOPENED pad. */
    printf("PARKD\\n");
    fflush(stdout);
    got = wait_type(&ev, SDL_EVENT_GAMEPAD_ADDED, 10000);
    const char *nm2 = SDL_GetGamepadNameForID(ev.gdevice.which);
    printf("D got=%d id=%u name2=[%s] has=%d\\n", got, (unsigned)ev.gdevice.which,
           nm2 ? nm2 : "?", (int)SDL_HasGamepad());
    fflush(stdout);

    /* Leg E: disconnect pad 1 — REMOVED, dead-but-valid handle, name kept. */
    printf("PARKE\\n");
    fflush(stdout);
    got = wait_type(&ev, SDL_EVENT_GAMEPAD_REMOVED, 10000);
    const char *nm3 = SDL_GetGamepadName(g);   /* cached veneer-side */
    printf("E got=%d id=%u conn=%d south=%d lefty=%d name=[%s]\\n", got,
           (unsigned)ev.gdevice.which, (int)SDL_GamepadConnected(g),
           (int)SDL_GetGamepadButton(g, SDL_GAMEPAD_BUTTON_SOUTH),
           (int)SDL_GetGamepadAxis(g, SDL_GAMEPAD_AXIS_LEFTY),
           nm3 ? nm3 : "?");
    SDL_CloseGamepad(g);
    fflush(stdout);

    SDL_Quit();
    printf("DONE\\n");
    fflush(stdout);
    return 0;
}
`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gamepad-e2e-'));
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
    if (Date.now() - t0 > (ms || 20000)) return reject(new Error('timeout waiting for ' + JSON.stringify(needle) + '; out=' + JSON.stringify(out)));
    setTimeout(poll, 10);
  })();
});
const line = (tag) => {
  const m = out.split('\n').find((l) => l.startsWith(tag + ' '));
  return m || '';
};
const field = (tag, key) => {
  const m = line(tag).match(new RegExp(key + '=(-?\\d+)'));
  return m ? parseInt(m[1], 10) : NaN;
};
const strf = (tag, key) => {
  const m = line(tag).match(new RegExp(key + '=\\[([^\\]]*)\\]'));
  return m ? m[1] : '';
};

const watchdog = setTimeout(() => {
  console.error('TIMEOUT — gamepad e2e did not finish in 120s\noutput so far:\n' + out);
  process.exit(1);
}, 120000);

(async () => {
  // --- Part 1: kernel API + ring + veneer, in-process ---
  // Pre-boot: pad at slot 0 with NORTH already held — nothing is focused,
  // so this must reach the app purely via the focus-gain reconcile.
  const id1 = kernel.padConnect(0, 'Test Pad Alpha', null);
  check('padConnect returns the instance id', id1 === 1, id1);
  check('padButton on a live slot returns 0', kernel.padButton(0, 3, true, null) === 0);
  check('padButton on a nonexistent slot is ENODEV', kernel.padButton(9, 0, true, null) === 'ENODEV');
  check('padAxis with a bad axis is EINVAL', kernel.padAxis(0, 6, 1, null) === 'EINVAL');

  await kernel.boot({ path: '/bin/app', argv: ['app'], envp: [], cwd: '/' });

  await waitOut('OPEN ');
  check('A: reconcile delivered ADDED for the pre-boot pad', field('A', 'got') === 1 && field('A', 'id') === 1, line('A'));
  check('OPEN: GetGamepads sees one pad, open succeeds', field('OPEN', 'n') === 1 && field('OPEN', 'open') === 1, line('OPEN'));
  check('OPEN: name rode the PAD_NAME RPC', strf('OPEN', 'name') === 'Test Pad Alpha', line('OPEN'));
  check('OPEN: held-state replay (NORTH down before focus)', field('OPEN', 'north') === 1, line('OPEN'));
  check('OPEN: connected, type STANDARD', field('OPEN', 'conn') === 1 && field('OPEN', 'type') === 1, line('OPEN'));

  await waitOut('PARKB');
  kernel.padButton(0, 0, true, null);              // SOUTH down
  await waitOut('B ');
  check('B: pad button woke the parked WaitEvent', field('B', 'got') === 1, line('B'));
  check('B: gbutton payload + state (SOUTH down)', field('B', 'btn') === 0 && field('B', 'down') === 1 && field('B', 'state') === 1, line('B'));
  check('B: woke on the push, not a timeout', field('B', 'dt') < 5000, line('B'));
  kernel.padButton(0, 0, false, null);             // SOUTH up
  await waitOut('B2 ');
  check('B2: BUTTON_UP + state cleared', field('B2', 'got') === 1 && field('B2', 'down') === 0 && field('B2', 'state') === 0, line('B2'));

  await waitOut('PARKC');
  kernel.padAxis(0, 1, -32768, null);              // LEFTY hard up
  check('dedup: same-value axis report returns 0 and pushes nothing', kernel.padAxis(0, 1, -32768, null) === 0);
  kernel.padButton(0, 5, true, null);              // GUIDE — the dedup sentinel
  await waitOut('C2 ');
  check('C: gaxis payload + state (LEFTY -32768)', field('C', 'got') === 1 && field('C', 'axis') === 1 && field('C', 'value') === -32768 && field('C', 'state') === -32768, line('C'));
  check('C2: no duplicate axis event — next is the sentinel GUIDE', field('C2', 'got') === 1 && field('C2', 'isb') === 1 && field('C2', 'btn') === 5, line('C2'));

  await waitOut('PARKD');
  const id2 = kernel.padConnect(1, 'Test Pad Beta', null);
  check('second pad gets a fresh monotonic id', id2 === 2, id2);
  await waitOut('D ');
  check('D: live hotplug ADDED for pad 2', field('D', 'got') === 1 && field('D', 'id') === 2, line('D'));
  check('D: NameForID works for an unopened pad', strf('D', 'name2') === 'Test Pad Beta', line('D'));
  check('D: HasGamepad true', field('D', 'has') === 1, line('D'));

  await waitOut('PARKE');
  check('padDisconnect returns 0', kernel.padDisconnect(0) === 0);
  await waitOut('E ');
  check('E: REMOVED for pad 1', field('E', 'got') === 1 && field('E', 'id') === 1, line('E'));
  check('E: open handle reads disconnected + all-zero', field('E', 'conn') === 0 && field('E', 'south') === 0 && field('E', 'lefty') === 0, line('E'));
  check('E: name survives disconnect (kernel cache)', strf('E', 'name') === 'Test Pad Alpha', line('E'));

  await waitOut('DONE');

  // --- Part 2: the real OS — /bin/padbox driven by wmctl pad verbs ---
  // padbox prints one line per gamepad event; `wait %1` after the close
  // request is the sync marker (the QUIT record queues BEHIND every pad
  // record, so padbox's exit proves all pad lines were printed — no fixed
  // sleeps, per the todos/0171 discipline).
  const r = driveBoot([
    'padbox &',
    'wmctl wait win padbox',
    'wmctl pad connect',
    'wmctl pad press 0 a',
    'wmctl pad axis 0 leftx 0.5',
    'wmctl pad disconnect 0',
    'PSID=$(wmctl list | awk \'/padbox/{print $1}\')',
    'wmctl close $PSID',
    'wait %1',
    'echo PADBOX-EXITED',
  ]);
  const so = String(r.stdout || '');
  check('padbox: ready', so.includes('padbox: ready'), so.slice(-400));
  check('padbox: wmctl pad connect delivered ADDED', so.includes('padbox: added id=1'));
  check('padbox: press = down then up', so.includes('padbox: button a 1 id=1') && so.includes('padbox: button a 0 id=1'));
  check('padbox: axis leftx 0.5 -> 16383', so.includes('padbox: axis leftx 16383 id=1'));
  check('padbox: disconnect delivered REMOVED', so.includes('padbox: removed id=1'));
  check('padbox: exited via close request (all lines flushed before QUIT)', so.includes('PADBOX-EXITED'));

  clearTimeout(watchdog);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures === 0 ? '\ngamepad e2e: PASS' : `\ngamepad e2e: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); console.error('out=', out); process.exit(1); });
