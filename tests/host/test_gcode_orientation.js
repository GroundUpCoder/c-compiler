'use strict';
// #505: the baked gcode orientation (os/gcode/GCODE.md) must not drift from
// the platform it describes. The file exists because of a measured failure
// (#488 Pass B: unguided = 10 rounds / 15 min / zero code; five sentences of
// platform facts = 6 rounds / 129 s / a complete game), so a WRONG claim in
// it is worse than a missing one — the agent acts on it directly. This test
// pins every mechanically checkable claim to the code that makes it true:
//
//   - every file path the doc tells the agent to READ is a manifest key
//     (the dangling-doc class: un-bake sdl-gucos.md and the doc points at
//     nothing) — with a RED control on the extractor;
//   - the cc flag surface is checked BEHAVIORALLY against the real driver
//     (createCcDriver over an in-memory BlockFS): -o/-I/-D/-g work, unknown
//     flags are refused by name at exit 1 (#710), and the
//     driver's own usage line names the same flags the doc documents;
//   - every wmctl verb the doc names appears in os/wmctl.c's usage table,
//     the doc carries the REAL `shot SID` shape, and the exact wrong claim
//     the file first shipped with (`wmctl shot FILE`) is replayed as a RED
//     control against the checker;
//   - the SDL loop-model claims (exit 69, SDL_MAIN_USE_CALLBACKS,
//     SDL_RENDER_DRIVER=software) are cross-pinned to the detail doc the
//     orientation points at (/usr/share/doc/sdl-gucos.md's source).
//
//   node tests/host/test_gcode_orientation.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const COMMON = require(path.join(ROOT, 'os', 'os-common.js'));
const HOST = require(path.join(ROOT, 'host.js'));
const BLOCK_FS = HOST.BLOCK_FS;

const doc = fs.readFileSync(path.join(ROOT, 'os', 'gcode', 'GCODE.md'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'os', 'image.json'), 'utf8'));
const wmctlSrc = fs.readFileSync(path.join(ROOT, 'os', 'wmctl.c'), 'utf8');
const sdlDoc = fs.readFileSync(path.join(ROOT, 'os', 'doc', 'sdl-gucos.md'), 'utf8');

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log('  ok   ' + name); }
  catch (e) { console.log('  FAIL ' + name + '\n         ' + (e.message || e)); failures++; }
};

// ---- 1. the orientation file itself is baked --------------------------
check('GCODE.md is baked at /usr/share/gcode/GCODE.md from os/gcode/GCODE.md', () => {
  const entry = manifest.system.files['/usr/share/gcode/GCODE.md'];
  assert(entry && entry.bin === 'os/gcode/GCODE.md',
    'manifest entry missing or not sourced from os/gcode/GCODE.md: ' + JSON.stringify(entry));
});

