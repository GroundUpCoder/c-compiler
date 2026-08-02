'use strict';
// #434: the manifest referential-integrity check — red-then-green, ragged.
//
// v223 shipped three Desktop launchers invoking `sameboy` after #417/#418
// un-baked that binary: dead icons on every clean first boot. The durable
// fix is checkManifestRefs (os-common.js), run FIRST by every
// bakeSystemImage. This test holds it to the ticket's own standard:
//
//   - RED controls: a checker only ever observed passing is vacuous (the
//     #97 standard). Every reference kind gets a deliberately dangling
//     fixture that must FAIL — including a literal replay of the v223
//     launchers injected back into the REAL manifest.
//   - GREEN: the real manifest passes, raw (the minimal/deploy shape) AND
//     with every non-gated package folded (the fat fixture shape).
//   - NEGATIVE controls: `/usr/bin/python -> /usr/bin/cmdalt` and the
//     minesweeper Desktop sample (shell keywords, `[ -f /usr/... ]`
//     absence probes, runtime-relative `./minesweeper`) must NOT be
//     flagged — and the test asserts they are still IN the manifest, so
//     the green is not vacuous either.
//   - RAGGED: one dangling command inside an otherwise-healthy script
//     yields exactly ONE error (a matcher that flags shell keywords
//     produces false uniformity — the failure class the ticket names).
//   - ON THE BUILD PATH: bakeSystemImage itself refuses a dangling
//     manifest (the check is not an opt-in script).
//
//   node tests/host/test_manifest_refs.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const COMMON = require(path.join(ROOT, 'os', 'os-common.js'));

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log('  ok   ' + name); }
  catch (e) { console.log('  FAIL ' + name + '\n         ' + (e.message || e)); failures++; }
};

// A minimal healthy substrate the red controls perturb: one real binary,
// /bin/sh, one link, one launcher.
const base = () => ({
  version: 1,
  system: {
    dirs: ['/usr/bin', '/usr/share', '/usr/share/menu', '/usr/share/menu/Games'],
    files: {
      '/usr/bin/sh': { c: 'sh.c' },
      '/usr/bin/doom': { c: 'doom.c' },
      '/usr/share/menu/Games/doom': { link: '/usr/bin/doom' },
    },
  },
  user: {
    dirs: ['/root/Desktop'],
    files: {
      '/root/Desktop/doom': { link: '/usr/bin/doom' },
    },
  },
});
const errsOf = (m) => COMMON.checkManifestRefs(m);

/* ---- RED: every reference kind fails when dangled ---- */

check('RED: a launcher invoking an absent command fails', () => {
  const m = base();
  m.user.files['/root/Desktop/ghost'] =
    { content: '#!/bin/sh\nsameboy $HOME/roms/x.gb\n', mode: 0o755 };
  const errs = errsOf(m);
  assert.strictEqual(errs.length, 1, JSON.stringify(errs));
  assert.ok(/\/root\/Desktop\/ghost.*'sameboy'/.test(errs[0]), errs[0]);
});

check('RED: a dangling symlink target fails', () => {
  const m = base();
  m.system.files['/usr/share/menu/Games/gone'] = { link: '/usr/bin/gone' };
  const errs = errsOf(m);
  assert.strictEqual(errs.length, 1, JSON.stringify(errs));
  assert.ok(/link target '\/usr\/bin\/gone'/.test(errs[0]), errs[0]);
});

check('RED: an absolute sealed-territory argument that is not baked fails', () => {
  const m = base();
  m.system.files['/usr/share/menu/Games/demo'] =
    { content: '#!/bin/sh\ndoom /usr/share/decks/missing.deck\n' };
  const errs = errsOf(m);
  assert.strictEqual(errs.length, 1, JSON.stringify(errs));
  assert.ok(/path '\/usr\/share\/decks\/missing\.deck'/.test(errs[0]), errs[0]);
});

check('RED: a dangling shebang interpreter fails', () => {
  const m = base();
  m.user.files['/root/Desktop/py'] = { content: '#!/usr/bin/python9\nx\n' };
  const errs = errsOf(m);
  // the body 'x' also fails to resolve — assert the interpreter error is there
  assert.ok(errs.some((e) => /interpreter '\/usr\/bin\/python9'/.test(e)),
    JSON.stringify(errs));
});

check('RED: an openwith value naming an absent command fails', () => {
  const m = base();
  m.system.files['/usr/share/openwith'] = { content: 'gb\t/bin/sameboy\n' };
  const errs = errsOf(m);
  assert.strictEqual(errs.length, 1, JSON.stringify(errs));
  assert.ok(/openwith.*'\/bin\/sameboy'/.test(errs[0]), errs[0]);
});

check('RED: a sounds-scheme WAV that is not baked fails', () => {
  const m = base();
  m.system.files['/usr/share/sounds/scheme'] =
    { content: 'SystemStart\t/usr/share/sounds/missing.wav\n' };
  const errs = errsOf(m);
  assert.strictEqual(errs.length, 1, JSON.stringify(errs));
  assert.ok(/sounds\/missing\.wav/.test(errs[0]), errs[0]);
});

check('RED: a dangling command inside `sh -c "…"` fails (recursed body)', () => {
  const m = base();
  m.system.files['/usr/share/menu/Games/wrapped'] =
    { content: '#!/bin/sh\nexec sh -c "/usr/bin/absent; doom"\n' };
  const errs = errsOf(m);
  assert.strictEqual(errs.length, 1, JSON.stringify(errs));
  assert.ok(/'\/usr\/bin\/absent'/.test(errs[0]), errs[0]);
});

