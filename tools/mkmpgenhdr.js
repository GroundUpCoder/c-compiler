#!/usr/bin/env node
// mkmpgenhdr.js — regenerate vendor/micropython/genhdr/* from the vendored
// sources + mpconfigport.h (todos/0117 R1).
//
// WHY THIS EXISTS
// ---------------
// MicroPython's interned-string pool (`qstr`), its module registry, its GC
// root-pointer list and its compressed error-text table are all GENERATED at
// build time by upstream Python scripts that scan the PREPROCESSED sources.
// Which qstrs exist is therefore a function of `mpconfigport.h` — flip
// MICROPY_PY_IO on and `io`, `StringIO`, `readinto`, ... must appear in the
// pool or the build fails to link.
//
// This repo has no Makefile for vendored projects (the sqlite/lua precedent:
// a hand-listed bin.json), so the generated headers are COMMITTED under
// `vendor/micropython/genhdr/`. Before this tool they were hand-extended,
// which is why `mpconfigport.h` carried the comment "Enable features that
// don't need QSTR pool regeneration" — a config ceiling nobody could raise.
// This tool removes that ceiling: it drives upstream's OWN generators
// (`py/makeqstrdefs.py`, `py/makeqstrdata.py`, `py/makemoduledefs.py`,
// `py/make_root_pointers.py`, `py/makecompresseddata.py`, all vendored) over
// a `cc -E` pass, exactly as upstream's `py/mkrules.mk` does.
//
// Usage:
//   node tools/mkmpgenhdr.js              # regenerate in place
//   node tools/mkmpgenhdr.js --check      # regenerate to a temp dir, diff,
//                                         # exit 1 if the committed headers
//                                         # are stale (the sync guard)
//   node tools/mkmpgenhdr.js --dir vendor/micropython --project bin.json ...
//
// Requirements: `cc` (a C preprocessor; Apple clang / gcc both work) and
// `python3` — the same two host tools tests/run.py already hard-requires for
// the tcc/fuzz differential categories.
//
// NOTES ON FIDELITY TO UPSTREAM
// - The preprocessor pass is the HOST cc, not our wasm compiler (compiler.js
//   has no -E mode). Upstream cross-builds do the same thing with the target
//   CPP; `-D__wasm__` is passed so mpconfigport.h takes the wasm branch. Only
//   `#if` evaluation matters here, and nothing in the qstr-bearing sources
//   branches on host word size.
// - Frozen modules are EXCLUDED from the scan (upstream's SRC_QSTR_EXCLUSIONS
//   does the same): `_frozen_mpy.c` defines its own qstrs as an enum extending
//   MP_QSTRnumber_of, so scanning it would double-define them.
// - Every project's sources are scanned as a UNION, because one committed
//   genhdr serves every build of the vendored tree (bin.json's REPL/script
//   main and test_bin.json's stdin-driven test main).

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

// Sources that carry pre-assigned qstrs of their own and must not be scanned.
const QSTR_SCAN_EXCLUDE = new Set(['_frozen_mpy.c']);

const GEN_FILES = [
  'qstrdefs.generated.h',
  'moduledefs.h',
  'root_pointers.h',
  'compressed.data.h',
];

function usage(code) {
  process.stdout.write(
    'usage: node tools/mkmpgenhdr.js [--check] [--dir DIR] [--project P]...\n' +
    '  --check       do not write; diff against the committed headers (exit 1 if stale)\n' +
    '  --dir DIR     vendored project dir (default vendor/micropython)\n' +
    '  --project P   a bin.json-shaped project file inside DIR; repeatable\n' +
    '                (default: bin.json test_bin.json)\n');
  process.exit(code);
}

function parseArgs(argv) {
  const opts = { check: false, dir: 'vendor/micropython', projects: [], cc: process.env.CC || 'cc' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') opts.check = true;
    else if (a === '--dir') opts.dir = argv[++i];
    else if (a === '--project') opts.projects.push(argv[++i]);
    else if (a === '-h' || a === '--help') usage(0);
    else { process.stderr.write('mkmpgenhdr: unknown argument ' + a + '\n'); usage(2); }
  }
  if (!opts.projects.length) opts.projects = ['bin.json', 'test_bin.json'];
  return opts;
}