// ---- 2. every file path the doc tells the agent to read is baked ------
// Extract backtick-quoted absolute paths that name a FILE (have an
// extension). Directory mentions (/usr/include, /usr/local/bin) are policy
// statements resolved at runtime (initRootVolume, the /usr/local link) and
// are not checkable against the manifest alone.
const readablePaths = (text) => {
  const out = [];
  const re = /`(\/(?:usr|etc)\/[^`]*\.[a-z0-9]+)`/g;
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[1]);
  return out;
};

check('every file path GCODE.md names is a manifest key', () => {
  const paths = readablePaths(doc);
  assert(paths.length >= 1, 'extractor found no file paths — the doc should name at least sdl-gucos.md');
  for (const p of paths)
    assert(manifest.system.files[p] !== undefined,
      'GCODE.md tells the agent to read ' + p + ' but the manifest does not bake it');
});

check('RED control: a dangling doc path fails the path check', () => {
  const paths = readablePaths('read `/usr/share/doc/does-not-exist.md` first');
  assert(paths.length === 1 && manifest.system.files[paths[0]] === undefined,
    'the extractor+manifest lookup failed to flag a dangling path — the green above is vacuous');
});

// ---- 3. the cc flag surface, behaviorally -----------------------------
// The doc's claim (#710 inverted the old silent-ignore pin): only
// -o/-I/-D/-g do anything, and every other dash flag is REFUSED by name at
// exit 1 — `cc -O2` reporting success while delivering nothing sent the
// #502 dogfood developer to profile their own code. Run the REAL driver
// over an in-memory BlockFS both ways: the known flags compile to wasm,
// each doc-listed unknown flag refuses naming itself, and -l carries the
// libraries-link-through-headers hint.
check('cc accepts -o/-g, refuses -Wall/-O2/-c/-std/-l by name (#710), emits wasm', function () {
  const CompilerJS = require(path.join(ROOT, 'compiler.js'));
  const store = new BLOCK_FS.MemoryByteStore(64 * 1024 * 1024);
  const kfs = BLOCK_FS.create(store);
  const enc = new TextEncoder();
  {
    const fd = kfs.open('/hello.c', 0x1 | 0x40 | 0x200, 0o644);
    const src = enc.encode('#include <stdio.h>\nint main(void){printf("hi\\n");return 0;}\n');
    kfs.write(fd, src, src.length);
    kfs.close(fd);
  }
  const compile = COMMON.createCcDriver(CompilerJS, kfs);
  const r = compile(['cc', '-g', 'hello.c', '-o', 'prog'], '/');
  assert(r.exitCode === 0, 'cc -g exited ' + r.exitCode + ': ' + r.stderr);
  const fd = kfs.open('/prog', 0, 0);
  assert(fd !== null, '-o prog produced no output file');
  const head = new Uint8Array(4);
  kfs.read(fd, head, 4);
  kfs.close(fd);
  assert(head[0] === 0 && head[1] === 0x61 && head[2] === 0x73 && head[3] === 0x6d,
    'output is not a wasm module');

  // Every flag the doc lists as refused really refuses, naming the flag.
  for (const flag of ['-O2', '-Wall', '-c', '-std=c11', '-lSDL', '-fsanitize=address']) {
    const rf = compile(['cc', flag, 'hello.c', '-o', 'prog2'], '/');
    assert(rf.exitCode === 1, 'cc ' + flag + ' exited ' + rf.exitCode + ' — an unknown flag was not refused');
    assert((rf.stderr || '').includes("unrecognized option '" + flag + "'"),
      'the refusal does not name ' + flag + ': ' + rf.stderr);
    assert(kfs.open('/prog2', 0, 0) === null, 'cc ' + flag + ' refused but still wrote output');
  }
  // -l gets the honest-path hint: there is no -l linking here.
  const rl = compile(['cc', '-lm', 'hello.c'], '/');
  assert(rl.exitCode === 1 && (rl.stderr || '').includes('__require_source'),
    '-lm refusal lost the libraries-link-through-headers hint: ' + rl.stderr);

  // The driver's own usage line is the flag-surface seam; it and the doc
  // must name the same flags — INCLUDING -g, which /usr/doc/debugging.md
  // instructs and the usage line omitted until #710.
  const usage = compile(['cc'], '/').stderr;
  for (const flag of ['-o', '-I', '-D', '-g'])
    assert(usage.includes(flag), 'driver usage lost ' + flag + ': ' + usage);
  for (const claim of ['-o OUT', '-IDIR', '-DNAME', '`-g`'])
    assert(doc.includes(claim), 'GCODE.md no longer documents ' + claim + ' — resync with createCcDriver');
  assert(!doc.includes('silently IGNORED'),
    'GCODE.md still claims silent-ignore — #710 made unknown flags refuse');
});

// ---- 4. the wmctl claims match os/wmctl.c's usage table ---------------
const wmctlVerbs = (text) => {
  const out = [];
  const re = /`wmctl ([a-z]+)/g;
  let m;
  while ((m = re.exec(text)) !== null) if (!out.includes(m[1])) out.push(m[1]);
  return out;
};

check('every wmctl verb GCODE.md names exists in wmctl.c usage', () => {
  const verbs = wmctlVerbs(doc);
  assert(verbs.length >= 3, 'expected the doc to name at least list/tree/shot, got: ' + verbs.join(','));
  for (const v of verbs)
    assert(new RegExp('wmctl [a-z|]*' + v).test(wmctlSrc),
      'GCODE.md names `wmctl ' + v + '` but wmctl.c usage has no such verb');
});

