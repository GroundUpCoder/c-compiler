#!/usr/bin/env node
'use strict';
// Unified test entry point with diff-aware selection (todos/0084).
//
// One command over the whole test estate — the existing runners stay
// independently invocable; this is a thin dispatcher that knows how to
// invoke them uniformly, and (the point) which of them a given diff needs.
//
//   node tests/run.js all                 # the entire estate, one summary
//   node tests/run.js unit kernel         # named suites
//   node tests/run.js --diff              # suites my working changes need
//   node tests/run.js --diff main         # suites the diff vs `main` needs
//   node tests/run.js --diff --dry-run    # just print the plan
//   node tests/run.js --list              # suites + the path→suite rule table
//
// Passthrough flags (forwarded only to suites that accept them):
//   --filter=STR   substring filter on test name (all suites)
//   -j N           worker count (unit + the suite-runner suites)
//   --resume       skip files that passed last run (suite-runner suites)
//   --fail-fast    stop on first failure (suite-runner suites)
//
// The rule table below is the SINGLE documented source of "what does this
// diff need" — CLAUDE.md points here instead of carrying the lore as prose.
//
// build/test-run/summary.json records what this invocation SELECTED as well as
// what it produced (todos/0339): the `--filter` as given (null when absent),
// the resolved suite list, and — for the suite-runner-backed suites, which keep
// their own manifest — a per-suite `files` block. Without those, `sweep: pass`
// is indistinguishable from a run of one test file, which is exactly what a
// sweep split into two `--filter` halves used to leave behind.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// ---------- Suite registry ----------
//
// Each suite is one runner invocation. `supports` lists the passthrough
// flags the underlying runner accepts, so we never hand run.py a `-j` it
// doesn't understand. `pyTypes` marks a run.py category — those are BATCHED
// into a single `run.py --types=a,b,c` process (one python run, one section).
// `optional` suites (browser sweep) report a launch failure as a skip, not a
// hard fail — Playwright isn't installed in every clone.

const SUITES = {
  unit:    { desc: 'compiler unit corpus (in-process worker runner)',
             cmd: ['node', 'tests/run-unit.js'], supports: ['filter', 'jobs'] },
  blockfs: { desc: 'BlockFS/MountFS filesystem suite',
             cmd: ['node', 'tests/blockfs/run.js'], supports: ['filter', 'jobs', 'resume', 'failFast', 'repeat', 'underLoad'] },
  kernel:  { desc: 'kernel control plane + OS e2e suite',
             cmd: ['node', 'tests/kernel/run.js'], supports: ['filter', 'jobs', 'resume', 'failFast', 'repeat', 'underLoad'] },
  sweep:   { desc: 'browser OS acceptance sweep (real Chromium; needs Playwright)',
             cmd: ['node', 'tests/browser/os-sweep.mjs'], supports: ['filter', 'jobs', 'resume', 'failFast', 'repeat', 'underLoad'],
             optional: true },
  host:    { desc: 'host.js Node output path + serve.js first-run (Node-only)',
             cmd: ['node', 'tests/host/run.js'], supports: [] },
  todos:   { desc: 'queue manifest + liability register validators (todos/0286)',
             cmd: ['node', 'tests/todos/run.js'], supports: ['filter'] },
};

// run.py categories exposed as suites. `unit`/`blockfs` are DELIBERATELY not
// here — the dedicated runners above are faster and own those names.
const PY_CATEGORIES = [
  'ast', 'extra', 'ext', 'projects', 'zlib', 'lua', 'freetype', 'libpng',
  'cairo', 'micropython', 'micropython-upstream', 'sqlite', 'disw',
  'sourcemap', 'tcc', 'libc', 'fuzz', 'fakegit',
];
for (const cat of PY_CATEGORIES) {
  SUITES[cat] = { desc: `run.py --types=${cat}`, pyTypes: cat, supports: ['filter'] };
}

// Execution order: cheap-and-fast first, the image-baking kernel suite and
// the heavy browser sweep last. Any suite not listed here falls after.
const RUN_ORDER = ['todos', 'unit', 'host', 'blockfs', ...PY_CATEGORIES, 'kernel', 'sweep'];

// `all` = the entire estate.
const ALL_SUITES = ['todos', 'unit', 'host', 'blockfs', ...PY_CATEGORIES, 'kernel', 'sweep'];

// ---------- Diff → suite rule table ----------
//
// UNION semantics: every rule whose regex matches a changed path contributes
// its suites. IGNORE patterns drop a path entirely (docs/queue/logs never
// need tests). A changed code path that matches no rule is reported as
// UNMAPPED (warned, not silently skipped) so the table stays honest.

const IGNORE = [
  /^logs\//, /^old\//, /\.md$/i, /^HANDOFF/,
  /^LICENSE$/, /^CONTRIBUTING/, /(^|\/)\.gitignore$/, /(^|\/)\.git\//,
  /^media\//, /(^|\/)README/i,
];

