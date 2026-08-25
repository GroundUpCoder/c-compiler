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

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOST_HEALTH = require('./lib/host-health.js');
// Preloaded into every NODE suite runner (#725): a dispatcher SIGKILLed from
// outside leaves its current runner alive (it is in our process group only
// for terminal signals); the preload makes the runner notice the reparent
// and exit, which cascades — its own test files carry the same preload and
// group-kill their serve.js/Chromium. The py batch cannot be preloaded
// (python), so its net is the harness-leaks orphan reaper's run.py pattern.
const PARENT_WATCH = path.join(__dirname, 'lib', 'parent-watch.js');

// Cross-tree preflight (todos/0341) — FIRST, before --diff reads git or any
// suite is spawned. This dispatcher hands every sub-runner `cwd: ROOT`
// (runProcess below), i.e. it NORMALIZES the cwd away: launch the main-tree
// copy of this file from a worktree and each child then looks perfectly
// well-behaved from the inside. The check has to happen HERE, at the outermost
// launch, or the evidence is gone by the time a suite sees it.
require('./lib/tree-guard.js').assertSameTree(__dirname, { label: 'tests/run.js' });

// ---------- Suite registry ----------
//
// Each suite is one runner invocation. `supports` lists the passthrough
// flags the underlying runner accepts, so we never hand run.py a `-j` it
// doesn't understand. `pyTypes` marks a run.py category — those are BATCHED
// into a single `run.py --types=a,b,c` process (one python run, one section).
// The sweep hard-requires Playwright, but that dependency is enforced UP
// FRONT, not per-row: whenever `sweep` is in the selected set, the #559
// pre-flight (browserPreflight below) refuses a missing or drifted install at
// exit 2 before any suite runs, naming the exact fix. There is no
// optional/skip tier (#477 — the old `optional: true` skip only fired on
// spawnSync failing to launch `node` itself, which no missing Playwright
// ever causes).

const SUITES = {
  unit:    { desc: 'compiler unit corpus (in-process worker runner)',
             cmd: ['node', 'tests/run-unit.js'], supports: ['filter', 'jobs'] },
  blockfs: { desc: 'BlockFS/MountFS filesystem suite',
             cmd: ['node', 'tests/blockfs/run.js'], supports: ['filter', 'jobs', 'resume', 'failFast', 'repeat', 'underLoad'] },
  // `heavyLock: true` = the runner participates in the host heavy-test lock
  // (tests/lib/heavy-lock.js): the gate reserves the lock up front for these
  // (#561, main() below), and their exit-code space reserves 3 for the lock's
  // refusal, which classify() reports as "contended — did not run".
  kernel:  { desc: 'kernel control plane + OS e2e suite',
             cmd: ['node', 'tests/kernel/run.js'], supports: ['filter', 'jobs', 'resume', 'failFast', 'repeat', 'underLoad'],
             heavyLock: true },
  sweep:   { desc: 'browser OS acceptance sweep (real Chromium; needs Playwright)',
             cmd: ['node', 'tests/browser/os-sweep.mjs'], supports: ['filter', 'jobs', 'resume', 'failFast', 'repeat', 'underLoad'],
             heavyLock: true },
  host:    { desc: 'host.js Node output path + serve.js first-run (Node-only)',
             cmd: ['node', 'tests/host/run.js'], supports: [] },
  todos:   { desc: 'liability register validator + Lnn id-allocator tests (todos/done/0286)',
             cmd: ['node', 'tests/todos/run.js'], supports: ['filter'] },
  'netsurf-patch': { desc: 'vendor/netsurf patch-record invariant, offline half (todos/0423)',
             cmd: ['node', 'tests/netsurf/run.js'], supports: ['filter'] },
};

// run.py categories exposed as suites. `unit`/`blockfs` are DELIBERATELY not
// here — the dedicated runners above are faster and own those names.
const PY_CATEGORIES = [
  'ast', 'extra', 'ext', 'projects', 'zlib', 'lua', 'freetype', 'libpng',
  'libjpeg', 'cairo', 'micropython', 'micropython-upstream', 'sqlite', 'disw',
  'sourcemap', 'tcc', 'libc', 'fuzz', 'fakegit',
];
for (const cat of PY_CATEGORIES) {
  SUITES[cat] = { desc: `run.py --types=${cat}`, pyTypes: cat, supports: ['filter'] };
}

// Execution order: cheap-and-fast first, the image-baking kernel suite and
// the heavy browser sweep last. Any suite not listed here falls after.
const RUN_ORDER = ['todos', 'netsurf-patch', 'unit', 'host', 'blockfs', ...PY_CATEGORIES, 'kernel', 'sweep'];

// `all` = the entire estate.
const ALL_SUITES = ['todos', 'netsurf-patch', 'unit', 'host', 'blockfs', ...PY_CATEGORIES, 'kernel', 'sweep'];

// ---------- Tiers (#576 F1) ----------
//
// Three FORMAL, NAMED tiers over the same suite registry. The full gate's
// wall time is untouched — the tiers change what a lane WAITS ON, not what a
// ship requires:
//
//   node tests/run.js smoke      fast confidence check (~3-5 min)
//   node tests/run.js diff       what the current change needs (= --diff)
//   node tests/run.js full       everything, unfiltered — the SHIP gate
//
// The whole risk of a tiering system is a gate that LIES: a green that only
// means "we didn't run the thing that would have failed". Three mechanisms
// hold the line, all pinned by tests/host/test_diff_rules.js:
//   - `full` is set-equal to the ENTIRE suite registry, and refuses the
//     softening flags (--filter/--resume) outright — rule 5's ship gate in
//     one command that cannot be accidentally narrowed.
//   - smoke's per-suite filter tokens are guard-checked against the on-disk
//     tree with the SAME matcher the suite runner uses (matchesFilter), so a
//     renamed/deleted test cannot silently shrink the tier to a green no-op.
//   - every tier run RECORDS what it deliberately did not run (`tier` +
//     `omitted` in summary.json, and loudly on stdout) — a green smoke is
//     unmistakably not a full gate, to a human and to a judge.
//
// SMOKE composition (measured, 2026-08-08 — see logs/2026-08-08/576-batch15.md):
// the cheap native suites + blockfs + one real run.py category (disw, the
// cheapest — proves the pinned-python plumbing end to end) + a filtered
// kernel leg. The kernel filter picks the SAB-protocol core plus real-C e2es
// plus ONE fixture-boot e2e (test_strace_e2e, ~1s warm), so smoke really
// compiles C, really runs it, and really boots the OS — while avoiding the
// boot-heavy long poles (test_os_boot.js ~710s is the bake-path test;
// os-git-cli/os-clang are 200s+ sweep members). The browser sweep is
// deliberately OUT of smoke: its floor (Chromium + serve + bake) is minutes,
// headless boot covers the kernel/OS core, and browser-only edits pull
// `sweep` through the diff tier's #428 rules anyway. That is a recorded
// decision, pinned by the guard — not an oversight.
const SMOKE_KERNEL_FILTER = [
  'test_kernel.',    // process-table semantics over the real SAB protocol
  'test_tty',        // line discipline + a real-C e2e over the scripted bridge
  'test_pipes',      // pipe OFDs (protocol + SPSC ring) + real-C pipelines
  'test_fs_e2e',     // brokered fs RPCs with real C
  'test_wm.',        // WM surface registry / input routing / chrome (no wasm)
  'test_strace_e2e', // IMG: a REAL fixture boot — spawn, trace, exit status
].join(',');

const TIERS = {
  smoke: {
    desc: 'fast confidence check (~3-5 min): cheap suites + blockfs + disw + a filtered kernel leg incl. one real OS boot',
    suites: ['todos', 'netsurf-patch', 'unit', 'host', 'blockfs', 'disw', 'kernel'],
    filters: { kernel: SMOKE_KERNEL_FILTER },
  },
  diff: {
    desc: 'the suites the current change needs (the --diff selection; optional ref)',
    dynamic: true,
  },
  full: {
    desc: 'the entire estate, unfiltered — what gates a SHIP (refuses --filter/--resume)',
    suites: ALL_SUITES,
  },
};

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