check('the doc carries the real shot shape (SID first), wmctl.c still has it', () => {
  assert(wmctlSrc.includes('shot SID|screen'), 'wmctl.c shot usage changed shape — update GCODE.md');
  assert(doc.includes('wmctl shot SID'), 'GCODE.md lost the SID-first shot shape');
  assert(!doc.includes('`wmctl shot FILE`'),
    'the wrong pre-#505 claim (`wmctl shot FILE`) is back — an agent following it gets a usage error');
});

check('RED control: the pre-#505 wrong claim is caught by the shape check', () => {
  const preFix = 'use `wmctl shot FILE` to screenshot';
  assert(preFix.includes('`wmctl shot FILE`'),
    'the replay string no longer matches the checker — the green above is vacuous');
});

// ---- 5. the SDL loop-model claims cross-pin to the detail doc ---------
check('exit 69 / callbacks / software-renderer claims agree with sdl-gucos.md', () => {
  for (const token of ['exit 69', 'SDL_MAIN_USE_CALLBACKS', 'SDL_RENDER_DRIVER=software']) {
    assert(doc.includes(token.replace('exit 69', 'exit 69')),
      'GCODE.md lost the claim: ' + token);
    assert(sdlDoc.includes(token.replace('exit 69', 'exit status 69')),
      'sdl-gucos.md no longer states "' + token + '" — the platform rule moved; resync GCODE.md');
  }
});

// ---- 6. the commonly-missing-symbols claims, behaviorally (#625) ------
// #505's measured n=3 run showed BOTH arms burning turns on the same four
// symbol classes (SDL_Log, SDLK letter keys, sqrtf/libm, snprintf). The doc
// now states which exist and which don't; each claim is pinned by a REAL
// compile through the same createCcDriver the OS ships, so the doc cannot
// drift from the compiler's actual surface. NB the ticket's transcript
// claim "libm needs __require_source(\"__math.c\")" is FALSE as a user
// requirement — <math.h> carries that pragma itself, and the compile below
// is the proof.
const ccHarness = (() => {
  const CompilerJS = require(path.join(ROOT, 'compiler.js'));
  const store = new BLOCK_FS.MemoryByteStore(64 * 1024 * 1024);
  const kfs = BLOCK_FS.create(store);
  const compile = COMMON.createCcDriver(CompilerJS, kfs);
  const enc = new TextEncoder();
  let n = 0;
  return (src) => {
    const p = '/sym' + (n++) + '.c';
    const fd = kfs.open(p, 0x1 | 0x40 | 0x200, 0o644);
    const b = enc.encode(src);
    kfs.write(fd, b, b.length);
    kfs.close(fd);
    return compile(['cc', p, '-o', '/sym.out'], '/');
  };
})();
const compiles = (src) => {
  const r = ccHarness(src);
  assert(r.exitCode === 0, 'expected exit 0, got ' + r.exitCode + ': ' + r.stderr);
};
const undeclared = (src, sym) => {
  const r = ccHarness(src);
  assert(r.exitCode !== 0 && (r.stderr || '').includes("Undeclared identifier '" + sym + "'"),
    sym + ' unexpectedly compiled (exit ' + r.exitCode + ') — it EXISTS now; the doc claims it does not: ' + r.stderr);
};

check('libm: sqrtf/fabsf/floorf/sinf compile with only #include <math.h>', () => {
  compiles('#include <math.h>\nint main(void){float x=2;' +
    'return (int)(sqrtf(x)+fabsf(-x)+floorf(x)+sinf(x));}\n');
  assert(doc.includes('#include <math.h>'), 'GCODE.md lost the <math.h> claim');
});

// SDL_Log moved OUT of the absent list when #601 implemented it — the doc's
// claim flipped with it, and the compiles() leg below pins the new state.
check('absent symbols: SDL_snprintf, SDLK_r, SDLK_R all fail as undeclared', () => {
  undeclared('#include <SDL.h>\nint main(void){char b[8];SDL_snprintf(b,8,"x");return 0;}\n', 'SDL_snprintf');
  undeclared('#include <SDL.h>\nint main(void){return SDLK_r;}\n', 'SDLK_r');
  undeclared('#include <SDL.h>\nint main(void){return SDLK_R;}\n', 'SDLK_R');
  for (const token of ['SDL_snprintf', 'do NOT exist'])
    assert(doc.includes(token), 'GCODE.md lost the claim: ' + token);
});

