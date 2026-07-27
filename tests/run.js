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
  // The offline baker: every kernel e2e image and every browser boot comes
  // out of it (directly, or through the prebaked fixture).
  [/^tools\/mkimage\.js$/, ['kernel', 'sweep'], 'bakes the system blob every e2e image and browser boot is built from'],

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
  // (NB: vendor/ has no blanket rule — every OTHER vendored project reports
  // UNMAPPED on a diff. That gap is todos/0318.)
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

  // Vendored projects → their run.py category + the projects build check.
  [/^vendor\/lua\//, ['lua', 'projects'], null],
  [/^vendor\/sqlite\//, ['sqlite', 'projects'], null],
  [/^vendor\/zlib\//, ['zlib', 'projects'], null],
  [/^vendor\/freetype\//, ['freetype', 'projects'], null],
  [/^vendor\/libpng\//, ['libpng', 'projects'], null],
  [/^vendor\/cairo\//, ['cairo', 'projects'], null],
  [/^vendor\/micropython\//, ['micropython', 'projects'], null],
  [/^vendor\/tcc\//, ['tcc', 'projects'], null],
  [/^vendor\/libc-test\//, ['libc'], null],
  [/^vendor\/disw\//, ['disw', 'projects'], null],
  [/^vendor\/libgit2\//, ['fakegit', 'projects'], null],
  // NetSurf constellation: bin.json (monkey smoke) is a projects build; the
  // gucOS frontend (gucos/) is seeded as /usr/bin/netsurf and exercised
  // in-window by the test_netsurf_*_e2e family (no browser leg, so no sweep —
  // the OS-side coverage is the kernel e2es).  The two monkey harnesses,
  // vendor/netsurf/smoke.mjs (JS off) and smoke-js.mjs (the JS gate), stay
  // manual recipes documented in vendor/netsurf/README.md: they each rebuild
  // the whole ~850-TU constellation, which the projects suite already covers.
  [/^vendor\/netsurf\//, ['projects', 'kernel'], 'the browser constellation + its in-window e2es'],
  // OS-seeded vendor apps (doom/quake/gameboy/sameboy/busybox/…) restale the
  // image and are exercised by the OS e2es + the browser sweep.
  [/^vendor\/(doom|quake|gameboy|sameboy|snake|busybox|tinyemu|micropython|magicpoint|sent)\//,
    ['projects', 'kernel', 'sweep'], 'seeded into the OS image'],
  // Any other vendor dir: at least a project build check.
  [/^vendor\//, ['projects'], 'a vendored project build'],
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
    if (art && fs.existsSync(path.join(ROOT, art))) c.artifact = art;
    results.push({ suite, ...c });
  }

  writeMergedSummary(results, Date.now() - t0);
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

function writeMergedSummary(results, ms) {
  const dir = path.join(ROOT, 'build', 'test-run');
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, 'summary.json.tmp');
    fs.writeFileSync(tmp, JSON.stringify({
      tool: 'tests/run.js', node: process.version, elapsedMs: ms,
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

function printFinal(results, ms) {
  process.stdout.write(`\n\x1b[1m━━━ tests/run.js summary ━━━\x1b[0m\n`);
  for (const r of results) {
    const tag = r.status === 'pass' ? '\x1b[32mok  \x1b[0m'
              : r.status === 'skip' ? '\x1b[33mskip\x1b[0m'
              : '\x1b[31mFAIL\x1b[0m';
    process.stdout.write(`  ${tag} ${r.suite.padEnd(28)} ${fmtSecs(r.ms)}` +
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