/* ---- the v223 replay: the exact shipped defect, against the REAL manifest ---- */

const rawManifest = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'os', 'image.json'), 'utf8'));

check('RED: the literal v223 sameboy launchers injected into the real manifest fail 3x', () => {
  const m = JSON.parse(JSON.stringify(rawManifest));
  m.user.files['/root/Desktop/pokemon'] =
    { content: '#!/bin/sh\nsameboy $HOME/roms/PokemonBlue.gb\n', mode: 0o755 };
  m.user.files['/root/Desktop/mario'] =
    { content: '#!/bin/sh\nsameboy $HOME/roms/SuperMarioDeluxe.gbc\n', mode: 0o755 };
  m.user.files['/root/Desktop/drmario'] =
    { content: '#!/bin/sh\nsameboy $HOME/roms/DrMario.gb\n', mode: 0o755 };
  const errs = errsOf(m);
  assert.strictEqual(errs.length, 3, JSON.stringify(errs));
  assert.ok(errs.every((e) => /'sameboy'/.test(e)), JSON.stringify(errs));
});

/* ---- GREEN: the real manifest, both deploy shapes ---- */

check('GREEN: the real manifest (raw = the minimal/deploy shape) is clean', () => {
  assert.deepStrictEqual(errsOf(rawManifest), []);
});

check('GREEN: the real manifest with all non-gated packages folded is clean', () => {
  const folded = COMMON.foldPackages(fs, path, ROOT, rawManifest, 'all').manifest;
  assert.deepStrictEqual(errsOf(folded), []);
});

check('GREEN: every single-package fold is clean (partial-fold shapes)', () => {
  for (const name of COMMON.listPackages(fs, path, ROOT, {})) {
    const folded = COMMON.foldPackages(fs, path, ROOT, rawManifest, [name]).manifest;
    assert.deepStrictEqual(errsOf(folded), [], 'fold of ' + name);
  }
});

/* ---- NEGATIVE controls: present in the manifest AND not flagged ---- */

check('negative control: /usr/bin/python -> cmdalt is still in the manifest (green not vacuous)', () => {
  assert.deepStrictEqual(rawManifest.system.files['/usr/bin/python'],
    { link: '/usr/bin/cmdalt' },
    'the python dispatch link left the manifest — re-pin this control');
});

check('negative control: the minesweeper Desktop sample is still in the manifest', () => {
  const e = rawManifest.user.files[
    '/root/Desktop/Presentations/samples/minesweeper-programming-rainbow.sh'];
  assert.ok(e && typeof e.content === 'string' && e.content.startsWith('#!/bin/sh'),
    'the minesweeper sample left the manifest — re-pin this control');
  // its false-positive traps are load-bearing for the raggedness claim:
  assert.ok(/\[ -f \/usr\/include\/png\.h \]/.test(e.content) &&
            /for f in /.test(e.content) && /\.\/minesweeper/.test(e.content),
    'the sample lost its keyword/absence-probe/relative-path traps');
});

check('negative control: the cmdalt seed (package-name values) is exempt', () => {
  const m = base();
  m.system.files['/usr/share/cmdalt'] = { content: 'python\tcpython-clang\n' };
  assert.deepStrictEqual(errsOf(m), []);
});

/* ---- RAGGED: one bad edge -> exactly one error ---- */

check('ragged: one dangling command in a keyword-heavy script yields exactly ONE error', () => {
  const m = base();
  m.user.files['/root/Desktop/busy'] = { content: [
    '#!/bin/sh',
    '# comment with words like for done set',
    'set -e',
    'FOO=bar',
    '[ -f /usr/include/nothere.h ] || echo probe ok',
    'for f in a b c; do',
    '    doom "$f" > /tmp/out 2> /tmp/err',
    'done',
    'if true; then doom; else doom; fi',
    'cd /somewhere && ./relative-thing',
    'ghostcmd --flag',
    '',
  ].join('\n'), mode: 0o755 };
  const errs = errsOf(m);
  assert.strictEqual(errs.length, 1, JSON.stringify(errs));
  assert.ok(/'ghostcmd'/.test(errs[0]), errs[0]);
});

/* ---- ON THE BUILD PATH: bakeSystemImage refuses a dangling manifest ---- */

(async () => {
  const name = 'bakeSystemImage throws on a dangling reference before doing any work';
  try {
    const { BLOCK_FS } = require(path.join(ROOT, 'host.js'));
    const CompilerJS = require(path.join(ROOT, 'compiler.js'));
    const m = base();
    m.user.files['/root/Desktop/ghost'] =
      { content: '#!/bin/sh\nsameboy x.gb\n', mode: 0o755 };
    const store = new BLOCK_FS.MemoryByteStore(1 << 16);
    const io = {
      readAsset: () => { throw new Error('bake ran — the check must refuse first'); },
      readBinary: () => { throw new Error('bake ran'); },
      buildProject: () => { throw new Error('bake ran'); },
      log: () => {},
    };
    let threw = null;
    try { await COMMON.bakeSystemImage(BLOCK_FS, CompilerJS, store, m, io); }
    catch (e) { threw = e; }
    assert.ok(threw, 'bakeSystemImage accepted a dangling manifest');
    assert.ok(/referential-integrity/.test(threw.message) && /'sameboy'/.test(threw.message),
      threw.message);
    console.log('  ok   ' + name);
  } catch (e) {
    console.log('  FAIL ' + name + '\n         ' + (e.message || e));
    failures++;
  }
  console.log(failures ? failures + ' check(s) FAILED'
                       : 'manifest referential-integrity checks OK');
  process.exit(failures ? 1 : 0);
})();
