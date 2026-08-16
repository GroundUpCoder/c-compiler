#!/usr/bin/env node
// #712: the blocking-loop + GPU-present refusal (exit 69, #551) fires in the
// HEADLESS host too — boot.js and os.html enforce one policy, so a headless
// green is real evidence about the platform's most important game-stability
// rule (before #712, the ticket measured 5001 presents at exit 0 headless vs
// exit 69 in the browser for the same program).
//
// Three legs over one boot:
//   1. the naive shape — default (GPU-request) renderer, blocking present
//      loop in main() — dies at the SECOND present with exit 69 and the
//      refusal message on stderr (the loop is CAPPED, so a broken guard
//      yields a loud DONE + exit 0, never a hang);
//   2. the sanctioned escape — the SAME binary under
//      SDL_RENDER_DRIVER=software — runs every frame to completion, exit 0
//      (the explicit software request is exempt in both hosts);
//   3. the SDL_AppInit allowance — ONE present from main() is legal (a
//      splash frame), exit 0.
//
// The browser twin is tests/browser/os-loopguard.mjs; the wanted-refusal
// message contract (FIX 1/FIX 2 wording) is shared between the flavors.
//
// Run: node tests/kernel/test_loopguard_headless_e2e.js
'use strict';
const { driveBoot, freshImage } = require('./lib/drive.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const { image } = freshImage('os-loopguard-');

const script = [
  "cat > /root/naive.c << 'EOF'",
  '#include <SDL.h>',
  '#include <stdio.h>',
  'int main(void) {',
  '    if (!SDL_Init(SDL_INIT_VIDEO)) { printf("INIT-FAIL\\n"); return 1; }',
  '    SDL_Window *w = SDL_CreateWindow("naive", 128, 96, 0);',
  '    if (!w) { printf("WIN-FAIL\\n"); return 1; }',
  '    SDL_Renderer *r = SDL_CreateRenderer(w, NULL);',
  '    if (!r) { printf("RDR-FAIL %s\\n", SDL_GetError()); return 1; }',
  '    printf("LOOP-START\\n"); fflush(stdout);',
  '    /* capped blocking loop: a broken guard finishes loudly, never hangs */',
  '    for (int i = 0; i < 600; i++) {',
  '        SDL_SetRenderDrawColor(r, (Uint8)i, 64, 64, 255);',
  '        SDL_RenderClear(r);',
  '        SDL_RenderPresent(r);',
  '    }',
  '    printf("RAN-TO-END\\n"); fflush(stdout);',
  '    SDL_Quit();',
  '    return 0;',
  '}',
  'EOF',
  "cat > /root/one.c << 'EOF'",
  '#include <SDL.h>',
  '#include <stdio.h>',
  'int main(void) {',
  '    SDL_Init(SDL_INIT_VIDEO);',
  '    SDL_Window *w = SDL_CreateWindow("one", 128, 96, 0);',
  '    SDL_Renderer *r = SDL_CreateRenderer(w, NULL);',
  '    if (!r) { printf("RDR-FAIL\\n"); return 1; }',
  '    SDL_RenderClear(r);',
  '    SDL_RenderPresent(r);   /* exactly one — the splash allowance */',
  '    printf("ONE-OK\\n"); fflush(stdout);',
  '    SDL_Quit();',
  '    return 0;',
  '}',
  'EOF',
  'cc /root/naive.c -o /root/naive && cc /root/one.c -o /root/one && echo CC-OK',
  './naive; echo NAIVE-EXIT=$?',
  'SDL_RENDER_DRIVER=software ./naive; echo SW-EXIT=$?',
  './one; echo ONE-EXIT=$?',
  '',
].join('\n');

const a = driveBoot(script, { image, cwd: '/root', timeout: 600000 });
const all = (a.stdout || '') + (a.stderr || '');

check('boot session exits clean', a.status === 0, String(a.status) + ' ' + (a.stderr || '').slice(-300));
check('both apps built in-OS', all.includes('CC-OK'),
  (all.match(/error[^\n]*/gi) || []).slice(0, 3).join('; '));

// Leg 1 — the naive shape refuses at exit 69, before the loop completes.
check('naive blocking present loop exits 69', all.includes('NAIVE-EXIT=69'),
  (all.match(/NAIVE-EXIT=\d+/) || ['no NAIVE-EXIT marker'])[0]);
check('the refusal never let the loop finish', !/LOOP-START[\s\S]*?RAN-TO-END[\s\S]*?NAIVE-EXIT/.test(all));
check('refusal message names the shape', all.includes('presents GPU frames from a blocking main loop'));
check('refusal message is the headless variant', all.includes('boot.js enforces the same rule'));
check('refusal message teaches FIX 1 (software opt-in)', all.includes('SDL_RENDER_DRIVER=software'));
check('refusal message teaches FIX 2 (callback loop)',
  all.includes('SDL_MAIN_USE_CALLBACKS') && all.includes('SDL_AppIterate'));
check('refusal message states the exit', all.includes('Exiting (status 69).'));

// Leg 2 — the sanctioned escape: the SAME binary, software driver via env.
check('software-driver escape runs the whole loop', /LOOP-START[\s\S]*?RAN-TO-END[\s\S]*?SW-EXIT=0/.test(all),
  (all.match(/SW-EXIT=\d+/) || ['no SW-EXIT marker'])[0]);

// Leg 3 — one present from main() is legal (the SDL_AppInit allowance).
check('a single present from main() stays legal', all.includes('ONE-OK') && all.includes('ONE-EXIT=0'),
  (all.match(/ONE-EXIT=\d+/) || ['no ONE-EXIT marker'])[0]);

process.exit(failures ? 1 : 0);
