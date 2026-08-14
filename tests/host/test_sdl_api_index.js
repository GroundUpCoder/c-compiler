'use strict';
// #677: the generated SDL API index (os/doc/sdl-api-index.md) must not drift
// from the header surface it describes. The file exists because of a measured
// failure (#508 Pass B: ~17 of 34 gcode rounds spent grepping /usr/include/
// SDL.h before the first line of game code), so — the #505 lesson — a WRONG
// line in it is worse than a missing one: the agent acts on it directly, and
// a stale "notably absent" claim (#672 made SDL_RenderTextureRotated real)
// would steer the agent AWAY from surface that exists.
//
// The shape is the mkmpgenhdr.js precedent: the doc is committed AND
// generated; `node tools/mksdlindex.js --check` regenerates from compiler.js's
// builtin header map and fails on any byte difference. This test pins:
//
//   - the committed doc is in sync with the generator (the drift gate);
//   - the doc is baked (image.json) and referenced (GCODE.md, doc README);
//   - the generator's own guards are not vacuous (RED controls: a tampered
//     doc fails the comparator, an unknown function name fails the group
//     matcher, an absence claim about a PRESENT symbol is refused);
//   - the "notably absent" boundary holds BEHAVIORALLY: representative
//     absent names fail as undeclared through the real cc driver, and the
//     documented alternatives (SDL_UpdateTexture, SDL_RenderTextureRotated)
//     really compile. Per todos/PRINCIPLES.md these absence assertions are
//     maintained claims: filling one is a two-sided edit (implement the
//     symbol AND update tools/mksdlindex.js's ABSENT list — regeneration
//     refuses until you do).
//
//   node tests/host/test_sdl_api_index.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const COMMON = require(path.join(ROOT, 'os', 'os-common.js'));
const HOST = require(path.join(ROOT, 'host.js'));
const BLOCK_FS = HOST.BLOCK_FS;
const INDEX_TOOL = require(path.join(ROOT, 'tools', 'mksdlindex.js'));

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'os', 'image.json'), 'utf8'));
const gcodeDoc = fs.readFileSync(path.join(ROOT, 'os', 'gcode', 'GCODE.md'), 'utf8');
const docReadme = fs.readFileSync(path.join(ROOT, 'os', 'doc', 'README.md'), 'utf8');

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log('  ok   ' + name); }
  catch (e) { console.log('  FAIL ' + name + '\n         ' + (e.message || e)); failures++; }
};

// ---- 1. the drift gate: committed doc == regenerated doc --------------
check('node tools/mksdlindex.js --check passes (committed index in sync)', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'mksdlindex.js'), '--check'],
    { cwd: ROOT, encoding: 'utf8' });
  assert(r.status === 0, '--check exited ' + r.status + ' — the committed index drifted from the header surface:\n'
    + (r.stderr || '') + (r.stdout || ''));
});

check('RED control: a tampered copy fails the comparator', () => {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sdlindex-')), 'tampered.md');
  fs.writeFileSync(tmp, fs.readFileSync(INDEX_TOOL.OUT, 'utf8') + 'SDL_MadeUpFunction();\n');
  const r = INDEX_TOOL.check(tmp);
  assert(r.ok === false, 'the comparator accepted a tampered file — the sync green above is vacuous');
  fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
});

// ---- 2. baked + referenced --------------------------------------------
check('image.json bakes /usr/share/doc/sdl-api-index.md from os/doc/sdl-api-index.md', () => {
  const entry = manifest.system.files['/usr/share/doc/sdl-api-index.md'];
  assert(entry && entry.bin === 'os/doc/sdl-api-index.md',
    'manifest entry missing or wrong: ' + JSON.stringify(entry));
});

check('GCODE.md points the agent at the index; the doc README lists it', () => {
  assert(gcodeDoc.includes('/usr/share/doc/sdl-api-index.md'),
    'GCODE.md no longer references the SDL API index — the round-sink this file exists to kill is back');
  assert(docReadme.includes('sdl-api-index.md'),
    'os/doc/README.md chapter table lost the sdl-api-index.md row');
});