// The liability register (todos/0286) pins a literal line in each file it
// cites, so an edit to any of them can invalidate an entry. Derived from the
// register itself: a new entry enrols its own file with no rule to remember.
// A register that will not parse yields a match-everything pattern, so the
// `todos` suite runs on any diff at all and reports the parse error — a
// broken register widens the gate rather than quietly opening it.
const LIABILITIES = require('../todos/liabilities.js');
const CITED = LIABILITIES.citedFiles();
const CITED_RE = CITED.ok && CITED.files.length
  ? new RegExp('^(' + CITED.files.map(f => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')$')
  : /^/;

// IGNORE drops docs-shaped paths, but todos/ and the register's cited files
// are gated: checked BEFORE it, so `.md$` and friends can't swallow them.
const FORCE = [/^todos\//, CITED_RE];

// [regex, [suite, ...], why]. Order is irrelevant (union), but grouped by
// concern for readability.
const RULES = [
  // The queue manifest, the liability register, and their validators. Their
  // only other trigger is the per-clone-opt-in pre-commit hook, so without
  // this rule they are validators nobody invokes.
  [/^todos\//, ['todos'], 'the queue manifest + the liability register and their validators'],
  [CITED_RE, ['todos'], 'cited by todos/LIABILITIES.md — an edit here can invalidate an entry',
    CITED.ok ? `LIABILITIES.md cites ${CITED.files.length} file(s)` : `LIABILITIES.md UNPARSABLE: ${CITED.error}`],

  // Core compiler — the whole language surface + every consumer of it.
  // (host: the single-file .js/.html emitters live in compiler.js — CD15.)
  [/^compiler\.js$/, ['unit', 'kernel', 'blockfs', 'host'], 'the compiler drives every wasm binary + the single-file emit'],

  // host.js carries BOTH BlockFS/MountFS AND the per-process SDL/fd runtime.
  [/^host\.js$/, ['blockfs', 'kernel', 'sweep', 'host'], 'BlockFS + the process runtime live here'],

  // The owner-side kernel (process table, fds, WM/audio server).
  [/^kernel\.js$/, ['kernel', 'sweep'], 'the process control plane'],

  // The reference OS build: seeded C, boot, compositor, the image manifest.
  [/^os\//, ['kernel', 'sweep'], 'seeded OS sources restale the image; e2e + browser cover it'],
  // The ksvc kernel service blob (todos/0275): /usr/lib/ksvc.wasm + its
  // loader feed BOTH composites' label text — explicit so a future ^os/
  // rule split can't orphan it (same suites as ^os/ today).
  [/^os\/ksvc(\/|\.js$)/, ['kernel', 'sweep'], 'the kernel text service — chrome text in both composites'],
  // os-common's listPackages filter is the base-purity choke point (CLANG-CPP-
  // EPIC II §7) — host holds that guardrail (rules accumulate, so this ADDS host
  // to the ^os/ kernel+sweep above).
  [/^os\/os-common\.js$/, ['host'], 'the listPackages base-purity gate — host guardrail'],
  [/^image\.json$/, ['kernel', 'sweep'], 'the bake manifest'],
  [/^serve\.js$/, ['sweep', 'host'], 'the browser test server + its first-run/overlay checks'],
  // The clang-mandatory dev server (CLANG-CPP-EPIC Part II §6): host holds its
  // preflight guardrail (test_serve_with_clang.js).
  [/^serve-with-clang\.js$/, ['host'], 'the clang-mandatory serve wrapper — its preflight guardrail is a host test'],

  // gucman packages: definitions fold into the fat fixture (--packages=all)
  // AND feed tools/mkpkg.js payloads; test_gucman_e2e consumes both; the base-
  // purity + clangApp guardrails (host) also read them (CLANG-CPP-EPIC II §7).
  [/^packages\//, ['kernel', 'sweep', 'host'], 'package definitions restale the fat fixture + the mkpkg pool + the base-purity guardrail'],
  [/^tools\/mkpkg\.js$/, ['kernel', 'host'], 'builds the gucman package pool test_gucman_e2e installs from; host holds the mkpkg --clang guardrail'],
  // The overlay-drift gate's exemption list (todos/0337): an edit here changes
  // which published clang apps mkpkg --clang accepts as unpackaged, which is
  // exactly what the host guardrail asserts.
  [/^tools\/clang-unpackaged\.json$/, ['host'], 'the mkpkg --clang overlay-drift exemption list the host guardrail exercises'],
  // The offline baker: every kernel e2e image and every browser boot comes
  // out of it (directly, or through the prebaked fixture).
  [/^tools\/mkimage\.js$/, ['kernel', 'sweep'], 'bakes the system blob every e2e image and browser boot is built from'],

  // ---- the rest of tools/ (todos/0333) ----
  //
  // There is deliberately NO blanket `^tools/` rule. tools/ mixes load-bearing
  // build tooling with one-shot asset generators and self-contained side
  // projects, so a blanket rule would tax every unrelated tool edit with the
  // full gate. Every tools/ path states its own answer instead — INCLUDING the
  // ones whose answer is "nothing": an explicit `[]` records a decision, where
  // silence only records that nobody looked. Consequence, and it is the
  // intended one: a NEW tools/ path still reports UNMAPPED, which is the prompt
  // to decide. (The tools rules above and below sit with the concern they
  // serve rather than in this block — mkpkg/mkimage/win32rc/win32ports/
  // mkmpgenhdr/os-drive are all already mapped.)

  // Generators of COMMITTED assets. The outputs are checked in, so an edit here
  // only reaches the tree via a re-run — which makes the gate that matters the
  // suite that CONSUMES the asset, exactly as for mkimage/win32rc above.
  [/^tools\/mksounds\.js$/, ['kernel', 'sweep'],
    'synthesizes os/sounds/*.wav — baked into the image, asserted by test_sounds_e2e.js + os-sounds.mjs'],
  [/^tools\/mkgif\.js$/, ['kernel', 'sweep'],
    'synthesizes vendor/magicpoint/demo.gif — test_present_e2e.js + os-present.mjs assert its pixels'],
  [/^tools\/mkwebfixtures\.js$/, ['kernel'],
    'synthesizes vendor/netsurf/test/img/* — test_netsurf_content_e2e.js decodes them'],
  [/^tools\/build-libc-ext\.js$/, ['ext', 'unit'],
    'generates libc-ext.js — the ext category pins its optional-library contract, the unit ext_* tests consume it'],

  // OS-driving harnesses. They gate nothing themselves; they RIDE a test seam,
  // and the suite that proves the seam is what tells their editor the ground
  // under them still holds — the ^tools/os-drive precedent above.
  [/^tools\/(idlemeter|peek-repro)\.mjs$/, ['sweep'],
    'drive os.html via tests/browser/lib/os-harness.mjs, like tools/os-drive'],
  // The (ours|clang) x (CPython|MicroPython) measurement harness — todos/0332
  // is its live customer. Every cell runs `node host.js <wasm>` standalone, so
  // the cheap host suite is the seam under it. Its in-OS leg (inos-startup.js)
  // additionally drives os/boot.js: pulling the HEAVY kernel suite for a
  // measurement harness is deliberately declined, not overlooked — a bench edit
  // that needs it can name the suite.
  [/^tools\/bench2x2\//, ['host'],
    'the python-runtime bench harness — its cells run host.js standalone'],

  // Self-contained side projects: own trees, own runners, no product artifact,
  // and no suite in this dispatcher consumes them. Gating them would be a
  // fiction, so `[]` is the recorded decision (the tests/bench/ shape below).
  [/^tools\/(asm86|cfg|disasm|sample-wasm-filegen)\//, [],
    'self-contained side tools with their own runners — outside the gated estate'],

  // Shared test engine → every suite-runner-backed suite. `host` is in the list
  // because tests/host/test_harness_leaks.js pins the startup reaper's
  // never-delete-a-live-run predicates (tests/lib/harness-leaks.js) — and that
  // is the cheap suite, so it catches a reaper mistake in seconds rather than
  // after a heavy run.
  [/^tests\/lib\//, ['unit', 'blockfs', 'kernel', 'sweep', 'host'], 'the shared suite-runner/image-fixture/leak-reaper engine'],

  // The OS-page driving tool (0171) rides the browser harness seam — the
  // sweep is what proves that seam still boots and types.
  [/^tools\/os-drive/, ['sweep'], 'drives os.html via tests/browser/lib/os-harness.mjs'],

  // The .res compiler (0068): its output packs feed the win32 apps' menus/
  // dialogs/strings — the kernel win32 e2es are what consume them.
  [/^tools\/win32rc\.js$/, ['kernel'], 'compiles the win32 .res sidecar packs'],

  // The port compile-harness (0060): its --check IS a kernel-suite test
  // (test_win32_ports.js).
  [/^tools\/win32ports\.js$/, ['kernel'], 'the win32 port compile harness'],

  // The MicroPython port (todos/0117). Its two run.py categories are the
  // 639-file upstream corpus; the kernel suite builds it twice (the REPL pty
  // e2e + the script-runner e2e); and it is a gucman package, so it also
  // folds into the fat image fixture every browser boot comes out of —
  // i.e. the same blast radius as a ^packages/ edit.
  // (The vendor/ block near the end of this table states every vendored
  // project's gate, and ends in a catch-all — so no vendor path can report
  // UNMAPPED. This rule is the precedent that block generalizes: package-borne
  // ⇒ the fat-fixture radius.)
  [/^vendor\/micropython\//, ['micropython', 'micropython-upstream', 'kernel', 'sweep'],
    'the MicroPython port: its upstream corpus, both kernel e2es, and the fat-image package'],
  // The genhdr regenerator: its --check (the qstr-pool-vs-config sync guard)
  // runs inside the `micropython` category.
  [/^tools\/mkmpgenhdr\.js$/, ['micropython', 'micropython-upstream'],
    'regenerates vendor/micropython/genhdr; its --check gates the micropython category'],

  // Test trees map to their own suite.
  [/^tests\/unit\//, ['unit'], null],
  [/^tests\/run-unit\.js$/, ['unit'], null],
  [/^tests\/blockfs\//, ['blockfs'], null],
  [/^tests\/kernel\//, ['kernel'], null],
  [/^tests\/browser\//, ['sweep'], null],
  [/^tests\/host\//, ['host'], null],
  [/^tests\/todos\//, ['todos'], null],
  [/^tests\/serve\//, ['host'], null],
  [/^tests\/run\.js$/, [], 'the dispatcher itself — no suite of its own'],
  [/^tests\/bench\//, [], 'informational perf bench (todos/0186) — opt-in, ROM-gated, never a gating suite'],
  [/^tests\/flake\.js$/, [], 'the flake-gate orchestrator (todos/0147) — wraps other suites, no suite of its own'],
  [/^tests\/run\.py$/, PY_CATEGORIES.concat(['unit', 'blockfs']), 'the python runner backs every py category'],
  [/^tests\/sourcemap\//, ['sourcemap'], null],
  [/^tests\/disw\//, ['disw'], null],
  [/^tests\/tcc\//, ['tcc'], null],
  [/^tests\/sqlite\//, ['sqlite'], null],
  [/^tests\/fakegit\//, ['fakegit'], null],
  [/^tests\/ast\//, ['ast'], null],
  [/^tests\/ext\//, ['ext'], null],
  [/^tests\/extra\//, ['extra'], null],
  [/^tests\/projects\//, ['projects'], null],
  [/^tests\/micropython\//, ['micropython', 'micropython-upstream'], null],

  // ---- vendored projects (todos/0318) ----
  //
  // Three axes decide a vendor dir's gate. Every dir below states which of
  // them it answers to; a dir answering none falls to the catch-all at the
  // end of this block.
  //
  //   1. THE BAKE-INPUT CLOSURE. os-common.js's `newestBakeInput` is the
  //      estate's own oracle for "does an edit here restale the system
  //      blob": image.json's project/bin closure (each bin.json expanded
  //      through its `deps`, whole project dir walked) plus EVERY
  //      packages/*.json's, scanned unconditionally. 25 of the 37 vendor
  //      dirs are inside it. The shared fixture is the FAT image
  //      (tests/lib/image-fixture.js bakes `mkimage --packages=all`), so a
  //      packaged app's tree restales the blob every kernel e2e AND every
  //      browser boot comes out of — the same blast radius as a ^packages/
  //      edit, which is why those dirs carry `kernel` + `sweep`.
  //      `sweep` is not redundant with `kernel` here: the headless suite
  //      never constructs a compositor, so a blob change that breaks
  //      RENDERING is invisible to it and visible only in a real browser.
  //   2. a tests/run.py category that builds it → that category.
  //   3. a `vendor/<d>/bin.json` → the `projects` compile check (run.py's
  //      `projects` globs exactly that, so a lib.json-only tree gets no
  //      direct build — it is covered through the consumers that dep on it).
  //
  // Rules UNION, so the catch-all at the end of this block is a FLOOR: every
  // vendor path draws at least `projects`, and no entry here can subtract it.
  // An entry that lists fewer suites is therefore documenting a reason, not
  // narrowing the gate below that floor.
  //
  // Category + closure: each of these is a gucman package or a seeded
  // binary, so it owes the fat-fixture radius on top of its own category.
  [/^vendor\/lua\//, ['lua', 'projects', 'kernel', 'sweep'],
    'the lua package (packages/lua.json) — its category, its build check, and the fat fixture'],
  [/^vendor\/sqlite\//, ['sqlite', 'projects', 'kernel', 'sweep'],
    'the sqlite3 package — no browser leg of its own; `sweep` is the fat-fixture radius'],
  [/^vendor\/zlib\//, ['zlib', 'projects', 'kernel', 'sweep'],
    'linked by libpng/gucman/netsurf, all seeded — a zlib edit changes baked binaries'],
  [/^vendor\/freetype\//, ['freetype', 'projects', 'kernel', 'sweep'],
    'the glyph engine behind ksvc/term/win32/menucore — it moves text in BOTH composites'],
  [/^vendor\/libpng\//, ['libpng', 'projects', 'kernel', 'sweep'],
    'the libpng package + the netsurf/deck image path'],
  [/^vendor\/cairo\//, ['cairo', 'projects', 'kernel', 'sweep'],
    'the cairodemo package; os-cairo.mjs asserts its pixels'],
  [/^vendor\/micropython\//, ['micropython', 'projects'], null],
  [/^vendor\/tcc\//, ['tcc', 'projects'], null],
  [/^vendor\/libc-test\//, ['libc'], null],
  [/^vendor\/disw\//, ['disw', 'projects'], null],
  // libgit2 is a large-codebase compile stress test and the fakegit backend.
  // It is NOT in the bake closure (nothing seeds or packages it), so it
  // deliberately stops at its category + the build check — no OS suites.
  [/^vendor\/libgit2\//, ['fakegit', 'projects'], null],
  // The deterministic fakegit fixture: run.py's `fakegit` category builds it.
  [/^vendor\/fakegit\//, ['fakegit', 'projects'], 'the fakegit category builds this tree'],
  // The Csmith programs the `fuzz` category compiles (run.py CSMITH_CORPUS_DIR).
  // No bin.json, so `projects` would be a no-op — the category IS the gate.
  [/^vendor\/csmith-corpus\//, ['fuzz'], 'the vendored Csmith corpus the fuzz category compiles'],

  // Closure-only: no run.py category of its own, but seeded or packaged, so
  // an edit here changes the blob every e2e and every browser boot uses.
  [/^vendor\/(calc|notepad)\//, ['projects', 'kernel', 'sweep'],
    'seeded win32 apps (os/image.json) — their .res packs ride the blob too'],
  [/^vendor\/winmine\//, ['projects', 'kernel', 'sweep'],
    'the winmine package; test_winmine_e2e.js + os-winmine.mjs assert it'],
  [/^vendor\/(jq|mgba|punes)\//, ['projects', 'kernel', 'sweep'],
    'gucman packages folded into the fat fixture (test_gucman_e2e.js installs them)'],
  [/^vendor\/(giflib|pixman)\//, ['projects', 'kernel', 'sweep'],
    'lib deps of seeded apps (giflib→magicpoint, pixman→cairo) — no direct e2e, real blob bytes'],
  // The baked font faces: two packages plus 8 image.json entries, and run.py's
  // freetype category renders with NotoSansMono. Glyph bytes move every
  // rendered label in both composites, so the browser leg is load-bearing.
  [/^vendor\/fonts\//, ['freetype', 'kernel', 'sweep'],
    'baked faces + two font packages — a face edit moves every rendered glyph'],
  // cJSON is compiled INTO five seeded projects (gucman, software, deck,
  // gcode, deskdefaults) via their `sources`, not their `deps` — so it has no
  // bin.json of its own and `projects` cannot build it. NB it is therefore
  // also MISSED by newestBakeInput, which only recurses `deps`: an edit here
  // changes baked binaries without restaling the blob (todos/0354).
  [/^vendor\/cjson\//, ['kernel', 'sweep'],
    'compiled into five seeded projects; it has no bin.json, so the floor `projects` builds nothing for it'],
  // The browser terminal widget, loaded by os/os.html — VT1 in every browser
  // boot. Headless boot.js never loads os.html, so `kernel` would be a
  // fiction here; the sweep is the whole gate. No bin.json (it is JS).
  [/^vendor\/xterm\//, ['sweep'],
    'the os.html terminal widget — browser-only; it is JS, so the floor `projects` builds nothing for it'],

  // Outside the gated estate. NB an `[]` here would be INERT: rules union and
  // the catch-all below is a floor no entry can subtract from, so these still
  // draw `projects` — which builds nothing for them (neither has a bin.json).
  // They are listed anyway because the point is to record that someone looked.
  [/^vendor\/hello\//, ['projects'],
    'a README + one main.c, zero consumers — the floor is all it gets, and it builds nothing'],
  [/^vendor\/codemirror\//, ['projects'],
    'its only consumer is tools/disasm, itself an explicitly ungated side tool'],
  // Have a bin.json (so the `projects` compile check builds them) but are
  // neither seeded, packaged, nor named by any e2e — verified against
  // os/image.json, packages/*.json and the kernel/browser suites. Stated
  // explicitly so the narrow gate reads as a decision, not an oversight.
  // (tinyemu used to ride the OS-seeded rule below and drew kernel+sweep it
  // could not justify — nothing has seeded it since the 0262 package split.)
  [/^vendor\/(quickjs|tinyemu)\//, ['projects'],
    'compile-only vendored projects: a bin.json build check, nothing seeds them'],
  // NetSurf constellation: bin.json (monkey smoke) is a projects build; the
  // gucOS frontend (gucos/) is seeded as /usr/bin/netsurf and exercised
  // in-window by the test_netsurf_*_e2e family. `sweep` was originally
  // declined here on the grounds that no browser leg names netsurf — true,
  // but it weighs the wrong thing (todos/0318): gucos/ is in the bake
  // closure and packages/netsurf-demos.json folds in too, so an edit here
  // changes the BLOB every browser boot comes out of, exactly like the
  // seeded apps below. The headless suite has no compositor, so it cannot
  // stand in for that.  The two monkey harnesses,
  // vendor/netsurf/smoke.mjs (JS off) and smoke-js.mjs (the JS gate), stay
  // manual recipes documented in vendor/netsurf/README.md: they each rebuild
  // the whole ~850-TU constellation, which the projects suite already covers.
  [/^vendor\/netsurf\//, ['projects', 'kernel', 'sweep'],
    'the browser constellation, its in-window e2es, and the fat fixture it is seeded into'],
  // OS-seeded vendor apps (doom/quake/gameboy/sameboy/busybox/…) restale the
  // image and are exercised by the OS e2es + the browser sweep.
  [/^vendor\/(doom|quake|gameboy|sameboy|snake|busybox|micropython|magicpoint|sent)\//,
    ['projects', 'kernel', 'sweep'], 'seeded into the OS image'],

  // The catch-all. Its job is that a NEWLY vendored tree can never report
  // UNMAPPED — it is a floor, not an answer, so it must stay LAST and must
  // stay. When a new dir lands, give it its own rule above and let this keep
  // covering the next one.
  [/^vendor\//, ['projects'], 'a vendored project build (floor — state the real gate above)'],
];

// ---------- Arg parsing ----------

function parseArgs(argv) {
  const out = { suites: [], diff: false, diffRef: null, dryRun: false,
                list: false, help: false, filter: null, jobs: null,
                resume: false, failFast: false, repeat: null, underLoad: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--list' || a === '--list-suites') out.list = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--resume') out.resume = true;
    else if (a === '--fail-fast') out.failFast = true;
    else if (a === '--repeat') out.repeat = argv[++i];
    else if (a.startsWith('--repeat=')) out.repeat = a.slice(9);
    else if (a === '--under-load') out.underLoad = '';       // bare flag → pass through
    else if (a.startsWith('--under-load=')) out.underLoad = a.slice(13);
    else if (a === '--diff') {
      out.diff = true;
      // Optional ref immediately following, if it isn't another flag.
      if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) out.diffRef = argv[++i];
    }
    else if (a.startsWith('--diff=')) { out.diff = true; out.diffRef = a.slice(7); }
    else if (a.startsWith('--filter=')) out.filter = a.slice(9);
    else if (a === '--filter') out.filter = argv[++i];
    else if (a === '-j' || a === '--jobs') out.jobs = argv[++i];
    else if (a.startsWith('-j')) out.jobs = a.slice(2);
    else if (a === 'all') out.suites.push(...ALL_SUITES);
    else if (a.startsWith('-')) { process.stderr.write(`unknown flag: ${a}\n`); process.exit(2); }
    else if (SUITES[a]) out.suites.push(a);
    else { process.stderr.write(`unknown suite: ${a}\n  (see: node tests/run.js --list)\n`); process.exit(2); }
  }
  return out;
}

// ---------- Diff resolution ----------

function git(args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf-8' });
  if (r.status !== 0) return null;
  return r.stdout.split('\n').map(s => s.trim()).filter(Boolean);
}

function changedFiles(ref) {
  if (ref) {
    // Everything that differs from `ref` (committed or not), plus untracked.
    const diff = git(['diff', '--name-only', ref]) || [];
    const untracked = git(['ls-files', '--others', '--exclude-standard']) || [];
    return [...new Set([...diff, ...untracked])];
  }
  // Default: the working set — staged + unstaged vs HEAD, plus untracked.
  const wt = git(['diff', '--name-only', 'HEAD']) || [];
  const untracked = git(['ls-files', '--others', '--exclude-standard']) || [];
  return [...new Set([...wt, ...untracked])];
}

// Returns { suites:Set, ignored:[], unmapped:[], hits:[{file, suites}] }.
function planFromDiff(files) {
  const suites = new Set();
  const ignored = [];
  const unmapped = [];
  const hits = [];
  for (const f of files) {
    if (!FORCE.some(re => re.test(f)) && IGNORE.some(re => re.test(f))) { ignored.push(f); continue; }
    let matched = false;
    const fileSuites = new Set();
    for (const [re, ss] of RULES) {
      if (re.test(f)) { matched = true; for (const s of ss) fileSuites.add(s); }
    }
    if (!matched) { unmapped.push(f); continue; }
    for (const s of fileSuites) suites.add(s);
    hits.push({ file: f, suites: [...fileSuites] });
  }
  return { suites, ignored, unmapped, hits };
}

// ---------- Execution ----------

function suiteArgs(suite, opts) {
  const s = SUITES[suite];
  const args = [];
  const sup = new Set(s.supports || []);
  if (opts.filter != null && sup.has('filter')) args.push(`--filter=${opts.filter}`);
  if (opts.jobs != null && sup.has('jobs')) args.push('-j', String(opts.jobs));
  if (opts.resume && sup.has('resume')) args.push('--resume');
  if (opts.failFast && sup.has('failFast')) args.push('--fail-fast');
  if (opts.repeat != null && sup.has('repeat')) args.push('--repeat', String(opts.repeat));
  if (opts.underLoad != null && sup.has('underLoad')) {
    args.push(opts.underLoad === '' ? '--under-load' : `--under-load=${opts.underLoad}`);
  }
  return args;
}

function runProcess(cmd, args, label) {
  process.stdout.write(`\n\x1b[1m━━━ ${label} ━━━\x1b[0m\n$ ${cmd} ${args.join(' ')}\n\n`);
  const t = Date.now();
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit' });
  const ms = Date.now() - t;
  return { ms, status: r.status, signal: r.signal, spawnError: r.error };
}

// suite-runner-backed suites checkpoint a summary.json we can surface.
const ARTIFACT_DIR = { kernel: 'test-kernel', blockfs: 'test-blockfs', sweep: 'test-browser' };

function suiteArtifact(suite) {
  const dir = ARTIFACT_DIR[suite];
  return dir ? path.join('build', dir, 'summary.json') : null;
}

// The suite's own record of what it selected (todos/0339). Only the three
// suite-runner-backed suites keep one; for the rest the absence of a count is
// deliberate — a missing number is honest, an invented one is not. The
// top-level `filter` below always records what THIS dispatcher forwarded.
function readSuiteSelection(artifactAbs) {
  try {
    const j = JSON.parse(fs.readFileSync(artifactAbs, 'utf-8'));
    if (!j || !j.files) return null;
    return { filter: j.filter == null ? null : j.filter, ...j.files };
  } catch { return null; }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) { printHelp(); process.exit(0); }
  if (opts.list) { printList(); process.exit(0); }

  // Resolve the suite set.
  let requested;
  let diffInfo = null;
  if (opts.diff) {
    const files = changedFiles(opts.diffRef);
    diffInfo = planFromDiff(files);
    requested = [...diffInfo.suites];
    printDiffPlan(opts.diffRef, files, diffInfo, requested);
  } else if (opts.suites.length) {
    requested = [...new Set(opts.suites)];
  } else {
    printHelp();
    process.exit(opts.dryRun ? 0 : 2);
  }

  // Order + dedup.
  const ordered = RUN_ORDER.filter(s => requested.includes(s))
    .concat(requested.filter(s => !RUN_ORDER.includes(s)));

  if (opts.dryRun) {
    process.stdout.write(`\nplan: ${ordered.length ? ordered.join(', ') : '(nothing)'}\n`);
    process.exit(0);
  }
  if (!ordered.length) {
    process.stdout.write('\nNo suites selected — nothing to run.\n');
    process.exit(0);
  }

  // Batch the run.py-backed suites into a single python invocation.
  const pyCats = ordered.filter(s => SUITES[s].pyTypes).map(s => SUITES[s].pyTypes);

  const results = []; // { suite(s), status, ms, exit, ... }
  const t0 = Date.now();

  // Interleave native suites and the single py batch in RUN_ORDER position.
  let pyBatchDone = false;
  for (const suite of ordered) {
    if (SUITES[suite].pyTypes) {
      if (pyBatchDone) continue;
      pyBatchDone = true;
      const args = ['tests/run.py', `--types=${pyCats.join(',')}`];
      if (opts.filter != null) args.push(`--filter=${opts.filter}`);
      const r = runProcess('python3', args, `run.py: ${pyCats.join(',')}`);
      results.push({ suite: `py[${pyCats.join(',')}]`, ...classify(r) });
      continue;
    }
    const args = [...SUITES[suite].cmd.slice(1), ...suiteArgs(suite, opts)];
    const r = runProcess(SUITES[suite].cmd[0], args, `${suite} suite`);
    const c = classify(r, SUITES[suite].optional);
    const art = suiteArtifact(suite);
    if (art && fs.existsSync(path.join(ROOT, art))) {
      c.artifact = art;
      const sel = readSuiteSelection(path.join(ROOT, art));
      if (sel) c.files = sel;
    }
    results.push({ suite, ...c });
  }

  writeMergedSummary(results, Date.now() - t0, opts, ordered);
  printFinal(results, Date.now() - t0);

  const anyFail = results.some(r => r.status === 'fail');
  process.exit(anyFail ? 1 : 0);
}

function classify(r, optional) {
  if (r.spawnError) {
    // Couldn't even launch the runner. Optional suites (browser sweep with
    // no Playwright) degrade to a skip; required ones are a hard failure.
    return { status: optional ? 'skip' : 'fail', ms: r.ms,
             note: `could not launch: ${r.spawnError.message}` };
  }
  return { status: r.status === 0 ? 'pass' : 'fail', ms: r.ms,
           exit: r.status, signal: r.signal || undefined };
}

// The run record. `filter` and `suites` are what this invocation SELECTED;
// each artifact-backed result carries the suite's own `files` block (todos/
// 0339). Without them a `sweep: pass` line is indistinguishable from a run of
// a single test file — which is exactly what a split sweep used to leave
// behind. A reader must be able to see `filter: null` + `files.recorded: 40`
// and know the whole suite was covered.
function writeMergedSummary(results, ms, opts, ordered) {
  const dir = path.join(ROOT, 'build', 'test-run');
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, 'summary.json.tmp');
    fs.writeFileSync(tmp, JSON.stringify({
      tool: 'tests/run.js', node: process.version, elapsedMs: ms,
      filter: opts.filter == null ? null : opts.filter,
      suites: ordered,
      results,
    }, null, 2));
    fs.renameSync(tmp, path.join(dir, 'summary.json'));
  } catch { /* best effort */ }
}

// ---------- Output ----------

function fmtSecs(ms) { return `${(ms / 1000).toFixed(1)}s`; }

function printDiffPlan(ref, files, info, suites) {
  process.stdout.write(`\n\x1b[1mdiff-aware plan\x1b[0m (${ref ? `vs ${ref}` : 'working set vs HEAD'})\n`);
  process.stdout.write(`  ${files.length} changed path(s), ${info.ignored.length} ignored (docs/todos/logs)\n`);
  for (const h of info.hits) process.stdout.write(`    ${h.file}  →  ${h.suites.join(', ')}\n`);
  if (info.unmapped.length) {
    process.stdout.write('\n  \x1b[33m⚠ unmapped (no rule — not covered by this plan):\x1b[0m\n');
    for (const f of info.unmapped) process.stdout.write(`    ${f}\n`);
    process.stdout.write('    → add a rule to RULES in tests/run.js, or run a suite by name.\n');
  }
  process.stdout.write(`\n  \x1b[1msuites:\x1b[0m ${suites.length ? suites.join(', ') : '(none)'}\n`);
}

// `[N/M files]` when a suite reports its selection, marked PARTIAL when the
// record does not account for the whole suite (todos/0339) — the one line that
// stops "sweep: pass" from meaning "some of the sweep passed".
function fmtCoverage(files) {
  if (!files || files.total == null) return '';
  const rec = files.recorded != null ? files.recorded : files.selected;
  const partial = rec < files.total;
  return `  ${partial ? '\x1b[33m' : ''}[${rec}/${files.total} files`
    + (files.carried ? `, ${files.carried} carried` : '')
    + (partial ? ' — PARTIAL' : '') + `]${partial ? '\x1b[0m' : ''}`;
}

function printFinal(results, ms) {
  process.stdout.write(`\n\x1b[1m━━━ tests/run.js summary ━━━\x1b[0m\n`);
  for (const r of results) {
    const tag = r.status === 'pass' ? '\x1b[32mok  \x1b[0m'
              : r.status === 'skip' ? '\x1b[33mskip\x1b[0m'
              : '\x1b[31mFAIL\x1b[0m';
    process.stdout.write(`  ${tag} ${r.suite.padEnd(28)} ${fmtSecs(r.ms)}` +
      fmtCoverage(r.files) +
      (r.note ? `  (${r.note})` : '') + (r.artifact ? `  → ${r.artifact}` : '') + '\n');
  }
  const pass = results.filter(r => r.status === 'pass').length;
  const fail = results.filter(r => r.status === 'fail').length;
  const skip = results.filter(r => r.status === 'skip').length;
  const parts = [`${pass} passed`, `${fail} failed`];
  if (skip) parts.push(`${skip} skipped`);
  process.stdout.write(`\n  ${parts.join(', ')}  (${fmtSecs(ms)})  → build/test-run/summary.json\n`);
}

function printList() {
  process.stdout.write('Suites:\n');
  for (const name of ALL_SUITES) {
    process.stdout.write(`  ${name.padEnd(22)} ${SUITES[name].desc}\n`);
  }
  process.stdout.write('\nDiff → suite rule table (union of every matching rule):\n');
  for (const [re, ss, why, label] of RULES) {
    process.stdout.write(`  ${(label || re.source).padEnd(40)} → ${ss.length ? ss.join(', ') : '(none)'}`
      + (why ? `   # ${why}` : '') + '\n');
  }
  process.stdout.write('\nIgnored (never trigger tests):\n  '
    + IGNORE.map(re => re.source).join('  ') + '\n');
  process.stdout.write('Never ignored (gated even though docs-shaped):\n  todos/  '
    + (CITED.ok ? CITED.files.join('  ') : '(register unparsable — every path)') + '\n');
}

function printHelp() {
  process.stdout.write(`Unified test entry point (todos/0084).

Usage:
  node tests/run.js all                 run the entire estate, one summary
  node tests/run.js <suite>...          run named suites
  node tests/run.js --diff [ref]        run the suites the diff needs
  node tests/run.js --diff --dry-run    print the plan only
  node tests/run.js --list              list suites + the rule table

Flags (forwarded to suites that accept them):
  --filter=STR   substring filter on test name
  -j N           worker count
  --resume       skip files that passed last run
  --fail-fast    stop on first failure
  --repeat N     run each file N times; per-file flake rate (kernel/blockfs/sweep)
  --under-load[=N]  run under CPU contention (flake gate, todos/0147)
  --dry-run      resolve + print the plan, run nothing

Suites: ${ALL_SUITES.join(', ')}, all
`);
}

main();