function run(cmd, args, o) {
  const r = spawnSync(cmd, args, Object.assign({ encoding: 'utf8' }, o || {}));
  if (r.error) throw new Error(cmd + ': ' + r.error.message);
  if (r.status !== 0) {
    throw new Error(cmd + ' ' + args.join(' ') + ' failed (' + r.status + ')\n' +
                    (r.stderr || '') + (r.stdout || ''));
  }
  return r.stdout;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dir = path.resolve(ROOT, opts.dir);
  if (!fs.existsSync(path.join(dir, 'py', 'makeqstrdefs.py'))) {
    throw new Error('mkmpgenhdr: ' + dir + ' does not look like a vendored MicroPython ' +
                    '(py/makeqstrdefs.py missing)');
  }

  // --- 1. gather the union of every project's sources ------------------
  const sources = [];
  const seen = new Set();
  for (const p of opts.projects) {
    const proj = JSON.parse(fs.readFileSync(path.join(dir, p), 'utf8'));
    for (const s of proj.sources || []) {
      if (QSTR_SCAN_EXCLUDE.has(path.basename(s))) continue;
      if (seen.has(s)) continue;
      seen.add(s);
      sources.push(s);
    }
  }
  sources.sort();   // deterministic output regardless of manifest ordering

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mpgenhdr-'));
  const out = path.join(tmp, 'genhdr');
  fs.mkdirSync(out, { recursive: true });

  // The preprocessor flags. `-I genhdr` still resolves because NO_QSTR makes
  // py/qstr.h skip the generated include — so this is not circular.
  const cppFlags = ['-E', '-DNO_QSTR', '-D__wasm__', '-I.', '-Igenhdr', '-Wno-everything'];
  const py = (script, args) =>
    run('python3', [path.join('py', script), ...args], { cwd: dir });

  // --- 2. one preprocessed blob over every source ----------------------
  py('makeqstrdefs.py', ['pp', opts.cc, 'output', path.join(tmp, 'qstr.i.last'),
                         'cflags', ...cppFlags, 'sources', ...sources]);

  // --- 3. split+cat the four extraction modes --------------------------
  for (const mode of ['qstr', 'module', 'root_pointer', 'compress']) {
    const collected = path.join(tmp, mode + '.collected');
    py('makeqstrdefs.py', ['split', mode, path.join(tmp, 'qstr.i.last'),
                           path.join(tmp, mode), collected]);
    py('makeqstrdefs.py', ['cat', mode, '_', path.join(tmp, mode), collected]);
  }

  // --- 4. qstrdefs.generated.h -----------------------------------------
  // upstream: cat py/qstrdefs.h <port qstrdefs> <collected> | sed | cpp | sed
  // The sed pair quotes the Q(...) lines so the preprocessor leaves their
  // contents alone while still evaluating the surrounding #if config gates.
  const catted = [
    fs.readFileSync(path.join(dir, 'py', 'qstrdefs.h'), 'utf8'),
    fs.existsSync(path.join(dir, 'qstrdefsport.h'))
      ? fs.readFileSync(path.join(dir, 'qstrdefsport.h'), 'utf8') : '',
    fs.readFileSync(path.join(tmp, 'qstr.collected'), 'utf8'),
  ].join('');
  const quoted = catted.replace(/^(Q\(.*\))$/gm, '"$1"');
  const ppOut = execFileSync(opts.cc, [...cppFlags, '-x', 'c', '-'],
                             { cwd: dir, input: quoted, encoding: 'utf8',
                               maxBuffer: 64 * 1024 * 1024 });
  const unquoted = ppOut.replace(/^"(Q\(.*\))"$/gm, '$1');
  fs.writeFileSync(path.join(tmp, 'qstrdefs.preprocessed.h'), unquoted);
  fs.writeFileSync(path.join(out, 'qstrdefs.generated.h'),
                   py('makeqstrdata.py', [path.join(tmp, 'qstrdefs.preprocessed.h')]));

  // --- 5. the three smaller tables -------------------------------------
  fs.writeFileSync(path.join(out, 'moduledefs.h'),
                   py('makemoduledefs.py', [path.join(tmp, 'module.collected')]));
  fs.writeFileSync(path.join(out, 'root_pointers.h'),
                   py('make_root_pointers.py', [path.join(tmp, 'root_pointer.collected')]));
  fs.writeFileSync(path.join(out, 'compressed.data.h'),
                   py('makecompresseddata.py', [path.join(tmp, 'compress.collected')]));

  // --- 6. install or check ---------------------------------------------
  const dst = path.join(dir, 'genhdr');
  let stale = [];
  for (const f of GEN_FILES) {
    const fresh = fs.readFileSync(path.join(out, f), 'utf8');
    const cur = fs.existsSync(path.join(dst, f))
      ? fs.readFileSync(path.join(dst, f), 'utf8') : null;
    if (fresh === cur) continue;
    stale.push(f);
    if (!opts.check) fs.writeFileSync(path.join(dst, f), fresh);
  }

  if (opts.check) {
    if (stale.length) {
      process.stderr.write(
        'mkmpgenhdr --check: committed genhdr is STALE vs sources+mpconfigport.h: ' +
        stale.join(', ') + '\n  regenerate with: node tools/mkmpgenhdr.js\n' +
        '  (fresh copies left in ' + out + ')\n');
      process.exit(1);
    }
    process.stdout.write('mkmpgenhdr --check: genhdr up to date (' +
                         sources.length + ' sources scanned)\n');
    fs.rmSync(tmp, { recursive: true, force: true });
    return;
  }

  process.stdout.write('mkmpgenhdr: scanned ' + sources.length + ' sources, ' +
                       (stale.length ? 'updated ' + stale.join(', ')
                                     : 'no changes') + '\n');
  fs.rmSync(tmp, { recursive: true, force: true });
}

try {
  main();
} catch (e) {
  process.stderr.write('mkmpgenhdr: ' + (e && e.message ? e.message : String(e)) + '\n');
  process.exit(1);
}