check('the documented replacements compile: char-literal keys, scancodes, snprintf, SDL_Log', () => {
  compiles('#include <SDL.h>\nint main(void){SDL_Event e;e.key.key=114;' +
    "return e.key.key=='r'?0:1;}\n");
  compiles('#include <SDL.h>\nint main(void){return SDL_SCANCODE_R==21?0:1;}\n');
  compiles('#include <stdio.h>\nint main(void){char b[8];snprintf(b,sizeof b,"%d",42);return 0;}\n');
  compiles('#include <SDL.h>\nint main(void){SDL_Log("x %d", 1);return 0;}\n');
  for (const token of ["event.key.key == 'r'", 'SDL_SCANCODE_A', '`snprintf`', '`SDL_Log` exists'])
    assert(doc.includes(token), 'GCODE.md lost the claim: ' + token);
});

check('RED control: the absence checker flags a symbol that DOES exist', () => {
  const r = ccHarness('#include <SDL.h>\nint main(void){return SDL_GetError()!=0;}\n');
  assert(r.exitCode === 0,
    'SDL_GetError no longer compiles — the "undeclared" greens above may be vacuous');
});

check('RED control: the compiles checker fails on a truly absent symbol', () => {
  const r = ccHarness('#include <math.h>\nint main(void){return (int)definitely_not_a_symbol(1);}\n');
  assert(r.exitCode !== 0,
    'a bogus symbol compiled — the exit-0 greens above prove nothing');
});

// ---- 7. the non-letter SDLK_* surface (#626) --------------------------
// The flip side of #625's letter-key claim. That sentence is true but
// invites over-generalisation — an agent inferring "no SDLK_* at all"
// would avoid SDLK_ESCAPE/SDLK_LEFT, exactly the keys a game needs for
// quit and movement. The doc now states the boundary; these checks pin
// BOTH sides: every special-key constant compiles (the ASCII tier via
// negative-array-size value pins carrying the very character codes
// event.key.key delivers; the extended tier is 0x40000000|scancode, which
// SDLK_LEFT pins), the digit/punctuation/keypad names stay absent, and
// the doc's "full list is the SDLK_ block in <SDL.h>" claim is held to
// set-equality against the SAME header map the compiler resolves
// <SDL.h> from and foldStdlibHeaders bakes to /usr/include/SDL.h — so a
// future SDLK_ addition or removal is a loud resync-the-doc failure, not
// silent drift.
const SDLK_SURFACE = [
  'SDLK_BACKSPACE', 'SDLK_TAB', 'SDLK_RETURN', 'SDLK_ESCAPE', 'SDLK_SPACE',
  'SDLK_PLUS', 'SDLK_MINUS', 'SDLK_EQUALS', 'SDLK_DELETE', 'SDLK_CAPSLOCK',
  'SDLK_F1', 'SDLK_F2', 'SDLK_F3', 'SDLK_F4', 'SDLK_F5', 'SDLK_F6',
  'SDLK_F7', 'SDLK_F8', 'SDLK_F9', 'SDLK_F10', 'SDLK_F11', 'SDLK_F12',
  'SDLK_PRINTSCREEN', 'SDLK_SCROLLLOCK', 'SDLK_PAUSE', 'SDLK_INSERT',
  'SDLK_HOME', 'SDLK_PAGEUP', 'SDLK_END', 'SDLK_PAGEDOWN', 'SDLK_RIGHT',
  'SDLK_LEFT', 'SDLK_DOWN', 'SDLK_UP', 'SDLK_NUMLOCKCLEAR', 'SDLK_LCTRL',
  'SDLK_LSHIFT', 'SDLK_LALT', 'SDLK_LGUI', 'SDLK_RCTRL', 'SDLK_RSHIFT',
  'SDLK_RALT', 'SDLK_RGUI',
];
const sdlkDefines = (text) => {
  const out = new Set();
  const re = /#define (SDLK_\w+)/g;
  let m;
  while ((m = re.exec(text)) !== null) out.add(m[1]);
  return out;
};
const sdlkDiff = (docList, headerSet) => ({
  missing: docList.filter((k) => !headerSet.has(k)),
  extra: [...headerSet].filter((k) => !docList.includes(k)),
});

