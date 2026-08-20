'use strict';
// tests/host/test_sdl_loadwav_diff.js — the #723 (#529-B) differential suite:
// the gucOS SDL_LoadWAV (the adapted, demand-linked pinned-upstream decoder)
// against the committed upstream-oracle manifest, over the whole fixture
// corpus.
//
// THE CLAIM THIS PINS. For every fixture in tests/unit/sdl_load_wav_fixtures/
// (every codec/width, mono/stereo/3ch/4ch, extensible headers, odd padded
// chunks, unknown chunks, chunk ordering, valid/lying/short fact chunks,
// truncated data, malformed MS/IMA headers/coefficients/sample counts,
// zero-length data, lying lengths, invalid alignment/rate/channels, the
// frozen 10000-chunk limit, and upstream's own sample.wav/sword.wav), the
// gucOS loader returns EXACTLY what pinned upstream SDL 3.4.0 returns:
// same success/failure, same spec, same length, byte-identical decoded
// buffers (sha256), and the SAME ERROR STRING — the adaptation preserved
// upstream's decoder logic and wording verbatim, so nothing weaker than
// string equality is accepted. manifest.json is the oracle's committed
// verdict (provenance: tests/unit/sdl_load_wav/upstream.json).
//
// Plus: the demand-link zero-byte witness (a no-LoadWAV SDL program carries
// no decoder literal and is compiled without the decoder TU), and red
// controls proving the comparator can actually fail.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '../..');
const FIXDIR = path.join(ROOT, 'tests/unit/sdl_load_wav_fixtures');
const MANIFEST = require(path.join(FIXDIR, 'manifest.json'));

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('  ok   ' + name); }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + (e && e.message)); failures++; }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdl-loadwav-diff-'));
const outdir = path.join(tmp, 'pcm');
fs.mkdirSync(outdir);

// The dumper: argv[1] = output dir, argv[2..] = wav paths. One line per wav:
//   <basename>|ok|<format>|<channels>|<freq>|<len>|<bufnull>   (+ .pcm file)
//   <basename>|err|<SDL error string>
const DUMPER = `
#include <SDL.h>
#include <stdio.h>
#include <string.h>
int main(int argc, char **argv) {
    if (argc < 3) return 2;
    for (int i = 2; i < argc; i++) {
        SDL_AudioSpec spec; Uint8 *buf = 0; Uint32 len = 0;
        const char *base = argv[i];
        for (const char *p = argv[i]; *p; p++) if (*p == '/') base = p + 1;
        memset(&spec, 0x5a, sizeof(spec));
        if (!SDL_LoadWAV(argv[i], &spec, &buf, &len)) {
            printf("%s|err|%s\\n", base, SDL_GetError());
            continue;
        }
        char outpath[512];
        snprintf(outpath, sizeof(outpath), "%s/%s.pcm", argv[1], base);
        FILE *f = fopen(outpath, "wb");
        if (!f) return 3;
        if (len && fwrite(buf, 1, len, f) != len) return 4;
        fclose(f);
        printf("%s|ok|%d|%d|%d|%u|%d\\n", base, (int)spec.format, spec.channels,
               spec.freq, (unsigned)len, buf == 0);
        SDL_free(buf);
    }
    return 0;
}
`;

function compile(name, source, flags) {
  const c = path.join(tmp, name + '.c');
  const w = path.join(tmp, name + '.wasm');
  fs.writeFileSync(c, source);
  cp.execFileSync('node', [path.join(ROOT, 'compiler.js'), c, '-o', w].concat(flags || []), { stdio: 'pipe' });
  return w;
}

// Compare one dumper result line against one manifest entry; returns null or
// a mismatch description. Exact error-string equality is deliberate (see top).
function compareOne(name, line, want) {
  const p = line.split('|');
  if (want.ok) {
    if (p[1] !== 'ok') return 'expected ok, got: ' + line;
    const [fmt, ch, freq, len, bufnull] = p.slice(2).map(Number);
    if (fmt !== want.format) return `format ${fmt} != ${want.format}`;
    if (ch !== want.channels) return `channels ${ch} != ${want.channels}`;
    if (freq !== want.freq) return `freq ${freq} != ${want.freq}`;
    if (len !== want.len) return `len ${len} != ${want.len}`;
    if (!!bufnull !== want.bufnull) return `bufnull ${bufnull} != ${want.bufnull}`;
    const pcmPath = path.join(outdir, name + '.pcm');
    const got = fs.existsSync(pcmPath) ? fs.readFileSync(pcmPath) : Buffer.alloc(0);
    const sha = crypto.createHash('sha256').update(got).digest('hex');
    if (sha !== want.sha256) return `decoded bytes differ (sha256 ${sha} != ${want.sha256})`;
    return null;
  }
  if (p[1] !== 'err') return 'expected err, got: ' + line;
  const err = p.slice(2).join('|');
  if (err !== want.error) return `error string: got "${err}" want "${want.error}"`;
  return null;
}

