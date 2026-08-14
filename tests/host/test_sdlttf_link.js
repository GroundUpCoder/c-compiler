'use strict';
// #468: the SDL_ttf veneer's LINK contract — the SDL3_image pattern, pinned
// from the host side where a freetype-less fs is cheap to stand up:
//
//   1. pay-for-what-you-use: a plain <SDL.h> program compiles and links in a
//      filesystem with NO freetype anywhere. If the veneer ever pulled
//      FreeType unconditionally, this compile would fail on the missing
//      required sources — the compile succeeding IS the measurement.
//   2. the missing-backend failure is LOUD and NAMED: a program including
//      <SDL3_ttf/SDL_ttf.h> in that same freetype-less fs fails naming
//      ft2build.h (the freetype package's header), never silently and never
//      as an "Undeclared identifier" — which is also the positive control
//      that the header really declares the TTF_* surface (a missing header
//      would surface as undeclared TTF_Init instead).
//   3. the render acceptance (real ink, UTF-8, wrapping, metrics) is
//      boot-priced and lives in tests/kernel/test_sdlttf_e2e.js.
//
//   node tests/host/test_sdlttf_link.js
const assert = require('assert');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const COMMON = require(path.join(ROOT, 'os', 'os-common.js'));
const HOST = require(path.join(ROOT, 'host.js'));
const CompilerJS = require(path.join(ROOT, 'compiler.js'));
const BLOCK_FS = HOST.BLOCK_FS;

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log('  ok   ' + name); }
  catch (e) { console.log('  FAIL ' + name + '\n         ' + (e.message || e)); failures++; }
};

// A freetype-less fs + the in-OS cc driver over it.
const store = new BLOCK_FS.MemoryByteStore(64 * 1024 * 1024);
const kfs = BLOCK_FS.create(store);
const compile = COMMON.createCcDriver(CompilerJS, kfs);
const enc = new TextEncoder();
function put(p, text) {
  const fd = kfs.open(p, 0x1 | 0x40 | 0x200, 0o644);
  const b = enc.encode(text);
  kfs.write(fd, b, b.length);
  kfs.close(fd);
}

put('/sdl.c', '#include <SDL.h>\nint main(void) { return SDL_Init(SDL_INIT_VIDEO) ? 0 : 1; }\n');
put('/ttf.c', '#include <SDL3_ttf/SDL_ttf.h>\nint main(void) { TTF_Init(); TTF_Font *f = TTF_OpenFont("/x.ttf", 12.0f); return f != NULL; }\n');

check('a plain <SDL.h> program links with NO freetype anywhere (pay-for-what-you-use)', () => {
  const r = compile(['cc', '/sdl.c', '-o', '/sdl.out'], '/');
  assert(r.exitCode === 0,
    'plain SDL program failed in a freetype-less fs (exit ' + r.exitCode + ') — the SDL_ttf veneer '
    + 'leaked FreeType into every link:\n' + (r.stderr || ''));
});

check('a <SDL3_ttf/SDL_ttf.h> program without the freetype package fails LOUD naming ft2build.h', () => {
  const r = compile(['cc', '/ttf.c', '-o', '/ttf.out'], '/');
  assert(r.exitCode !== 0, 'TTF program compiled without freetype — the backend requirement vanished');
  const err = String(r.stderr || '');
  assert(/ft2build\.h/.test(err),
    'the failure does not name ft2build.h (the fix — gucman install freetype — is not discoverable):\n' + err);
  assert(!/Undeclared identifier 'TTF_/.test(err),
    'TTF_* came back undeclared — the builtin SDL_ttf.h header is not declaring its surface:\n' + err);
});

console.log(failures ? '\n' + failures + ' sdlttf-link check(s) FAILED' : '\nAll sdlttf-link checks passed');
process.exit(failures ? 1 : 0);