// ---- 3. the generator's guards are not vacuous ------------------------
check('RED control: an unknown function name fails the group matcher', () => {
  assert.throws(() => INDEX_TOOL.groupFor('SDL_TotallyNovelThing'),
    /matches no GROUP rule/,
    'groupFor accepted an unknown name — new surface could be dropped silently');
});

check('RED control: an unknown constant name fails the cluster matcher', () => {
  assert.throws(() => INDEX_TOOL.clusterFor('SDL_NOVEL_CONSTANT_FAMILY_X'),
    /matches no CLUSTER prefix/,
    'clusterFor accepted an unknown name — new constants could be dropped silently');
});

check('RED control: claiming a PRESENT symbol absent is refused (two-sided edit gate)', () => {
  const CompilerJS = require(path.join(ROOT, 'compiler.js'));
  const sdlHeader = CompilerJS.createDefaultPPRegistry().standardHeaders.get('SDL.h');
  assert(sdlHeader, 'standardHeaders has no SDL.h — the header map moved; resync this test');
  const parsed = INDEX_TOOL.parseHeader('SDL.h', sdlHeader);
  assert.throws(() => INDEX_TOOL.assertAbsent(
    [{ label: 'x', absent: ['SDL_RenderTexture'] }], parsed.stripped),
    /the header surface HAS it/,
    'assertAbsent let a present symbol be claimed absent — the absent list could go #672-stale');
  // and the positive direction: a truly absent name passes
  INDEX_TOOL.assertAbsent([{ label: 'x', absent: ['SDL_DefinitelyNotAThing'] }], parsed.stripped);
});

// ---- 4. the absence boundary, behaviorally (the #505 cc harness) ------
const ccHarness = (() => {
  const CompilerJS = require(path.join(ROOT, 'compiler.js'));
  const store = new BLOCK_FS.MemoryByteStore(64 * 1024 * 1024);
  const kfs = BLOCK_FS.create(store);
  const compile = COMMON.createCcDriver(CompilerJS, kfs);
  const enc = new TextEncoder();
  let n = 0;
  return (src) => {
    const p = '/idx' + (n++) + '.c';
    const fd = kfs.open(p, 0x1 | 0x40 | 0x200, 0o644);
    const b = enc.encode(src);
    kfs.write(fd, b, b.length);
    kfs.close(fd);
    return compile(['cc', p, '-o', '/idx.out'], '/');
  };
})();

check('documented-absent symbols really fail as undeclared', () => {
  // NB TTF_OpenFont left this list when #468 made the classic SDL_ttf
  // surface real (the two-sided edit); Mix_OpenAudio pins the SDL_mixer
  // absence claim in its place.
  for (const sym of ['SDL_SetRenderTarget', 'SDL_LockTexture', 'Mix_OpenAudio']) {
    const r = ccHarness('#include <SDL.h>\nint main(void){' + sym + '(0);return 0;}\n');
    assert(r.exitCode !== 0 && (r.stderr || '').includes("Undeclared identifier '" + sym + "'"),
      sym + ' unexpectedly compiled (exit ' + r.exitCode + ') — it EXISTS now; '
      + 'two-sided edit: update the ABSENT list in tools/mksdlindex.js and regenerate: ' + r.stderr);
  }
});

check('the documented alternatives compile (incl. #672’s SDL_RenderTextureRotated)', () => {
  const r1 = ccHarness('#include <SDL.h>\nint main(void){SDL_UpdateTexture(0,0,0,0);return 0;}\n');
  assert(r1.exitCode === 0, 'SDL_UpdateTexture no longer compiles: ' + r1.stderr);
  const r2 = ccHarness('#include <SDL.h>\nint main(void){SDL_RenderTextureRotated(0,0,0,0,0.0,0,SDL_FLIP_NONE);return 0;}\n');
  assert(r2.exitCode === 0, 'SDL_RenderTextureRotated no longer compiles — the index’s present list is stale: ' + r2.stderr);
});

console.log(failures ? '\n' + failures + ' sdl-api-index check(s) FAILED' : '\nAll sdl-api-index checks passed');
process.exit(failures ? 1 : 0);