const names = Object.keys(MANIFEST.fixtures).sort();
assert(names.length >= 90, 'manifest lost fixtures: ' + names.length);

let dumperWasm = null;
check('the dumper compiles (demand-linked decoder TU)', () => {
  dumperWasm = compile('dumper', DUMPER);
});

const results = new Map();
check('one run decodes the whole corpus', () => {
  assert(dumperWasm, 'no dumper');
  const args = ['host.js', dumperWasm, outdir].concat(names.map((n) => path.join(FIXDIR, n)));
  const out = cp.execFileSync('node', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 24 });
  for (const line of out.trim().split('\n')) {
    const name = line.split('|', 1)[0];
    results.set(name, line);
  }
  assert.strictEqual(results.size, names.length, 'dumper reported ' + results.size + ' of ' + names.length);
});

check('every fixture matches the pinned upstream oracle exactly', () => {
  const bad = [];
  for (const name of names) {
    const line = results.get(name);
    if (!line) { bad.push(name + ': no result'); continue; }
    const why = compareOne(name, line, MANIFEST.fixtures[name]);
    if (why) bad.push(name + ': ' + why);
  }
  assert(bad.length === 0, bad.length + ' mismatches:\n       ' + bad.join('\n       '));
  console.log('       (' + names.length + ' fixtures byte-identical with upstream ' + MANIFEST._meta.pin + ')');
});

// Red controls: the comparator must be able to fail on every axis it checks.
check('red control: a perturbed success expectation fails', () => {
  const name = 'pcm_s16_stereo.wav';
  const want = { ...MANIFEST.fixtures[name], len: MANIFEST.fixtures[name].len + 2 };
  assert(compareOne(name, results.get(name), want), 'len perturbation not caught');
  const want2 = { ...MANIFEST.fixtures[name], sha256: '0'.repeat(64) };
  assert(compareOne(name, results.get(name), want2), 'sha perturbation not caught');
});
check('red control: a perturbed error expectation fails', () => {
  const name = 'unknown_tag.wav';
  const want = { ok: false, error: 'Some other wording' };
  assert(compareOne(name, results.get(name), want), 'error perturbation not caught');
});

