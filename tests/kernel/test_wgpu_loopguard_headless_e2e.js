#!/usr/bin/env node
// #712 counter-pass: the headless refusal covers the raw-webgpu.h transport,
// not just SDL_Renderer — a second main-live wgpuSurfacePresent() refuses at
// exit 69 with the WebGPU-specific diagnostic ('webgpu.h surface',
// 'wgpuSurfacePresent() called from main()').
//
// Placement matters and is what this file pins: the guard must sit in the
// SYNCHRONOUS __wgpu_surface_present import (where the browser's presentTo
// counts the CALL), not in the async shm readback tail — that tail runs in a
// mapAsync continuation after the wasm stack unwinds, where mainLive is
// false by construction, so a guard there can never fire (the first #712
// landing had exactly that inert placement; this test is red against it).
//
// The app is deviceless ON PURPOSE: a blocking main() headless can never
// acquire a Dawn device (the adapter/device callbacks ride the event loop a
// blocking loop never yields — measured: NO-DEVICE-IN-MAIN), so a deviceless
// wgpuSurfacePresent() is the ONLY raw-webgpu present a main-live program
// can issue here. It needs no Dawn package either — SDL_GetWGPUSurface's
// shm-surface record is created deviceless — so this file never skips.
//
// Legs: second present refuses (exit 69, WebGPU diagnostic); one present
// stays legal (exit 0 — the SDL_AppInit splash allowance, per transport).
//
// Run: node tests/kernel/test_wgpu_loopguard_headless_e2e.js
'use strict';
const { driveBoot, freshImage } = require('./lib/drive.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const { image } = freshImage('os-wgpuloopguard-');

const script = [
  "cat > /root/wnaive.c << 'EOF'",
  '#include <SDL.h>',
  '#include <webgpu.h>',
  '#include <sdl3webgpu.h>',
  '#include <stdio.h>',
  '#include <string.h>',
  'int main(int argc, char **argv) {',
  '    if (!SDL_Init(SDL_INIT_VIDEO)) { printf("INIT-FAIL\\n"); return 1; }',
  '    SDL_Window *w = SDL_CreateWindow("wnaive", 96, 64, 0);',
  '    if (!w) { printf("WIN-FAIL\\n"); return 1; }',
  '    WGPUInstance inst = wgpuCreateInstance(NULL);',
  '    WGPUSurface s = SDL_GetWGPUSurface(inst, w);',
  '    if (!s) { printf("SURF-FAIL\\n"); return 1; }',
  '    int n = (argc > 1 && strcmp(argv[1], "one") == 0) ? 1 : 5;',
  '    for (int i = 0; i < n; i++) {',
  '        wgpuSurfacePresent(s);',
  '        printf("P%d-OK\\n", i + 1); fflush(stdout);',
  '    }',
  '    printf("RAN-TO-END\\n"); fflush(stdout);',
  '    SDL_Quit();',
  '    return 0;',
  '}',
  'EOF',
  'cc /root/wnaive.c -o /root/wnaive && echo CC-OK',
  './wnaive; echo WNAIVE-EXIT=$?',
  './wnaive one; echo WONE-EXIT=$?',
  '',
].join('\n');

const a = driveBoot(script, { image, cwd: '/root', timeout: 600000 });
const all = (a.stdout || '') + (a.stderr || '');

check('boot session exits clean', a.status === 0, String(a.status) + ' ' + (a.stderr || '').slice(-300));
check('wnaive built in-OS', all.includes('CC-OK'),
  (all.match(/error[^\n]*/gi) || []).slice(0, 3).join('; '));

// Leg 1 — the second main-live wgpuSurfacePresent refuses at exit 69.
check('first webgpu present is legal (P1-OK printed)', all.includes('P1-OK'));
check('second webgpu present refuses: exit 69', all.includes('WNAIVE-EXIT=69'),
  (all.match(/WNAIVE-EXIT=\d+/) || ['no WNAIVE-EXIT marker'])[0]);
check('the refusal fired at the second call (no P2-OK, no RAN-TO-END before exit)',
  !/P2-OK[\s\S]*?WNAIVE-EXIT/.test(all) && !/RAN-TO-END[\s\S]*?WNAIVE-EXIT/.test(all));
check('diagnostic names the webgpu.h tier', all.includes('webgpu.h surface'));
check('diagnostic names the webgpu call site', all.includes('wgpuSurfacePresent() called from main()'));
check('diagnostic is the headless variant', all.includes('boot.js enforces the same rule'));
check('diagnostic states the exit', all.includes('Exiting (status 69).'));

// Leg 2 — one present from main() stays legal on this transport too.
check('single webgpu present exits 0', /P1-OK[\s\S]*?RAN-TO-END[\s\S]*?WONE-EXIT=0/.test(all),
  (all.match(/WONE-EXIT=\d+/) || ['no WONE-EXIT marker'])[0]);

process.exit(failures ? 1 : 0);