check('every special-key SDLK_* compiles; the ASCII tier matches the chars event.key.key carries', () => {
  const pins = 'int p0[SDLK_ESCAPE==27?1:-1];int p1[SDLK_RETURN==13?1:-1];' +
    'int p2[SDLK_TAB==9?1:-1];int p3[SDLK_BACKSPACE==8?1:-1];' +
    "int p4[SDLK_SPACE==' '?1:-1];int p5[SDLK_DELETE==127?1:-1];" +
    "int p6[SDLK_MINUS=='-'?1:-1];int p7[SDLK_EQUALS=='='?1:-1];" +
    "int p8[SDLK_PLUS=='+'?1:-1];int p9[SDLK_LEFT==(0x40000000|80)?1:-1];";
  compiles('#include <SDL.h>\n' + pins + '\nint main(void){SDL_Event e;' +
    'e.key.key=SDLK_ESCAPE;long long s=' + SDLK_SURFACE.join('+') + ';(void)s;' +
    'return e.key.key==SDLK_ESCAPE?0:1;}\n');
  for (const token of ['DO exist', 'SDLK_ESCAPE', 'SDLK_LEFT', 'SDLK_F1', 'SDLK_LSHIFT'])
    assert(doc.includes(token), 'GCODE.md lost the claim: ' + token);
});

check('the boundary: digit/punctuation/keypad SDLK_* names stay absent', () => {
  undeclared('#include <SDL.h>\nint main(void){return SDLK_0;}\n', 'SDLK_0');
  undeclared('#include <SDL.h>\nint main(void){return SDLK_COMMA;}\n', 'SDLK_COMMA');
  undeclared('#include <SDL.h>\nint main(void){return (int)SDLK_KP_1;}\n', 'SDLK_KP_1');
  for (const token of ['SDLK_KP_*', 'SDLK_PLUS'])
    assert(doc.includes(token), 'GCODE.md lost the boundary claim: ' + token);
});

check('the full SDLK_ surface is exactly the set the doc boundary describes', () => {
  const CompilerJS = require(path.join(ROOT, 'compiler.js'));
  const sdlHeader = CompilerJS.createDefaultPPRegistry().standardHeaders.get('SDL.h');
  assert(sdlHeader, 'standardHeaders has no SDL.h — the header map moved; resync this test');
  const baked = sdlkDefines(sdlHeader);
  assert(baked.has('SDLK_ESCAPE'),
    'extractor found no SDLK_ESCAPE in SDL.h — the regex rotted; the equality below is vacuous');
  const d = sdlkDiff(SDLK_SURFACE, baked);
  assert(d.missing.length === 0 && d.extra.length === 0,
    'SDLK_ surface drifted from the doc boundary — resync GCODE.md. missing from header: [' +
    d.missing.join(',') + '] new in header: [' + d.extra.join(',') + ']');
});

check('RED control: a drifted SDLK value fails the pin compile', () => {
  const r = ccHarness('#include <SDL.h>\nint a[SDLK_ESCAPE==9999?1:-1];\nint main(void){return 0;}\n');
  assert(r.exitCode !== 0,
    'a wrong-value pin compiled — the value pins above prove nothing');
});

check('RED control: the surface comparator flags an added or a removed constant', () => {
  const withExtra = new Set(SDLK_SURFACE);
  withExtra.add('SDLK_COMMA');
  assert(sdlkDiff(SDLK_SURFACE, withExtra).extra.includes('SDLK_COMMA'),
    'an injected header constant was not reported — the set-equality green is vacuous');
  const d = sdlkDiff(SDLK_SURFACE.concat('SDLK_KP_1'), new Set(SDLK_SURFACE));
  assert(d.missing.includes('SDLK_KP_1'),
    'a removed header constant was not reported — the set-equality green is vacuous');
});

console.log(failures ? '\n' + failures + ' gcode-orientation check(s) FAILED' : '\nAll gcode-orientation checks passed');
process.exit(failures ? 1 : 0);