// The demand-link zero-byte witness (the #722 deadstrip pattern, B edition):
// a no-LoadWAV SDL program must carry no decoder literal — in EVERY mode —
// because the decoder TU was never even compiled in, and the never-fired
// conditional declaration is WITHDRAWN before link (the counter-pass fix:
// --no-fold / --no-undefined keep unreferenced decls and error on undefined
// ones, a pre-existing property of those modes, so the withdrawal is what
// keeps a non-referencing program compiling byte-identical there).
const WAVE_LITERAL = 'Could not find RIFF or WAVE identifiers';
const NOLOAD_SRC = `
#include <SDL.h>
#include <stdio.h>
int main(void) {
    if (!SDL_Init(SDL_INIT_VIDEO)) return 1;
    printf("ticks=%d\\n", (int)SDL_GetTicks());
    SDL_Quit();
    return 0;
}
`;
check('a no-LoadWAV SDL program carries no decoder literal (TU not compiled)', () => {
  const wasm = fs.readFileSync(compile('noload', NOLOAD_SRC));
  assert(!wasm.includes(Buffer.from(WAVE_LITERAL, 'utf8')), 'decoder literal leaked into a non-referencing program');
});
check('--no-fold: a no-LoadWAV SDL program still compiles clean of the decoder', () => {
  const wasm = fs.readFileSync(compile('noload_nofold', NOLOAD_SRC, ['--no-fold']));
  assert(!wasm.includes(Buffer.from(WAVE_LITERAL, 'utf8')), 'decoder literal leaked under --no-fold');
});
check('--no-undefined: a no-LoadWAV SDL program still compiles clean of the decoder', () => {
  const wasm = fs.readFileSync(compile('noload_noundef', NOLOAD_SRC, ['--no-undefined']));
  assert(!wasm.includes(Buffer.from(WAVE_LITERAL, 'utf8')), 'decoder literal leaked under --no-undefined');
});
check('--no-fold positive control: a REFERENCING program carries the decoder', () => {
  const wasm = fs.readFileSync(compile('dumper_nofold', DUMPER, ['--no-fold']));
  assert(wasm.includes(Buffer.from(WAVE_LITERAL, 'utf8')), 'demand link did not fire under --no-fold');
});
check('positive control: the referencing dumper really carries that literal', () => {
  const wasm = fs.readFileSync(dumperWasm);
  assert(wasm.includes(Buffer.from(WAVE_LITERAL, 'utf8')), 'probe literal not found (decoder rewording?)');
});
// Symbol-generality legs (counter-pass): __require_source_if keys on
// VARIABLES exactly like functions, and every reference route the bag walk
// claims is proven behaviorally against the real builtin TU.
function run(wasmPath, args) {
  return cp.execFileSync('node', [path.join(ROOT, 'host.js'), wasmPath].concat(args || []),
                         { cwd: ROOT, encoding: 'utf8' });
}
check('a VARIABLE-keyed directive fires on an extern read (symbol-general)', () => {
  // cd=-1 is the initializer inside __SDL_wave.c — printing it proves the
  // demand fired and the TU linked (an unfired demand would be a loud
  // undefined-symbol error here, never a silent 0). The decoder LITERAL is
  // legitimately absent: no decoder function is live, so the dead-literal
  // prune sheds it — the variable alone was wanted.
  const w = compile('varfire', `
#include <SDL.h>
#include <stdio.h>
__require_source_if("__sdl_wave_alloc_countdown", "__SDL_wave.c");
extern int __sdl_wave_alloc_countdown;
int main(void) { printf("cd=%d\\n", __sdl_wave_alloc_countdown); return 0; }
`);
  assert.strictEqual(run(w).trim(), 'cd=-1');
});
check('a user DEFINITION of the keyed variable suppresses the builtin', () => {
  const w = compile('varsupp', `
#include <SDL.h>
#include <stdio.h>
__require_source_if("__sdl_wave_alloc_countdown", "__SDL_wave.c");
int __sdl_wave_alloc_countdown = 42;
int main(void) { printf("cd=%d\\n", __sdl_wave_alloc_countdown); return 0; }
`);
  assert.strictEqual(run(w).trim(), 'cd=42');
  assert(!fs.readFileSync(w).includes(Buffer.from(WAVE_LITERAL, 'utf8')), 'builtin linked over a user variable definition');
});
check('an address-taken-only reference in a global initializer fires', () => {
  const w = compile('addrfire', `
#include <SDL.h>
bool (*g_loader)(const char *, SDL_AudioSpec *, Uint8 **, Uint32 *) = SDL_LoadWAV;
int main(void) { return g_loader == 0; }
`);
  assert(fs.readFileSync(w).includes(Buffer.from(WAVE_LITERAL, 'utf8')), 'global-initializer reference did not fire');
});
check('a designated-initializer reference (EInitList) bubbles up and fires', () => {
  const w = compile('initfire', `
#include <SDL.h>
struct ops { int tag; bool (*load)(const char *, SDL_AudioSpec *, Uint8 **, Uint32 *); };
static struct ops O = { .load = SDL_LoadWAV };
int main(void) { return O.load == 0; }
`);
  assert(fs.readFileSync(w).includes(Buffer.from(WAVE_LITERAL, 'utf8')), 'EInitList reference did not bubble to the bag');
});
check('default mode: a DEAD STATIC referencing SDL_LoadWAV does not fire (pruned first)', () => {
  const w = compile('deadstatic', `
#include <SDL.h>
#include <stdio.h>
static void never_used(void) { SDL_AudioSpec s; Uint8 *b; Uint32 n; SDL_LoadWAV("x", &s, &b, &n); }
int main(void) { printf("ok\\n"); return 0; }
`);
  assert.strictEqual(run(w).trim(), 'ok');
  assert(!fs.readFileSync(w).includes(Buffer.from(WAVE_LITERAL, 'utf8')), 'dead static over-linked the decoder');
});
check('an extern-linkage never-called function fires (conservative) but ships zero decoder bytes', () => {
  const w = compile('deadextern', `
#include <SDL.h>
#include <stdio.h>
void helper_never_called(void) { SDL_AudioSpec s; Uint8 *b; Uint32 n; SDL_LoadWAV("x", &s, &b, &n); }
int main(void) { printf("ok\\n"); return 0; }
`);
  assert.strictEqual(run(w).trim(), 'ok');
  assert(!fs.readFileSync(w).includes(Buffer.from(WAVE_LITERAL, 'utf8')), 'dead-literal prune failed to shed the conservatively-linked decoder');
});
check('a user definition of SDL_LoadWAV suppresses the builtin (no duplicate symbol)', () => {
  const w = compile('userdef', `
#include <SDL.h>
#include <stdio.h>
bool SDL_LoadWAV(const char *path, SDL_AudioSpec *spec, Uint8 **audio_buf, Uint32 *audio_len) {
    (void)path; (void)spec; (void)audio_buf; (void)audio_len;
    printf("user impl\\n");
    return 0; /* <SDL.h> deliberately ships no true/false macros */
}
int main(void) {
    SDL_AudioSpec s; Uint8 *b; Uint32 n;
    return SDL_LoadWAV("x", &s, &b, &n) ? 1 : 0;
}
`);
  const wasm = fs.readFileSync(w);
  assert(!wasm.includes(Buffer.from(WAVE_LITERAL, 'utf8')), 'builtin decoder linked over a user definition');
});

fs.rmSync(tmp, { recursive: true, force: true });
if (failures) { console.log(`\n${failures} FAILED`); process.exit(1); }
console.log('\nAll sdl-loadwav-diff checks passed');
