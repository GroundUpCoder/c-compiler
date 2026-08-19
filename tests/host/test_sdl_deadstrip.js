'use strict';
// tests/host/test_sdl_deadstrip.js — the #722 zero-byte witness on the
// DEFAULT (shipping/bake) flag path, review finding 1.
//
// THE CLAIM THIS PINS. An SDL program that never references the #529-A
// audio-stream/mixing API must gain ZERO bytes from its existence — under
// the DEFAULT compile flags the bake uses (os-common.js passes no
// --gc-sections), not just under the opt-in whole-program shake. The
// wasm-level tree-shake always dropped unreferenced CODE; what leaked was
// rodata: string literals interned while emitting later-dropped bodies
// stayed in the data section (measured +1758 B on every SDL binary). The
// dead-literal prune (computeLiveFunctions + literal ownership in
// getStringAddress + zeroing before the sparse segment emitter) closes the
// class. This test pins it BEHAVIORALLY: the literal bytes themselves must
// be absent from the emitted binary, with positive controls proving the
// probe strings are real and the prune never strips a referenced or
// global-pinned literal.
//
// Probe strings are #722-owned error texts (verbatim from __SDL.c) plus a
// synthetic literal in a generated fixture, so the test needs no baseline
// binary from another commit.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
let failures = 0;
function check(name, fn) {
  try { fn(); console.log('  ok   ' + name); }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + (e && e.message)); failures++; }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdl-deadstrip-'));
function compile(name, source, flags) {
  const c = path.join(tmp, name + '.c');
  const w = path.join(tmp, name + '.wasm');
  fs.writeFileSync(c, source);
  cp.execFileSync('node', [path.join(ROOT, 'compiler.js'), c, '-o', w].concat(flags || []),
                  { stdio: 'pipe' });
  return fs.readFileSync(w);
}
function containsBytes(hay, needle) {
  return hay.includes(Buffer.from(needle, 'utf8'));
}

// #722-owned literals, verbatim from __SDL.c's audio engine. If a wording
// edit renames one, this test fails LOUD on its positive control (the
// referencing program below must contain it), never silently.
const A_LITERALS = [
  'a partial device frame is pending',
  'SDL_MixAudio(): unknown audio format',
  'audio backlog overflow',
];

const NO_AUDIO_SDL = `
#include <SDL.h>
#include <stdio.h>
int main(void) {
    if (!SDL_Init(SDL_INIT_VIDEO)) return 1;
    printf("ticks=%d\\n", (int)SDL_GetTicks());
    SDL_Quit();
    return 0;
}
`;

const AUDIO_SDL = `
#include <SDL.h>
int main(void) {
    SDL_AudioSpec a = { SDL_AUDIO_S16, 1, 48000 };
    SDL_AudioSpec b = { SDL_AUDIO_F32, 2, 48000 };
    SDL_AudioStream *s = SDL_CreateAudioStream(&a, &b);
    char buf[16] = { 0 };
    SDL_PutAudioStreamData(s, buf, 8);
    SDL_GetAudioStreamData(s, buf, 16);
    SDL_MixAudio((Uint8 *)buf, (const Uint8 *)buf, SDL_AUDIO_S16, 8, 0.5f);
    SDL_SetAudioStreamFormat(s, &a, NULL);
    SDL_DestroyAudioStream(s);
    return 0;
}
`;

check('default flags: a no-audio SDL program carries no #529-A literal', () => {
  const wasm = compile('noaudio', NO_AUDIO_SDL);
  for (const lit of A_LITERALS) {
    assert(!containsBytes(wasm, lit), `leaked literal: "${lit}"`);
  }
});

check('positive control: a referencing program really carries those literals', () => {
  const wasm = compile('audio', AUDIO_SDL);
  for (const lit of A_LITERALS) {
    assert(containsBytes(wasm, lit), `probe literal not found (renamed?): "${lit}"`);
  }
});

check('general property: an unreferenced non-static function sheds its literal', () => {
  const wasm = compile('plaindead', `
#include <stdio.h>
int never_called_722(int x) {
    printf("DEADSTRIP-PROBE-LITERAL-%d", x);
    return x * 3;
}
int main(void) { printf("alive\\n"); return 0; }
`);
  assert(!containsBytes(wasm, 'DEADSTRIP-PROBE-LITERAL'), 'dead literal survived');
  assert(containsBytes(wasm, 'alive'), 'live literal missing');
});

check('positive control: the same literal survives when the function is called', () => {
  const wasm = compile('plainlive', `
#include <stdio.h>
int called_722(int x) {
    printf("DEADSTRIP-PROBE-LITERAL-%d", x);
    return x * 3;
}
int main(void) { return called_722(1) - 3; }
`);
  assert(containsBytes(wasm, 'DEADSTRIP-PROBE-LITERAL'), 'referenced literal stripped');
});

check('a global-initializer literal is pinned even when only dead code touches it', () => {
  const wasm = compile('globpin', `
#include <stdio.h>
const char *g_pin = "GLOBAL-PIN-LITERAL-722";
int never_called(void) { return (int)g_pin[0]; }
int main(void) { printf("ok\\n"); return 0; }
`);
  // the global itself is live data (non-static, addressable) — its literal
  // must never be zeroed by the prune
  assert(containsBytes(wasm, 'GLOBAL-PIN-LITERAL-722'), 'global-pinned literal stripped');
});

check('an address-taken function keeps its literal', () => {
  const wasm = compile('addrtaken', `
#include <stdio.h>
int handler_722(int x) { printf("ADDR-TAKEN-LITERAL-722"); return x; }
int (*g_fp)(int) = handler_722;
int main(void) { return g_fp(0); }
`);
  assert(containsBytes(wasm, 'ADDR-TAKEN-LITERAL-722'), 'address-taken literal stripped');
});

check('the pruned binary still runs (host smoke)', () => {
  const c = path.join(tmp, 'runsmoke.c');
  const w = path.join(tmp, 'runsmoke.wasm');
  fs.writeFileSync(c, NO_AUDIO_SDL);
  cp.execFileSync('node', [path.join(ROOT, 'compiler.js'), c, '-o', w], { stdio: 'pipe' });
  const out = cp.execFileSync('node', [path.join(ROOT, 'host.js'), w], { encoding: 'utf8' });
  assert(out.includes('ticks='), 'program output missing: ' + out);
});

fs.rmSync(tmp, { recursive: true, force: true });
if (failures) { console.log(`\n${failures} FAILED`); process.exit(1); }
console.log('\nAll sdl-deadstrip checks passed');