// ---- baked docs-shaped image inputs (ticket #622) ----
//
// os/image.json can bake ANY repo file into the system blob via a `bin`
// entry, and gucman package definitions do the same via file-level `bin`
// and `tree` entries (the fat fixture folds every package in). Most such
// blobs are binary assets no IGNORE pattern touches — but a docs-shaped one
// (os/gcode/GCODE.md, os/doc/sdl-gucos.md, a LICENCE.md riding a tree
// payload) is swallowed by the `.md$`/README patterns before any rule is
// consulted, so a content-only edit re-bakes the blob and then gates ZERO
// suites (found live by lane-530511's dry-run — ticket #622). Derived from
// the manifest and the package definitions themselves, the CITED_RE shape:
// a newly-baked doc is covered by construction, with nobody remembering
// this block exists. The set is filtered to paths IGNORE would drop —
// non-docs baked paths already reach the rule table and keep whatever
// their own rules say.
//
// Failure directions, both deliberate: an UNPARSABLE os/image.json yields
// a match-everything pattern (the gate widens — and the kernel leg's bake
// names the parse error — rather than quietly opening; the CITED_RE rule).
// A malformed PACKAGE definition is skipped like newestBakeInput's scan:
// a definition that cannot parse cannot bake, fold, or install, so nothing
// it names can ship unobserved.
const OS_COMMON = require('../os/os-common.js');
function bakedIgnoredDocs() {
  const paths = new Set();
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'os/image.json'), 'utf-8'));
  } catch (e) { return { ok: false, error: e.message }; }
  for (const section of ['system', 'user']) {
    const files = (manifest[section] && manifest[section].files) || {};
    for (const k of Object.keys(files)) {
      if (files[k] && typeof files[k].bin === 'string') paths.add(files[k].bin);
    }
  }
  let pkgNames = [];
  try {
    pkgNames = fs.readdirSync(path.join(ROOT, 'packages')).filter(n => /\.json$/.test(n));
  } catch (e) { /* no packages/ dir — the image.json half stands alone */ }
  for (const n of pkgNames) {
    let pkg;
    try { pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'packages', n), 'utf-8')); }
    catch (e) { continue; }   // malformed → fails loud in the fold, not here
    const files = pkg.files || {};
    for (const k of Object.keys(files)) {
      const entry = files[k];
      if (!entry) continue;
      if (typeof entry.bin === 'string') paths.add(entry.bin);
      if (typeof entry.tree === 'string') {
        // The SAME enumeration that expands the payload (dotfiles and the
        // definition's exclude globs never ride), so the two agree by
        // construction — newestBakeInput's listTreeFiles rule.
        let tfs;
        try { tfs = OS_COMMON.listTreeFiles(fs, path, ROOT, entry, n + ': ' + k); }
        catch (e) { continue; }
        for (const tf of tfs) paths.add(entry.tree + '/' + tf);
      }
    }
  }
  return { ok: true, files: [...paths].filter(p => IGNORE.some(re => re.test(p))).sort() };
}
const BAKED_DOCS = bakedIgnoredDocs();
const BAKED_DOCS_RE = BAKED_DOCS.ok
  ? (BAKED_DOCS.files.length
      ? new RegExp('^(' + BAKED_DOCS.files.map(f => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')$')
      : /(?!)/)   // parse-ok + no docs-shaped baked inputs: a legitimate state, match nothing
  : /^/;

// IGNORE drops docs-shaped paths, but todos/, the register's cited files and
// the baked docs-shaped image inputs are gated: checked BEFORE it, so `.md$`
// and friends can't swallow them.
const FORCE = [/^todos\//, CITED_RE, BAKED_DOCS_RE];

// ---- os/'s RUNTIME-ONLY files (ticket #428) ----
//
// gucOS has TWO hosts over one kernel: the browser page (os.html + its
// workers + the WebGPU compositor) and the headless Node twin (os/boot.js).
// Almost everything under os/ is shared — seeded C sources, headers and the
// bake manifest, all of which become blob bytes and are therefore observable
// from BOTH suites. The six files below are the exception: each belongs to
// exactly ONE host, and none of them is a bake input, so the OTHER suite is
// structurally BLIND to an edit here — it neither loads the file nor boots an
// image whose bytes it can change. Naming the blind suite would not be extra
// coverage, it would be a 17-minute (kernel) or ~19-minute (sweep) run that
// cannot fail because of the diff.
//
// The "not a bake input" half is not an assertion made here: os-common.js's
// `BAKE_INPUT_SKIP` already declares os.html / boot.js / the two workers /
// the compositor runtime-only, and tests/host/test_bakeinput_sources.js pins
// that with an independent scan. osk.js joined that list in the same change
// (it is loaded by exactly one `<script src>` in os.html and appears nowhere
// in os/image.json or packages/*.json).
//
// 🔴 This list is the ONLY narrowing #428 makes. Everything else under os/ —
// every .c/.h, os/image.json, os/os-common.js, term/, win32/, ksvc/, gcode/,
// gucman/, sounds/, welcome.html — keeps BOTH suites, deliberately: those
// paths change blob bytes, and the browser sweep demonstrably asserts things
// the headless suite does not (2026-08-03: a Desktop-launcher change under
// os/image.json went kernel-green 151/151 and sweep-RED on os-paint.mjs). The
// pre-deploy full sweep in CLAUDE.md is the net under the rest.
const OS_BROWSER_ONLY = ['os.html', 'osk.js', 'compositor.js',
                         'kernel-worker.js', 'process-worker.js'];
const OS_HEADLESS_ONLY = ['boot.js'];
const OS_RUNTIME_ONLY = OS_BROWSER_ONLY.concat(OS_HEADLESS_ONLY);
// Rules UNION, so the shared-os/ rule cannot SUBTRACT these — it has to not
// match them in the first place. Built from the same array as the rules
// below so the two can never drift.
const OS_SHARED_RE = new RegExp(
  '^os\\/(?!(' + OS_RUNTIME_ONLY.map(f => f.replace(/\./g, '\\.')).join('|') + ')$)');
const OS_BROWSER_ONLY_RE = new RegExp(
  '^os\\/(' + OS_BROWSER_ONLY.filter(f => f !== 'os.html')
                             .map(f => f.replace(/\./g, '\\.')).join('|') + ')$');

// [regex, [suite, ...], why]. Order is irrelevant (union), but grouped by
// concern for readability.
const RULES = [
  // The liability register and its validator (the work queue itself moved to
  // the cc ticket tracker, 2026-07-30). Their only other trigger is the
  // per-clone-opt-in pre-commit hook, so without this rule they are
  // validators nobody invokes.
  [/^todos\//, ['todos'], 'the liability register and its validator'],
  [CITED_RE, ['todos'], 'cited by todos/LIABILITIES.md — an edit here can invalidate an entry',
    CITED.ok ? `LIABILITIES.md cites ${CITED.files.length} file(s)` : `LIABILITIES.md UNPARSABLE: ${CITED.error}`],

  // Core compiler — the whole language surface + every consumer of it.
  // (host: the single-file .js/.html emitters live in compiler.js — CD15;
  // blockfs: test_e2e.js compiles C.) EVERY run.py category is in the closure
  // (todos/0362): each one either compiles with compiler.js or runs its
  // output — verified per category, including disw (tests/disw/compiler/
  // build.py feeds it compiler output) and ast (two files execute under
  // host.js what compiler.js emitted). The firing example is todos/0356: a
  // promoteExprType miscompile caught ONLY by micropython-upstream, with
  // `unit` green — the old four-suite list would have reported that change
  // as covered. `sweep` is the bake-input radius: compiler.js recompiles
  // every seeded binary (newestBakeInput lists it first), and a rendering
  // break in the re-baked blob is invisible to the compositor-less headless
  // suites (the vendor-block axis-1 rule). Nothing is deliberately excluded
  // — `todos` joins via CITED_RE when the register cites compiler.js, and
  // gates nothing compiled. Guard: tests/host/test_diff_rules.js.
  [/^compiler\.js$/, ['unit', 'kernel', 'blockfs', 'host', 'sweep', ...PY_CATEGORIES],
    'the compiler drives every wasm binary — every run.py category, the OS suites, and the re-baked blob the sweep boots'],

  // host.js carries BOTH BlockFS/MountFS AND the per-process SDL/fd runtime —
  // and it is what run.py and run-unit.js execute every compiled wasm under
  // (run.py's HOST_JS, run-unit.js's runModule; todos/0362). Deliberately
  // excluded, the only two categories that never execute wasm: `disw` (a
  // clang-built native disassembler; its build.py inputs don't run) and
  // `sourcemap` (compiles, then verifies the map with its own verify.js).
  // Guard: tests/host/test_diff_rules.js pins both the inclusions and these
  // two exclusions.
  [/^host\.js$/,
    ['unit', 'blockfs', 'kernel', 'sweep', 'host',
     ...PY_CATEGORIES.filter(c => c !== 'disw' && c !== 'sourcemap')],
    'BlockFS + the process runtime live here; every run.py category but disw/sourcemap (neither executes wasm) runs under it'],

  // The owner-side kernel (process table, fds, WM/audio server).
  [/^kernel\.js$/, ['kernel', 'sweep'], 'the process control plane'],

  // The reference OS build: seeded C sources, headers, the image manifest —
  // everything under os/ EXCEPT the six per-host runtime files carved out
  // above (ticket #428). These paths become blob bytes, so both the headless
  // e2es and the real-browser sweep can observe an edit, and both are named.
  [OS_SHARED_RE, ['kernel', 'sweep'], 'seeded OS sources restale the image; e2e + browser cover it'],
  // ---- the per-host runtime files (ticket #428) ----
  // Browser-only page glue. os/boot.js is the headless host and loads none of
  // it; kernel.js's BOOT_SOURCE is process-worker.js's deliberate twin, and
  // `wmScreenshotScreen` is compositor.js's. No kernel-suite test opens any of
  // these files, and none is a bake input (os-common.js BAKE_INPUT_SKIP,
  // pinned by tests/host/test_bakeinput_sources.js), so the kernel suite
  // cannot observe an edit here at all.
  [OS_BROWSER_ONLY_RE, ['sweep'],
    'browser-only page glue — the headless host loads none of it and it is not a bake input'],
  // os.html is the same class, plus ONE cheap real observation: serve.js
  // advertises and serves /os/os.html, which tests/serve/test_first_run.js
  // (host suite) asserts returns 200 — so a rename/delete fails in seconds
  // instead of surviving to a browser boot.
  [/^os\/os\.html$/, ['sweep', 'host'],
    'the browser page shell — sweep drives it; the host suite pins the path serve.js serves'],
  // The headless Node host, the mirror image: no browser test loads boot.js
  // (the sweep boots os.html through serve.js, and every image it boots comes
  // from tools/mkimage.js via tests/lib/image-fixture.js — never from boot.js),
  // and it is runtime-only, so the sweep is blind to an edit here.
  [/^os\/boot\.js$/, ['kernel'],
    'the headless Node host — every kernel e2e drives it; no browser test loads it and it is not a bake input'],
  // The ksvc kernel service blob (todos/0275): /usr/lib/ksvc.wasm + its
  // loader feed BOTH composites' label text — explicit so a future ^os/
  // rule split can't orphan it (same suites as ^os/ today).
  [/^os\/ksvc(\/|\.js$)/, ['kernel', 'sweep'], 'the kernel text service — chrome text in both composites'],
  // The gcode CLI + its NATIVE oracle (#314): test_gcode_native.js in the
  // kernel suite runs os/gcode/test/smoke.mjs (clang + real libcurl) with a
  // check-count assertion. Same suites as ^os/ today — explicit so a future
  // ^os/ rule split can't orphan the oracle (the ksvc precedent above).
  [/^os\/gcode\//, ['kernel', 'sweep'], 'the gcode CLI — its native oracle rides the kernel suite (test_gcode_native.js)'],
  // The gucOS git CLI (#474). `^os/` already gives it the bake radius
  // (packages/git.json folds it into the fat fixture); the addition here is
  // `fakegit`, the run.py category that builds os/git/bin.json and diffs its
  // output against tests/fakegit/*/expected.txt. That category is also the
  // regression net for this bin.json's compiler flags, so an edit here that
  // silently changed codegen would show up there and nowhere else.
  [/^os\/git\//, ['fakegit', 'kernel', 'sweep'],
    'the gucOS git CLI — the fakegit category builds and diffs it; packages/git.json puts it in the fat fixture'],
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
  // purity + nativeApp guardrails (host) also read them (CLANG-CPP-EPIC II §7).
  [/^packages\//, ['kernel', 'sweep', 'host'], 'package definitions restale the fat fixture + the mkpkg pool + the base-purity guardrail'],
  // Baked docs-shaped inputs (ticket #622): repo files the image manifest or
  // a package definition bakes into blob/payload bytes, whose paths IGNORE
  // would otherwise drop (derivation + failure directions at the FORCE block
  // above). Blob bytes are observable from BOTH hosts, so both heavy suites
  // — the ^os/ shared rule's reasoning, and for os/-resident members the
  // union makes this a no-op on top of it; the entry is what prices a baked
  // doc OUTSIDE os/ (a tree-payload LICENCE.md under vendor/).
  [BAKED_DOCS_RE, ['kernel', 'sweep'],
    'docs-shaped bake inputs — blob/payload bytes both hosts boot; IGNORE-exempted via FORCE',
    BAKED_DOCS.ok ? `baked docs-shaped inputs (${BAKED_DOCS.files.length} file(s))`
                  : `os/image.json UNPARSABLE: ${BAKED_DOCS.error}`],
  [/^tools\/mkpkg\.js$/, ['kernel', 'host'], 'builds the gucman package pool test_gucman_e2e installs from; host holds the mkpkg --clang guardrail'],
  // The overlay-drift gate's exemption list (todos/0337): an edit here changes
  // which published clang apps mkpkg --clang accepts as unpackaged, which is
  // exactly what the host guardrail asserts.
  [/^tools\/clang-unpackaged\.json$/, ['host'], 'the mkpkg --clang overlay-drift exemption list the host guardrail exercises'],
  // The offline baker: every kernel e2e image and every browser boot comes
  // out of it (directly, or through the prebaked fixture).
  [/^tools\/mkimage\.js$/, ['kernel', 'sweep'], 'bakes the system blob every e2e image and browser boot is built from'],
  // The Tier 2.5 HTTP bridge (ticket #349): the localhost proxy the `net`
  // cfgstore setting reroutes kernel HTTP through. Its wire contract with
  // os-common's createNetFetch is private and version-locked, and
  // test_netbridge_e2e.js drives both halves end to end.
  [/^tools\/net-bridge\.js$/, ['kernel', 'host'], 'the Tier 2.5 HTTP bridge — test_netbridge_e2e.js drives the full reroute; the #393 mislabel legs (test_netbridge_wrapper.js) run the real bridge in the host suite'],

  // The host ticket bridge (ticket #451): the localhost server the in-OS
  // /usr/bin/file-gucos-ticket client POSTs to, which execs a `file-gucos-ticket`
  // command from the HOST's PATH. Its wire contract with os/file-gucos-ticket.c is
  // private and version-locked (the net-bridge x-guc-* encapsulation convention),
  // and test_ticketbridge_e2e.js drives both halves end to end against a fake
  // handler. `kernel` only: unlike net-bridge.js there is no host-suite test here —
  // net-bridge earns its `host` entry from test_netbridge_wrapper.js (the #393
  // mislabel legs), and this bridge's browser-facing surface is exercised Node-side
  // inside the kernel e2e itself rather than by a separate cheap-suite file.
  [/^tools\/ticket-bridge\.js$/, ['kernel'], 'the host ticket bridge — test_ticketbridge_e2e.js drives the in-OS client through it to a fake PATH handler in both net modes'],

  // The remote-egress wrapper (ticket #380): ssh -L to the SAME bridge running
  // on another host. Explicitly NOTHING, and the decision is the point. It
  // changes no wire contract -- it ships net-bridge.js verbatim and forwards a
  // port, so test_netbridge_e2e.js's coverage of the bridge is untouched by an
  // edit here. What it does own (ssh invocation, kill propagation) needs a
  // reachable sshd, which no suite in this estate has; a rule pointing at
  // `kernel` would run a gate that cannot observe this file at all. `--dry-run`
  // is the inspectable surface instead.
  [/^tools\/net-bridge-ssh\.js$/, [],
    'operator-side ssh wrapper -- ships net-bridge.js verbatim, changes no contract; needs a live sshd, so no suite covers it'],

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
  [/^tools\/mksdlindex\.js$/, ['host'],
    'generates os/doc/sdl-api-index.md (#677) — test_sdl_api_index.js runs its --check drift gate + red controls'],
  [/^tools\/mkgit2srclib\.js$/, ['fakegit', 'projects', 'kernel'],
    'generates vendor/libgit2\'s srclib forwarders + git2_srclib.h — the fakegit/projects build is what a missing forwarder breaks, and test_gucman_libgit2_e2e.js runs its --check'],
  [/^tools\/build-libc-ext\.js$/, ['ext', 'unit', 'libc'],
    'generates libc-ext.js — the ext category pins its optional-library contract (and runs its --check), the unit ext_* goldens and the libc-test search/fnmatch corpus consume it'],
  // The libc extension surface itself (#534). ext/ holds the vendored sources
  // (TRE regex, fnmatch/glob, the search.h family); libc-ext.js is their
  // GENERATED-AND-COMMITTED artifact, loaded by compiler.js when it sits next
  // to it — so an edit here reaches every C program including these headers.
  // Three consumers, each covering what the others cannot: the ext category
  // pins the optional-library contract and runs build-libc-ext.js --check
  // (without that sync check an ext/ edit that skips regeneration is invisible
  // to EVERY suite — the artifact, not the sources, is what compiles); the
  // unit ext_* goldens EXECUTE regex/fnmatch/glob; and the libc-test
  // functional corpus is the only suite that executes the search.h family
  // (search_tsearch/hsearch/lsearch/insque, plus its own fnmatch).
  [/^ext\//, ['ext', 'unit', 'libc'],
    'the libc extension sources — ext contract+sync check, unit ext_* goldens, libc-test search.h/fnmatch'],
  [/^libc-ext\.js$/, ['ext', 'unit', 'libc'],
    'the generated-and-committed extension artifact compiler.js loads — same consumers as ext/'],

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
  // The 0350 zip-library size-measurement harness — the bench2x2 shape: its
  // binaries compile with compiler.js and run under `node host.js` standalone
  // (fetch.sh pulls the candidate sources into gitignored build/zipmeasure).
  [/^tools\/zipmeasure\//, ['host'],
    'the 0350 zip-library measurement harness — its binaries run host.js standalone'],
  // The 0382/0325 libc presence probe. Unlike the harnesses above it never
  // RUNS anything — it compiles a TU per symbol against compiler.js's builtin
  // headers and reports absent/decl-only/present — so the seam under it is the
  // front end, which the unit suite pins with real goldens. It gates nothing
  // itself: its output is a report, not a committed artifact.
  [/^tools\/libcprobe\//, ['unit'],
    'the 0382/0325 libc presence probe — compiles against the builtin headers; unit is the seam'],

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
  // sweep is what proves that seam still boots and types. Its headless
  // sibling (#421) rides the os/boot.js + wmctl seam instead, which the
  // kernel e2es prove — pulling the sweep for it would gate on a suite that
  // cannot observe it (the net-bridge-ssh rule's reasoning).
  [/^tools\/os-drive\.mjs$/, ['sweep'], 'drives os.html via tests/browser/lib/os-harness.mjs'],
  [/^tools\/os-drive-headless\.mjs$/, ['kernel'],
    'drives live os/boot.js sessions — the kernel e2es prove the boot.js/wmctl seam it rides'],

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
  // The pinned host-python resolver (#483): every host-side Python spawn (the
  // py batch, mkmpgenhdr's qstr generator) resolves through it — never $PATH.
  // Its refusal paths are host-tested on fixture trees; `disw` is the cheapest
  // real run.py category (~1s, and per test_diff_rules.js one that doesn't
  // even execute wasm), so an edit here also proves an actual interpreter
  // still launches and runs run.py under the pin.
  [/^tools\/host-python\.js$/, ['host', 'disw'],
    'the host-python resolver (#483) — fixture-tested refusals (host) + a real interpreter launch (disw)'],
  [/^\.python-version$/, ['host', 'disw'],
    'the host-python version pin (#483) — the resolver refuses a .venv that drifts from it'],

  // Test trees map to their own suite.
  [/^tests\/unit\//, ['unit'], null],
  [/^tests\/run-unit\.js$/, ['unit'], null],
  [/^tests\/blockfs\//, ['blockfs'], null],
  [/^tests\/kernel\//, ['kernel'], null],
  // playwright-pin.cjs is the ONE implementation behind two gates: the sweep's
  // launch-time pin assert AND the dispatcher's gate-start pre-flight (#559),
  // whose decision logic is host-tested — so an edit here owes both suites.
  [/^tests\/browser\/lib\/playwright-pin\.cjs$/, ['sweep', 'host'],
    'the browser install pre-flight — launch assert (sweep) + gate-start check (host-tested, #559)'],
  [/^tests\/browser\//, ['sweep'], null],
  [/^tests\/host\//, ['host'], null],
  [/^tests\/todos\//, ['todos'], null],
  [/^tests\/netsurf\//, ['netsurf-patch'], null],
  [/^tests\/serve\//, ['host'], null],
  [/^tests\/spawn\//, ['host'], 'the posix_spawn ABI test drives host.js with fake spawnHooks — Node-only, so it rides the host suite (enrolled by #167/#431; it was UNMAPPED and in no suite)'],
  [/^tests\/run\.js$/, ['host'], 'the dispatcher itself — its RULES-closure guard (test_diff_rules.js) is a host test'],
  [/^tests\/bench\//, [], 'informational perf bench (todos/0186) — opt-in, ROM-gated, never a gating suite'],
  [/^tests\/flake\.js$/, [], 'the flake-gate orchestrator (todos/0147) — wraps other suites, no suite of its own'],
  [/^tests\/run\.py$/, PY_CATEGORIES.concat(['unit', 'blockfs']), 'the python runner backs every py category'],
  // #582: a baseline edit is a CLAIM about what the py leg skips — only
  // running the categories verifies it (host carries the shape guard,
  // test_skip_baseline.js).
  [/^tests\/py-skip-baseline\.json$/, PY_CATEGORIES.concat(['host']),
    'the committed skip baseline (#582) — adjudicated by running the py leg'],
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
  [/^vendor\/libjpeg\//, ['libjpeg', 'projects', 'kernel', 'sweep'],
    'the libjpeg package + the netsurf image path (WITH_JPEG)'],
  [/^vendor\/cairo\//, ['cairo', 'projects', 'kernel', 'sweep'],
    'the cairodemo package; os-cairo.mjs asserts its pixels'],
  [/^vendor\/micropython\//, ['micropython', 'projects'], null],
  [/^vendor\/tcc\//, ['tcc', 'projects'], null],
  [/^vendor\/libc-test\//, ['libc'], null],
  [/^vendor\/disw\//, ['disw', 'projects'], null],
  // libgit2 is a large-codebase compile stress test, and it entered the bake
  // closure TWICE, in two tickets, for two independent reasons — either one on
  // its own already justifies kernel+sweep, and both are recorded here so that
  // retiring one does not look like grounds to narrow the rule:
  //   #474 — os/git/bin.json compiles this tree and packages/git.json ships
  //          that BINARY, so an edit here changes a fat-fixture artifact.
  //   #473 — packages/libgit2.json ships the tree ITSELF as a srclib package,
  //          so an edit here changes the payload the in-OS `cc` links against
  //          (test_gucman_libgit2_e2e.js drives exactly that link).
  // In both cases newestBakeInput scans every packages/*.json, so an edit
  // restales the fat fixture exactly like a seeded source. (Before #474 the
  // rule stopped at its category + the build check because nothing seeded or
  // packaged it; that reasoning expired with the ship.)
  // Deliberately NOT `host`, even though a ^packages/ edit draws it — and the
  // reason is NOT that host cannot see this tree. It can: since #473 gave
  // packages/libgit2.json two `tree` entries, test_bakeinput_sources.js's
  // real-repo legs enumerate vendor/libgit2 through newestBakeInput /
  // newestPkgInput. The reason is that nothing a tree edit can do to that
  // guard's OUTCOME is unique to it. Measured, four probes, one at a time:
  //   edit a file's content      -> host green
  //   add a plain file           -> host green
  //   delete a file              -> host green
  //   add a SYMLINK to the tree  -> host RED
  // — because its assertions are about WHICH DIRECTORIES the scan enumerated
  // and which `files` entry kinds the DEFINITION uses, neither of which a
  // file's content or presence moves. The one class that does fire, the
  // symlink, is caught by two suites this rule already selects, through the
  // exact code paths they run: foldPackages('all') throws on it (every kernel
  // and sweep fixture bake is --packages=all) and so does tools/mkpkg.js
  // (tests/kernel/lib/gucman.js ensurePackages() shells out to it) — both
  // verified RED on the same planted symlink. So host here would buy cost and
  // no signal. packages/libgit2.json itself still draws host from ^packages/,
  // which is the right place for definition-shaped coverage.
  [/^vendor\/libgit2\//, ['fakegit', 'projects', 'kernel', 'sweep'],
    'the engine under os/git AND the payload of the libgit2 srclib package — its category, its build check, and the fat fixture both ship into'],
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
  // bin.json of its own and `projects` cannot build it. Since todos/0354 the
  // closure follows `sources` too, so axis 1 now derives this row on its own
  // (an edit here restales the fat fixture like any other seeded source);
  // `kernel` + `sweep` is that radius, not a hand-made exception.
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
  // `netsurf-patch` rides along (todos/0423): any edit under vendor/netsurf/
  // — a component tree, patches/, UPSTREAM.json — must keep the patch record
  // self-consistent (patchcheck.mjs's frame + manifest + differential), or
  // the next update.sh run silently destroys the unmirrored change.
  [/^vendor\/netsurf\//, ['projects', 'kernel', 'sweep', 'netsurf-patch'],
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
                resume: false, failFast: false, repeat: null, underLoad: null,
                out: null, tier: null };
  const setTier = (t) => {
    if (out.tier) { process.stderr.write(`one tier at a time: ${out.tier} and ${t} cannot combine\n`); process.exit(2); }
    out.tier = t;
  };
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
    else if (a.startsWith('--out=')) out.out = a.slice(6);
    else if (a === '--out') out.out = argv[++i];
    else if (a === '-j' || a === '--jobs') out.jobs = argv[++i];
    else if (a.startsWith('-j')) out.jobs = a.slice(2);
    else if (a === 'all') out.suites.push(...ALL_SUITES);
    // Tier tokens (#576 F1). `diff` takes an optional ref, exactly like --diff.
    else if (a === 'smoke' || a === 'full') setTier(a);
    else if (a === 'diff') {
      setTier('diff');
      if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) out.diffRef = argv[++i];
    }
    else if (a.startsWith('-')) { process.stderr.write(`unknown flag: ${a}\n`); process.exit(2); }
    else if (SUITES[a]) out.suites.push(a);
    else { process.stderr.write(`unknown suite: ${a}\n  (see: node tests/run.js --list)\n`); process.exit(2); }
  }
  // A tier is a complete statement of what runs — mixing it with named suites
  // (or with --diff) would make the recorded `tier` a lie about the selection.
  if (out.tier && out.suites.length) {
    process.stderr.write(`a tier (${out.tier}) and named suites cannot combine — run one or the other\n`);
    process.exit(2);
  }
  if (out.tier && out.tier !== 'diff' && out.diff) {
    process.stderr.write(`a tier (${out.tier}) and --diff cannot combine\n`);
    process.exit(2);
  }
  if (out.tier === 'diff') out.diff = true;
  else if (out.diff) out.tier = 'diff'; // --diff IS the diff tier; record it as such
  return out;
}

// ---------- Diff resolution ----------

// A git failure REFUSES the run (#725). Before this, any git error — a bad
// user ref, a broken/absent git — returned null with stderr DISCARDED,
// changedFiles coalesced that to "no changed files", and the --diff tier
// planned an empty run and exited 0: a silent green whose cause was thrown
// away. Exit 2 = refused before anything ran, nothing written — the
// preflight family shape (#559/#483).
function git(args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf-8' });
  if (r.error || r.status !== 0) {
    process.stderr.write(
      `[diff] git ${args.join(' ')} FAILED` +
      (r.error ? ` (${r.error.message})` : ` (exit ${r.status})`) + ':\n' +
      (r.stderr || '') +
      `  Cannot derive a diff plan — refusing rather than planning an empty (green) run.\n`);
    process.exit(2);
  }
  return r.stdout.split('\n').map(s => s.trim()).filter(Boolean);
}

function changedFiles(ref) {
  if (ref) {
    // Everything that differs from `ref` (committed or not), plus untracked.
    const diff = git(['diff', '--name-only', ref]);
    const untracked = git(['ls-files', '--others', '--exclude-standard']);
    return [...new Set([...diff, ...untracked])];
  }
  // Default: the working set — staged + unstaged vs HEAD, plus untracked.
  const wt = git(['diff', '--name-only', 'HEAD']);
  const untracked = git(['ls-files', '--others', '--exclude-standard']);
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

function suiteArgs(suite, opts, tierFilters) {
  const s = SUITES[suite];
  const args = [];
  const sup = new Set(s.supports || []);
  // A tier's per-suite filter (#576 F1). Mutually exclusive with a user
  // --filter by the refusal in main(), so there is never a merge question.
  const filter = opts.filter != null ? opts.filter
    : (tierFilters && tierFilters[suite] != null ? tierFilters[suite] : null);
  if (filter != null && sup.has('filter')) args.push(`--filter=${filter}`);
  if (opts.jobs != null && sup.has('jobs')) args.push('-j', String(opts.jobs));
  if (opts.resume && sup.has('resume')) args.push('--resume');
  if (opts.failFast && sup.has('failFast')) args.push('--fail-fast');
  if (opts.repeat != null && sup.has('repeat')) args.push('--repeat', String(opts.repeat));
  if (opts.underLoad != null && sup.has('underLoad')) {
    args.push(opts.underLoad === '' ? '--under-load' : `--under-load=${opts.underLoad}`);
  }
  return args;
}

// The one live suite child, so the dispatcher's signal handler (installed in
// main()) can pass a SIGTERM on before exiting — a gate interrupted from a
// non-terminal source must not leave its current runner orphaned mid-suite.
let currentChild = null;

// Async since #725: the child's stdout/stderr stream to OURS exactly as
// before AND tee into a per-suite log under the run's history dir, so a
// failing cheap suite (host has no per-file logs at all) leaves durable
// evidence instead of terminal scroll — the 2026-08-25 serve.js ship-gate
// red survived nowhere but the lane's transcript. `stdio: inherit` had to
// go for that; the visible interleaving is unchanged (chunks forward as
// they arrive). Resolves to the same {ms, status, signal, spawnError}
// shape classify() reads. teePath null (e.g. --dry-run never gets here,
// but a caller may opt out) = no tee, still async.
function runProcess(cmd, args, label, teePath) {
  process.stdout.write(`\n\x1b[1m━━━ ${label} ━━━\x1b[0m\n$ ${cmd} ${args.join(' ')}\n\n`);
  const t = Date.now();
  return new Promise((resolve) => {
    let tee = null;
    if (teePath) {
      try {
        fs.mkdirSync(path.dirname(teePath), { recursive: true });
        tee = fs.createWriteStream(teePath);
        tee.write(`$ ${cmd} ${args.join(' ')}\n`);
      } catch { tee = null; /* best-effort: evidence, not a gate condition */ }
    }
    let settled = false;
    const settle = (r) => {
      if (settled) return;
      settled = true;
      currentChild = null;
      const finish = () => resolve(r);
      if (tee) tee.end(finish); else finish();
    };
    // GROUP_LEADER cleared: suite runners are spawned in OUR group (not
    // detached), and an inherited '1' from an enclosing suite-runner test
    // file would aim the parent-watch preload's group kill at a group that
    // is not the runner's own.
    const child = spawn(cmd, args, { cwd: ROOT, stdio: ['inherit', 'pipe', 'pipe'],
      env: { ...process.env, CC_HARNESS_GROUP_LEADER: '0' } });
    currentChild = child;
    child.stdout.on('data', (d) => { process.stdout.write(d); if (tee) tee.write(d); });
    child.stderr.on('data', (d) => { process.stderr.write(d); if (tee) tee.write(d); });
    child.on('error', (e) => settle({ ms: Date.now() - t, status: null, signal: null, spawnError: e }));
    // 'close', not 'exit': close fires after the stdio streams have drained,
    // so the tee cannot lose the child's final chunks.
    child.on('close', (code, signal) =>
      settle({ ms: Date.now() - t, status: code, signal, spawnError: undefined }));
  });
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

// Pass/fail/skip counts derived from the suite's own per-file records (#582)
// — a count of what the artifact SAYS, never an invention: suites without an
// artifact get no tallies. (The suite-runner vocabulary today is pass/fail
// only; `skipped` stays 0 until a runner starts emitting 'skip' rows.)
function readSuiteTallies(artifactAbs) {
  try {
    const j = JSON.parse(fs.readFileSync(artifactAbs, 'utf-8'));
    if (!j || !Array.isArray(j.results)) return null;
    const t = { passed: 0, failed: 0, skipped: 0 };
    for (const r of j.results) {
      if (r.status === 'pass') t.passed++;
      else if (r.status === 'fail') t.failed++;
      else if (r.status === 'skip') t.skipped++;
      else t[`status:${r.status}`] = (t[`status:${r.status}`] || 0) + 1;
    }
    return t;
  } catch { return null; }
}

// ---------- The py skip baseline (#582) ----------
//
// The one outcome that looks identical to success is a SKIP: a test that
// stops running does not fail, it just leaves the tally — the v244 ship gate
// said "902 passed, 0 failed, 113 skipped" and nothing could say whether 113
// was normal. So the py leg's skips are pinned BY NAME in a committed
// baseline, and the gate goes RED (not a banner warning: gates are judged
// from summary.json's literal `status: "pass"` rows, so anything softer is
// invisible to the fleet) whenever the run's skip set differs from the
// baseline in EITHER direction:
//   - a skip the baseline doesn't list  → a test silently stopped running;
//   - a baseline entry that didn't skip → the gate retired (xpass-style: the
//     fixer claims the win) or the test vanished — either way the baseline
//     is stale and the same commit must update it.
// An intentional new gate is a one-line baseline update carrying its
// attribution (todos/NNNN). `exemptPrefixes` covers the one legitimately
// nondeterministic family (fuzz/live-<random seed>, present only where
// csmith is installed and dependent on the native leg's behavior).
// Enforcement only on UNFILTERED runs — a --filter run's skip set is a
// function of the filter, not of the tree.
const PY_ARTIFACT = path.join('build', 'test-py', 'summary.json');
const SKIP_BASELINE = path.join('tests', 'py-skip-baseline.json');

function checkSkipBaseline(pyRecord, baseline) {
  const violations = [];
  const exempt = (baseline && baseline.exemptPrefixes) || [];
  const isExempt = n => exempt.some(p => n.startsWith(p));
  const baseCats = (baseline && baseline.categories) || {};
  for (const [cat, rec] of Object.entries(pyRecord.categories || {})) {
    const base = baseCats[cat];
    if (!base) {
      violations.push({ category: cat, kind: 'unbaselined-category',
        detail: `category "${cat}" has no entry in ${SKIP_BASELINE} — add one (an empty {} pins "no skips")` });
      continue;
    }
    const actual = new Set();
    for (const s of rec.skips || []) {
      if (!s.name) {
        violations.push({ category: cat, kind: 'unnamed-skip',
          detail: 'a skip with no name cannot be baselined — name it at the results.skip() call site' });
        continue;
      }
      if (isExempt(s.name)) continue;
      actual.add(s.name);
    }
    for (const name of actual) {
      if (!(name in base)) {
        violations.push({ category: cat, kind: 'new-skip', name,
          detail: `"${name}" skipped but is not in the baseline — a test stopped running; if intentional, add it WITH its attribution` });
      }
    }
    for (const name of Object.keys(base)) {
      if (isExempt(name) || actual.has(name)) continue;
      violations.push({ category: cat, kind: 'stale-baseline', name,
        detail: `baseline lists "${name}" but it did not skip — it now runs (drop the entry) or no longer exists` });
    }
  }
  return violations;
}

// Read this run's py record (freshness-gated), attach tallies to the row, and
// enforce the baseline. Mutates `row` — on violations the row goes to
// status 'fail' with reason 'skip-baseline', which is what makes the gate
// exit nonzero and rule 5's literal-'pass' reading stay red.
function attachPyRecord(row, opts, tStart) {
  const artAbs = path.join(ROOT, PY_ARTIFACT);
  let rec = null;
  try {
    if (fs.statSync(artAbs).mtimeMs >= tStart) {
      rec = JSON.parse(fs.readFileSync(artAbs, 'utf-8'));
    }
  } catch { /* absent = not written by this run */ }

  if (rec) {
    row.artifact = PY_ARTIFACT;
    const cats = {};
    for (const [cat, c] of Object.entries(rec.categories || {})) {
      cats[cat] = { passed: c.passed, failed: c.failed, skipped: c.skipped };
    }
    row.tallies = { ...rec.totals, categories: cats };
  }

  if (opts.filter != null || (rec && rec.filter != null)) {
    row.skipBaseline = { checked: false, why: 'filtered run — the skip set is a function of the filter' };
    return;
  }
  if (!rec) {
    // An unfiltered py leg that left no fresh record cannot prove its skip
    // set. Usually the leg already failed (exit != 0 keeps the row red); the
    // explicit fail here closes the "exit 0 but no record" corner.
    row.status = 'fail';
    row.reason = 'skip-baseline';
    row.note = (row.note ? row.note + '; ' : '') +
      `no fresh ${PY_ARTIFACT} from this run — skip baseline unverifiable`;
    return;
  }
  let baseline = null;
  try {
    baseline = JSON.parse(fs.readFileSync(path.join(ROOT, SKIP_BASELINE), 'utf-8'));
  } catch (e) {
    row.status = 'fail';
    row.reason = 'skip-baseline';
    row.note = (row.note ? row.note + '; ' : '') +
      `${SKIP_BASELINE} missing/unreadable: ${e.message}`;
    return;
  }
  const violations = checkSkipBaseline(rec, baseline);
  row.skipBaseline = { checked: true, violations };
  if (violations.length) {
    row.status = 'fail';
    row.reason = 'skip-baseline';
    row.note = (row.note ? row.note + '; ' : '') +
      `SKIP BASELINE: ${violations.length} violation(s) vs ${SKIP_BASELINE}`;
    process.stdout.write(`\n\x1b[31m━━━ SKIP BASELINE VIOLATIONS (#582) ━━━\x1b[0m\n`);
    for (const v of violations) {
      process.stdout.write(`  \x1b[31m${v.kind}\x1b[0m [${v.category}] ${v.detail}\n`);
    }
    process.stdout.write(
      `  A skip that stops (or starts) happening must not pass silently.\n` +
      `  Intentional? Update ${SKIP_BASELINE} in the SAME commit, with the attribution.\n`);
  }
}

// ---------- Run identity + evidence retention (#725) ----------
//
// Every run gets a runId (timestamp + pid — sortable, collision-free on one
// host) and an append-only archive under <summaryDir>/history/<runId>/:
// the dispatcher summary, each suite's tee'd transcript, the child suite
// summaries, and the per-file logs of every non-pass row. The canonical
// paths keep their exact fleet-trained semantics (latest run, atomic rename,
// absent = did not finish) — history is what a RETRY can no longer destroy.
// The concrete incident: the 2026-08-25 pre-deploy sweep's failing kernel
// summary was merged over by the seven diagnostic reruns that followed, so
// the red's own record had to be reconstructed from terminal scroll.

function makeRunId() {
  const iso = new Date().toISOString();               // 2026-08-25T04:15:45.123Z
  return iso.slice(0, 19).replace(/[-:]/g, '').replace('T', '-') + '-' + process.pid;
}

// How many archived runs to keep per artifact dir. Non-pass logs only, so a
// healthy history is ~KBs per run; 20 comfortably covers a day of gates.
const HISTORY_KEEP = 20;

// One dispatcher per artifact dir at a time (#725, plan item 4). Two
// concurrent dispatchers writing ONE build/test-run interleave tee logs and
// race the summary rename — the launchd double-submit hazard from the ticket
// (a restarted job overwrote its first run's paths). Same pid-liveness +
// stale-steal shape as tests/lib/heavy-lock.js, scoped to the summary dir,
// so nested --out runs (guard tests) never contend with the canonical gate.
// Refusal = exit 2 with a [gate-lock] marker, nothing written — a second
// launcher must fail loudly, not truncate the first's evidence.
function acquireGateLock(summaryDir) {
  const { pidAlive } = require('./lib/heavy-lock.js');
  const lockPath = path.join(summaryDir, '.gate-lock');
  fs.mkdirSync(summaryDir, { recursive: true });
  // Atomic acquisition (#725 counter-pass). The first landing did
  // openSync('wx') + writeSync — the lock existed EMPTY for a moment, and a
  // contender arriving in that window parsed garbage, took the steal branch,
  // and unlinked a lock whose owner was alive and about to write (reviewer-
  // reproduced: both dispatchers then ran over one artifact dir). Now the
  // holder JSON is written to a PRIVATE tmp and link()ed into place: link
  // fails EEXIST atomically and the lock file can never be observed without
  // its content. The unparseable branch below then PROVES staleness by age
  // instead of assuming it.
  const GRACE_MS = 2000;
  const sleepMs = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* fallthrough */ } };
  const tmp = lockPath + '.tmp-' + process.pid;
  for (;;) {
    let linked = false;
    try {
      fs.writeFileSync(tmp, JSON.stringify({
        pid: process.pid, startedAt: new Date().toISOString(), argv: process.argv.slice(1),
      }));
      fs.linkSync(tmp, lockPath);
      linked = true;
    } catch (e) {
      if (e.code !== 'EEXIST') { try { fs.unlinkSync(tmp); } catch { /* gone */ } throw e; }
    }
    try { fs.unlinkSync(tmp); } catch { /* gone */ }
    if (linked) break;
    let h = null;
    try { h = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch { /* unparseable */ }
    if (h && h.pid !== process.pid && pidAlive(h.pid)) {
      process.stderr.write(
        `\n[gate-lock] REFUSING: another tests/run.js is already writing ${summaryDir}\n` +
        `  held by pid ${h.pid} since ${h.startedAt} (argv: ${(h.argv || []).join(' ')})\n` +
        `  Two dispatchers over one artifact dir interleave transcripts and race the\n` +
        `  summary rename — the retry would destroy the running gate's evidence (#725).\n` +
        `  Wait for it, or give this run its own dir with --out=DIR.\n\n`);
      process.exit(2);
    }
    if (h === null) {
      // Unparseable. Post-fix our own writers never produce this state, but
      // a pre-fix leftover or a foreign truncated write can. Mid-acquisition
      // and abandoned garbage are indistinguishable except by AGE — so wait
      // out a short grace and only steal what stays garbage past it, loudly.
      let ageMs = Infinity;
      try { ageMs = Date.now() - fs.statSync(lockPath).mtimeMs; } catch { continue; /* vanished — re-contend */ }
      if (ageMs < GRACE_MS) { sleepMs(150); continue; }
      process.stderr.write(`[gate-lock] unparseable lock file (age ${(ageMs / 1000).toFixed(1)}s > ` +
        `${GRACE_MS / 1000}s grace) — treating as abandoned, stealing\n`);
    }
    // Dead holder, our own stale pid, or aged-out garbage → steal and re-contend.
    try { fs.unlinkSync(lockPath); } catch { /* raced with another stealer */ }
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    let h = null;
    try { h = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch { /* gone */ }
    if (h && h.pid === process.pid) { try { fs.unlinkSync(lockPath); } catch { /* gone */ } }
  };
  process.on('exit', release);
  return release;
}

// Boundary host samples per row (#725): what lets a red be told from host
// exhaustion after the fact (~20ms per sample). 🔴 hostSuspect is an
// evidence LABEL on an already-failing row — it never touches status, never
// suppresses a row, never feeds a retry (jku condition 3 on #725; pinned by
// tests/host/test_gate_history.js and the suspectFromSamples legs).
function attachHostSamples(row, before) {
  const after = HOST_HEALTH.sample();
  row.host = { before, after };
  if (row.status === 'fail') {
    const sus = HOST_HEALTH.suspectFromSamples(before, after);
    if (sus) row.hostSuspect = sus;
  }
  return row;
}

// Copy this run's evidence into history/<runId>/ and prune to HISTORY_KEEP.
// Every step is best-effort by design: the archive is EXTRA evidence, and a
// copy failure must never turn a finished gate red — but it says so, because
// a silently absent archive would read as "nothing failed".
function archiveRun(summaryDir, runId, results, summaryObj) {
  const histRoot = path.join(summaryDir, 'history');
  const dir = path.join(histRoot, runId);
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (summaryObj) fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summaryObj, null, 2));
    for (const r of results) {
      if (!r.artifact) continue;
      const abs = path.join(ROOT, r.artifact);
      const name = path.basename(path.dirname(abs)) + '-summary.json'; // test-kernel-summary.json
      let child = null;
      try {
        fs.copyFileSync(abs, path.join(dir, name));
        child = JSON.parse(fs.readFileSync(abs, 'utf8'));
      } catch { continue; }
      // The red evidence itself: per-file logs of every non-pass row, the
      // artifacts a diagnostic rerun overwrites first. Green logs stay put
      // (superseded greens are already handled by the runner's .redN rule).
      for (const row of (child && child.results) || []) {
        if (!row || row.status === 'pass' || !row.log) continue;
        const src = path.resolve(ROOT, row.log);
        const dst = path.join(dir, 'logs', path.basename(path.dirname(abs)), path.basename(src));
        try {
          fs.mkdirSync(path.dirname(dst), { recursive: true });
          fs.copyFileSync(src, dst);
        } catch { /* log already gone — the summary copy still names it */ }
      }
    }
  } catch (e) {
    process.stderr.write(`[history] archive of ${runId} incomplete: ${e.message}\n`);
  }
  // Prune oldest beyond HISTORY_KEEP. runIds sort chronologically by
  // construction (timestamp prefix).
  try {
    const runs = fs.readdirSync(histRoot).filter(n => /^\d{8}-\d{6}-\d+$/.test(n)).sort();
    for (const old of runs.slice(0, Math.max(0, runs.length - HISTORY_KEEP))) {
      fs.rmSync(path.join(histRoot, old), { recursive: true, force: true });
    }
  } catch { /* no history dir */ }
  return dir;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) { printHelp(); process.exit(0); }
  if (opts.list) { printList(); process.exit(0); }

  // Tier flag discipline (#576 F1), before anything runs:
  //   - smoke's per-suite filters ARE its definition — a user --filter on top
  //     would silently redefine what "smoke green" means. Run suites by name
  //     with --filter for a hand-narrowed run.
  //   - `full` is rule 5's ship gate as one command: an unfiltered, no-carry
  //     run of the whole registry. --filter narrows it and --resume carries
  //     results in from an earlier tree — both are exactly what a ship gate
  //     must refuse (CLAUDE.md rule 5). `all` keeps the legacy permissive
  //     behavior for hand-driven work; `full` is the one that cannot soften.
  if (opts.tier === 'smoke' && opts.filter != null) {
    process.stderr.write(`smoke defines its own per-suite filters — --filter cannot combine with it.\n` +
                         `  (narrow by hand instead: node tests/run.js <suite> --filter=...)\n`);
    process.exit(2);
  }
  if (opts.tier === 'full' && (opts.filter != null || opts.resume)) {
    process.stderr.write(`full is the unfiltered no-carry ship tier (CLAUDE.md rule 5) — ` +
                         `${opts.filter != null ? '--filter' : '--resume'} cannot combine with it.\n` +
                         `  (use \`all\` for a hand-softened whole-estate run)\n`);
    process.exit(2);
  }

  // Resolve the suite set.
  let requested;
  let diffInfo = null;
  let tierFilters = null;
  if (opts.diff) {
    const files = changedFiles(opts.diffRef);
    diffInfo = planFromDiff(files);
    requested = [...diffInfo.suites];
    printDiffPlan(opts.diffRef, files, diffInfo, requested);
  } else if (opts.tier) {
    requested = [...TIERS[opts.tier].suites];
    tierFilters = TIERS[opts.tier].filters || null;
  } else if (opts.suites.length) {
    requested = [...new Set(opts.suites)];
  } else {
    printHelp();
    process.exit(opts.dryRun ? 0 : 2);
  }

  // Order + dedup.
  const ordered = RUN_ORDER.filter(s => requested.includes(s))
    .concat(requested.filter(s => !RUN_ORDER.includes(s)));

  // What a tier deliberately does NOT run — recorded in the summary and said
  // out loud. A green smoke must be unmistakably not a full gate.
  const omitted = opts.tier ? ALL_SUITES.filter(s => !ordered.includes(s)) : null;
  if (opts.tier) printTierBanner(opts.tier, ordered, tierFilters, omitted);

  if (opts.dryRun) {
    process.stdout.write(`\nplan: ${ordered.length ? ordered.join(', ') : '(nothing)'}\n`);
    process.exit(0);
  }
  if (!ordered.length) {
    process.stdout.write('\nNo suites selected — nothing to run.\n');
    process.exit(0);
  }

  // Browser-tier pre-flight (#559): when the sweep is in the selected set, a
  // knowable install fault — a worktree missing its gitignored
  // tests/browser/node_modules, so playwright resolves drifted or not at all —
  // must refuse NOW, not when the sweep row finally runs after every other
  // suite (lane-554 paid 33 minutes of green suites for a fault one file read
  // would have named). Exit 2 = refused before any suite ran; no summary is
  // written, and an absent build/test-run/summary.json already means "did not
  // finish". Deliberately NOT exit 3 (heavy-lock contention) or 4 (cross-tree
  // launch) — both codes carry trained meanings in this fleet.
  const pre = browserPreflight(ordered);
  if (!pre.ok) { process.stderr.write(pre.message); process.exit(2); }

  // Host-python pre-flight (#483): the py batch must never ride a $PATH
  // `python3` (system Python — the interpreter would be an ambient property
  // of whoever's shell launched the gate). Resolve the pinned interpreter
  // NOW, same exit-2 refusal shape as the browser pre-flight above; the
  // resolver (tools/host-python.js) names the exact fix.
  const pyPre = pythonPreflight(ordered);
  if (!pyPre.ok) { process.stderr.write(pyPre.message); process.exit(2); }

  // Run identity + the artifact-dir gate lock (#725). The summary dir is
  // resolved HERE, before anything runs, because the per-suite tee logs and
  // the lock live under it. #561b's --out isolation is preserved: a nested
  // dispatcher locks and archives its OWN dir, never the canonical one.
  // After the exit-2 preflights (a misconfigured run should not take even
  // this lock first), before the machine-wide heavy lock.
  const runId = makeRunId();
  const summaryDir = opts.out ? path.resolve(opts.out) : path.join(ROOT, 'build', 'test-run');
  acquireGateLock(summaryDir);
  // A dispatcher killed from a NON-terminal source (cc-meta, a service
  // manager) must pass the signal on to its live suite child — with the old
  // stdio-inherit spawnSync the child shared our foreground group and got
  // terminal signals for free; that still holds, this covers the kill -TERM
  // case. process.exit runs the lock releases registered above/below.
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      if (currentChild) { try { currentChild.kill('SIGTERM'); } catch { /* already gone */ } }
      process.exit(130);
    });
  }
  const hostStart = HOST_HEALTH.sample();

  // Heavy-lock reservation (#561). The heavy suites take the host heavy-test
  // lock — but only when THEIR row starts, and RUN_ORDER puts them last. That
  // left two windows in which another heavy job could seize the lock and cost
  // this gate its heavy legs at exit 3: gate start → the first heavy row
  // (deterministic and minutes long — every cheap suite plus the py batch runs
  // first), and the kernel row's exit → the sweep row's acquire (~60-110ms
  // measured: the lock is released at kernel exit and re-taken at sweep
  // startup, and a boot's --wait-lock poll ticks every 1s). A gate lost its
  // whole kernel leg to a sibling's bake exactly this way on 2026-08-04. So
  // the GATE takes the lock ONCE, up front, for the whole selected run; the
  // heavy runners join re-entrantly through the verified CC_HEAVY_LOCK_PID
  // marker (tests/lib/heavy-lock.js — the same contract their own child boots
  // already use). This also makes the fleet rule "a boot can wait behind a
  // gate; a gate never waits behind a boot" structural: a queued --wait-lock
  // boot now waits out the whole gate, not one suite. A contended start is
  // exit 3 naming the holder — nothing has run and no summary is written (an
  // absent summary already means "did not finish", never a green). After the
  // exit-2 preflights, deliberately: a misconfigured run must not take the
  // machine-wide lock first (the os-sweep.mjs ordering precedent).
  if (ordered.some(s => SUITES[s].heavyLock)) {
    require('./lib/heavy-lock.js').acquireHeavyLock({ name: 'tests/run.js gate' });
  }

  // Batch the run.py-backed suites into a single python invocation.
  const pyCats = ordered.filter(s => SUITES[s].pyTypes).map(s => SUITES[s].pyTypes);

  const results = []; // { suite(s), status, ms, exit, ... }
  const t0 = Date.now();

  // Per-suite tee target: the suite's full transcript, retained under this
  // run's history dir (#725). The cheap suites keep no per-file logs at all,
  // so before this a host-suite red's evidence lived only in terminal scroll.
  const teeFor = (name) => path.join(summaryDir, 'history', runId, 'logs', name + '.log');

  // Interleave native suites and the single py batch in RUN_ORDER position.
  let pyBatchDone = false;
  for (const suite of ordered) {
    if (SUITES[suite].pyTypes) {
      if (pyBatchDone) continue;
      pyBatchDone = true;
      const args = ['tests/run.py', `--types=${pyCats.join(',')}`];
      if (opts.filter != null) args.push(`--filter=${opts.filter}`);
      const tPy = Date.now();
      const hostBefore = HOST_HEALTH.sample();
      const r = await runProcess(pyPre.python, args, `run.py: ${pyCats.join(',')}`, teeFor('py'));
      const row = { suite: `py[${pyCats.join(',')}]`, ...classify(r) };
      // #582: attach run.py's own record (per-category tallies) and hold the
      // skip set against the committed baseline — on an unfiltered run a
      // skip-set diff is a FAIL, not a stdout footnote.
      attachPyRecord(row, opts, tPy);
      attachHostSamples(row, hostBefore);
      results.push(row);
      continue;
    }
    const cmd0 = SUITES[suite].cmd[0];
    const args = [
      // The runner is not detached (not a group leader) — clear an inherited
      // GROUP_LEADER before the preload reads it (runProcess passes env
      // through; a nested gate inside a suite-runner test file carries '1').
      ...(cmd0 === 'node' ? ['-r', PARENT_WATCH] : []),
      ...SUITES[suite].cmd.slice(1), ...suiteArgs(suite, opts, tierFilters)];
    const hostBefore = HOST_HEALTH.sample();
    const r = await runProcess(cmd0, args, `${suite} suite`, teeFor(suite));
    const c = classify(r, !!SUITES[suite].heavyLock);
    // A contended suite never ran, so any artifact on disk is an EARLIER
    // run's — attaching it would dress a did-not-run row in another run's
    // record (#561, the same honesty class as the reason field itself).
    const art = c.reason === 'heavy-lock-contended' ? null : suiteArtifact(suite);
    if (art && fs.existsSync(path.join(ROOT, art))) {
      c.artifact = art;
      const sel = readSuiteSelection(path.join(ROOT, art));
      if (sel) c.files = sel;
      const tal = readSuiteTallies(path.join(ROOT, art));
      if (tal) c.tallies = tal;
    }
    const row = { suite, ...c };
    attachHostSamples(row, hostBefore);
    results.push(row);
  }

  // #561b: `--out=DIR` redirects the run-level record (summaryDir was
  // resolved before the run — the tee logs and the gate lock live under it).
  // A NESTED dispatcher (a guard test driving refusal paths, a tool) must
  // not fabricate its parent's completion record: build/test-run/summary.json
  // existing with a fresh mtime and all-pass rows IS the fleet's "the gate
  // completed" signal, and a child writing it mid-gate would hand a
  // coordinator a green-looking artifact for a gate that later died (the
  // #477 fake-green class through a side door). The redirect is fail-safe by
  // construction: an --out run leaves the canonical path untouched, so a
  // judge reading it sees a stale mtime — "did not finish", never a green.
  // NB --out redirects only THIS dispatcher's record; the per-suite
  // artifacts (build/test-kernel etc.) are written by the suite runners
  // themselves and are not redirected — which is exactly why archiveRun
  // copies them (and their non-pass logs) into history/<runId>/ here:
  // a diagnostic rerun merges over the canonical child summary within
  // minutes of a red (measured live, 2026-08-25 pre-deploy sweep).
  const summaryObj = writeMergedSummary(results, Date.now() - t0, opts, ordered, summaryDir,
                     { tier: opts.tier, tierFilters, omitted },
                     { runId, host: { hostname: os.hostname(), start: hostStart, end: HOST_HEALTH.sample() } });
  archiveRun(summaryDir, runId, results, summaryObj);
  printFinal(results, Date.now() - t0, path.join(summaryDir, 'summary.json'),
             opts.tier, omitted);

  const anyFail = results.some(r => r.status === 'fail');
  process.exit(anyFail ? 1 : 0);
}

// The decision half of the #559 pre-flight, split out so the host suite can
// exercise it against fixture trees (tests/host/test_browser_preflight.js)
// the way test_diff_rules.js exercises planFromDiff — main() above owns only
// the print-and-exit. `browserDir` defaults to this tree's tests/browser.
function browserPreflight(ordered, browserDir) {
  if (!ordered.includes('sweep')) return { ok: true, skipped: true };
  return require('./browser/lib/playwright-pin.cjs')
    .checkBrowserPreflight(browserDir ? { browserDir } : {});
}

// The py-leg twin (#483), same split: decision here, print-and-exit in
// main(). Fires only when a run.py-backed suite is in the selected set; the
// resolution itself — $PYTHON override → this tree's .venv → the main
// clone's .venv → refusal, never $PATH — lives in tools/host-python.js and is
// host-tested on fixture trees (tests/host/test_python_resolve.js).
function pythonPreflight(ordered, opts) {
  if (!ordered.some(s => SUITES[s] && SUITES[s].pyTypes)) return { ok: true, skipped: true };
  return require('../tools/host-python.js').resolvePython(opts || {});
}

function classify(r, heavyLock) {
  if (r.spawnError) {
    // Couldn't even launch the runner — a hard failure on EVERY suite, the
    // sweep included (#477). The sweep's Playwright dependency never reaches
    // this branch: an absent/drifted install is refused at exit 2 by the
    // #559 pre-flight before any suite runs, and a launch failure inside a
    // successfully-spawned `node` is a nonzero exit, not a spawnError. A
    // `skip` here would let main()'s fail-only exit check report 0 with a
    // selected suite never having run.
    return { status: 'fail', ms: r.ms,
             note: `could not launch: ${r.spawnError.message}` };
  }
  // #561: a heavy runner's exit 3 is the heavy-lock refusal — the suite never
  // ran. The code alone is the signal here, no stderr marker needed: in both
  // heavy runners the ONLY process.exit(3) is tests/lib/heavy-lock.js's, and
  // the rest of their exit space is spoken for (0/1 the verdict, 2 refusal/
  // fatal, 4 cross-tree, 130 SIGINT; a member test exiting 3 is a FAILED
  // member → runner exit 1). Status stays literally 'fail' — main() must exit
  // nonzero and rule 5's literal-'pass' ship gate must stay red; a non-fail
  // status here would be the #477 fake green again. `reason` is what lets a
  // reader tell "contended, did not run" from "ran and failed". With the
  // gate-level reservation in main() this is a backstop (the runners join the
  // gate's own lock), but it is the honest reading whenever it fires.
  if (heavyLock && r.status === 3) {
    return { status: 'fail', reason: 'heavy-lock-contended', ms: r.ms, exit: r.status,
             note: 'DID NOT RUN — the host heavy-test lock was held (exit 3)' };
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
function writeMergedSummary(results, ms, opts, ordered, dir, tierInfo, identity) {
  let obj = null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, 'summary.json.tmp');
    obj = {
      tool: 'tests/run.js', node: process.version, elapsedMs: ms,
      // Run identity + boundary host telemetry (#725): what distinguishes
      // this record from a retry's, and a red from host exhaustion. The
      // per-row `host`/`hostSuspect` fields carry the row-level samples.
      runId: identity ? identity.runId : undefined,
      host: identity ? identity.host : undefined,
      filter: opts.filter == null ? null : opts.filter,
      // #576 F1: which formal tier this run was (null for hand-named suites)
      // and what it DELIBERATELY did not run. `tierFilters` records any
      // per-suite narrowing the tier applied — a judge must never have to
      // infer from the child artifacts that a kernel row was a smoke slice.
      // NB rule 5's ship-gate reading is unchanged and still sufficient:
      // a smoke/diff record has a partial `suites` list, and a tier-filtered
      // child artifact carries its own non-null `filter`.
      tier: tierInfo && tierInfo.tier ? tierInfo.tier : null,
      tierFilters: tierInfo && tierInfo.tierFilters ? tierInfo.tierFilters : undefined,
      omitted: tierInfo && tierInfo.omitted ? tierInfo.omitted : undefined,
      suites: ordered,
      results,
    };
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, path.join(dir, 'summary.json'));
  } catch { /* best effort */ }
  return obj;
}

// ---------- Output ----------

function fmtSecs(ms) { return `${(ms / 1000).toFixed(1)}s`; }

function printDiffPlan(ref, files, info, suites) {
  process.stdout.write(`\n\x1b[1mdiff-aware plan\x1b[0m (${ref ? `vs ${ref}` : 'working set vs HEAD'})\n`);
  process.stdout.write(`  ${files.length} changed path(s), ${info.ignored.length} ignored (docs/logs)\n`);
  for (const h of info.hits) process.stdout.write(`    ${h.file}  →  ${h.suites.join(', ')}\n`);
  if (info.unmapped.length) {
    process.stdout.write('\n  \x1b[33m⚠ unmapped (no rule — not covered by this plan):\x1b[0m\n');
    for (const f of info.unmapped) process.stdout.write(`    ${f}\n`);
    process.stdout.write('    → add a rule to RULES in tests/run.js, or run a suite by name.\n');
  }
  process.stdout.write(`\n  \x1b[1msuites:\x1b[0m ${suites.length ? suites.join(', ') : '(none)'}\n`);
}

// The tier banner (#576 F1): before anything runs, say which tier this is,
// what it runs (with any per-suite narrowing spelled out inline), and what it
// deliberately does NOT run. The whole failure mode of a tiering system is a
// green that quietly means "we didn't run the thing that would have failed" —
// so the omission is printed as prominently as the selection.
function printTierBanner(tier, ordered, tierFilters, omitted) {
  process.stdout.write(`\n\x1b[1m━━━ tier: ${tier} ━━━\x1b[0m\n`);
  const runs = ordered.map(s =>
    tierFilters && tierFilters[s] != null ? `${s} [--filter=${tierFilters[s]}]` : s);
  process.stdout.write(`  runs: ${runs.join(', ') || '(nothing)'}\n`);
  if (omitted && omitted.length) {
    process.stdout.write(`  \x1b[33mdeliberately NOT run: ${omitted.join(', ')}\x1b[0m\n` +
      `  a green ${tier} is NOT a full gate — ships require \`node tests/run.js full\`.\n`);
  } else {
    process.stdout.write(`  omits nothing — the whole registry (${ordered.length} suites), unfiltered.\n`);
  }
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

function printFinal(results, ms, summaryPath, tier, omitted) {
  process.stdout.write(`\n\x1b[1m━━━ tests/run.js summary ━━━\x1b[0m\n`);
  for (const r of results) {
    // A contended heavy suite is still a fail (the run exits nonzero) but its
    // tag says what happened: the suite DID NOT RUN — the reader must not have
    // to hand-decode exit 3 to tell that from a genuine red (#561).
    const tag = r.status === 'pass' ? '\x1b[32mok  \x1b[0m'
      : r.reason === 'heavy-lock-contended' ? '\x1b[31mLOCK\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
    // #582: a skip count on the verdict line, colored when nonzero — the one
    // number that used to vanish into unpreserved stdout.
    const tal = r.tallies;
    const talStr = tal && tal.passed != null
      ? `  [${tal.passed}P/${tal.failed}F` +
        (tal.skipped ? `/\x1b[33m${tal.skipped}S\x1b[0m` : '/0S') + ']'
      : '';
    process.stdout.write(`  ${tag} ${r.suite.padEnd(28)} ${fmtSecs(r.ms)}` +
      fmtCoverage(r.files) + talStr +
      (r.note ? `  (${r.note})` : '') + (r.artifact ? `  → ${r.artifact}` : '') + '\n');
  }
  const pass = results.filter(r => r.status === 'pass').length;
  const fail = results.filter(r => r.status === 'fail').length;
  const contended = results.filter(r => r.reason === 'heavy-lock-contended').length;
  const rel = path.relative(ROOT, summaryPath);
  process.stdout.write(`\n  ${pass} passed, ${fail} failed` +
    (contended ? ` (${contended} of those DID NOT RUN — heavy lock contended)` : '') +
    `  (${fmtSecs(ms)})  → ${rel && !rel.startsWith('..') ? rel : summaryPath}\n`);
  // The tier restated AT THE VERDICT, not just in the banner a screenful up:
  // the last line is what a human (or a transcript excerpt) actually reads.
  if (tier && omitted && omitted.length) {
    process.stdout.write(`  \x1b[33mtier: ${tier} — NOT a full gate` +
      ` (deliberately not run: ${omitted.length <= 4 ? omitted.join(', ')
        : omitted.slice(0, 3).join(', ') + ` + ${omitted.length - 3} more`})\x1b[0m\n`);
  } else if (tier === 'full') {
    process.stdout.write(`  tier: full — the whole registry, unfiltered\n`);
  }
}

function printList() {
  process.stdout.write('Tiers (#576 F1):\n');
  for (const [name, t] of Object.entries(TIERS)) {
    process.stdout.write(`  ${name.padEnd(22)} ${t.desc}\n`);
    if (t.suites) {
      const runs = t.suites.map(s =>
        t.filters && t.filters[s] != null ? `${s} [--filter=${t.filters[s]}]` : s);
      process.stdout.write(`  ${''.padEnd(22)}   runs: ${runs.join(', ')}\n`);
      const omitted = ALL_SUITES.filter(s => !t.suites.includes(s));
      if (omitted.length) process.stdout.write(`  ${''.padEnd(22)}   omits: ${omitted.join(', ')}\n`);
    }
  }
  process.stdout.write('\nSuites:\n');
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
  process.stdout.write('Baked docs-shaped inputs (#622 — blob bytes, gated kernel+sweep):\n  '
    + (BAKED_DOCS.ok
        ? (BAKED_DOCS.files.length ? BAKED_DOCS.files.join('  ') : '(none)')
        : '(os/image.json unparsable — every path)') + '\n');
}

function printHelp() {
  process.stdout.write(`Unified test entry point (todos/0084).

Usage:
  node tests/run.js smoke               fast confidence check (~3-5 min) — NOT a full gate
  node tests/run.js diff [ref]          run the suites the current change needs (= --diff)
  node tests/run.js full                the entire estate, unfiltered — the SHIP gate
                                        (refuses --filter/--resume; \`all\` is the permissive form)
  node tests/run.js all                 run the entire estate, one summary
  node tests/run.js <suite>...          run named suites
  node tests/run.js --diff [ref]        run the suites the diff needs
  node tests/run.js --diff --dry-run    print the plan only
  node tests/run.js --list              list tiers, suites + the rule table

Flags (forwarded to suites that accept them):
  --filter=STR   substring filter on test name
  -j N           worker count
  --resume       skip files that passed last run
  --fail-fast    stop on first failure
  --repeat N     run each file N times; per-file flake rate (kernel/blockfs/sweep)
  --under-load[=N]  run under CPU contention (flake gate, todos/0147)
  --dry-run      resolve + print the plan, run nothing
  --out=DIR      write the run-level summary.json to DIR instead of
                 build/test-run (#561b) — for NESTED invocations (guard tests,
                 tooling): a child dispatcher must never fabricate its parent
                 gate's completion record. Per-suite artifacts are unaffected.

Suites: ${ALL_SUITES.join(', ')}, all
`);
}

if (require.main === module) {
  // async since #725 (runProcess streams + tees instead of spawnSync). A
  // rejection here is a dispatcher defect, not a suite verdict — fail loud.
  main().catch((e) => { console.error(e); process.exit(1); });
} else {
  // Required as a module (tests/host/test_diff_rules.js): expose the rule
  // table + the planner so the RULES closure is testable without a git diff.
  module.exports = { SUITES, PY_CATEGORIES, RULES, IGNORE, FORCE, planFromDiff,
                     browserPreflight, pythonPreflight, classify,
                     OS_BROWSER_ONLY, OS_HEADLESS_ONLY, OS_RUNTIME_ONLY,
                     TIERS, ALL_SUITES, checkSkipBaseline, BAKED_DOCS,
                     attachHostSamples, makeRunId, HISTORY_KEEP };
}
