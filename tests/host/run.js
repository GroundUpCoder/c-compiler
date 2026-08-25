#!/usr/bin/env node
'use strict';
// Runs the host-level suite: host.js's Node output path and the aux
// entry points around it (serve.js first-run). Fast, Node-only.
//   node tests/host/run.js
var { spawnSync } = require('child_process');
var path = require('path');
var { ensurePrebakedImage } = require('../lib/image-fixture.js');
var { assertMemberRegistry } = require('../lib/suite-runner.js');

// Cross-tree preflight (todos/0341) — BEFORE ensurePrebakedImage(), which bakes
// a 111 MB blob into the SCRIPT's os/ directory. A cross-tree launch would
// rewrite another tree's image fixture, which is a write, not just a read.
require('../lib/tree-guard.js').assertSameTree(__dirname, { label: 'tests/host/run.js' });

var tests = [
  ['test_epipe_listeners.js', []],       // runModule must not stack stream 'error' listeners
  ['test_stdout_flush.js', []],          // exit drains piped stdout; queued chunks survive memory.grow
  ['test_console_ring.js', []],          // console SAB ring blocks (pty backpressure), never overruns
  ['test_console_capability.js', []],    // 0248/CD27: the console fast path is a POSITIVE capability (entry.console === true), so a decoy-less backend's fd 1/2 can never leak to the console — carries its own RED control (case 1). Registered by #167/#431: it landed red→green at e2579556 and then sat in NO list for weeks, the same orphan class as test_punes_e2e.js
  ['test_audio_ring_wrap.js', []],       // audio ring writePos stays masked; no RangeError at 2^31
  ['test_gcstr_imports.js', []],         // __gcstr binary shape: dedup, no data-segment copy, "#" Proxy polyfill
  ['test_blockfs_cli_clobber.js', []],   // --block-fs read error fails loud, never clobbers the image (0233/CD1)
  ['test_host_ceiling.js', []],          // #184: CLI wall-clock ceiling — runaway import-looper dies 124 with a named message; healthy/disabled runs untouched (the 0332 orphan class)
  ['test_append_fstat_fail.js', []],     // O_APPEND fstat failure fails the open — no offset-0 "append" (0233/CD4)
  ['test_pipe_read_block.js', []],       // pipe read blocks on a live writer; EOF only at write-end close (0233/CD5)
  ['test_stream_bulk.js', []],           // stdin/pipe ByteQueue: MB-scale byte-exact passthrough (CD28)
  ['test_singlefile_emit.js', []],       // .js/.html emit cuts host.js at @cc-strip-below; missing sentinel fails loud (CD15)
  ['test_cjs_datadir.js', []],           // #638: CJS bundle data dir is per-invocation (mkdtemp) and removed on exit — no leak, no pid-reuse contamination, concurrent same-bundle runs never collide
  ['test_gpu_present_binding.js', []],   // per-window GPU present tail: canvasBySid + bind-at-GetWGPUSurface (A4)
  ['test_gpu_present_clamp.js', []],     // #484: producer-side present backpressure — one ship per vsync tick, held-frame flush at pump/park
  ['test_harness_leaks.js', []],         // the startup reaper's "never delete a LIVE run's fixture/server" contract
  ['test_host_health.js', []],           // #725: the host-condition sampler — parsers on canned real output, the calibration trap (healthy raw numbers must NOT label suspect), suspectFromSamples fires on the OS pressure verdict and stays a LABEL (no verdict/directive fields — the never-a-pass property), the CC_HOST_HEALTH_FAKE seam (verbatim + fake:true; unreadable THROWS)
  ['test_tree_guard.js', []],            // the cross-tree preflight REFUSES a foreign-cwd launch (0341) — the positive control, run every time
  ['test_pp_spread_bounds.js', []],      // no unbounded call-argument spread survives in compiler.js (0320)
  ['test_source_date_epoch.js', []],     // #639: SOURCE_DATE_EPOCH — __DATE__/__TIME__ render the epoch in UTC (byte-identical across 25h-apart TZs), unset stays local wall clock, invalid values refuse loudly by the stated digits-and-cap rule (CLI + exported parser + cc-driver surfaces)
  ['test_link_hint.js', []],             // #632: __link_hint — prefix-scoped link-error advice; git2/common.h's hint names <git2_srclib.h> (leg 5 is the wiring red control)
  ['test_suite_record.js', []],          // a split suite's summary records its scope + merges, never clobbers (0339); --resume never skips a file edited since its pass (#455)
  ['test_artifact_freshness.js', []],    // #171: browser build artifacts are checked for FRESHNESS, not existence; the stale message names artifact + input, and quake-renders.mjs is wired to it
  ['test_sleep_clamp.js', []],           // sleep primitives request EXACTLY the asked duration — no clock in the assertion (0361)
  ['test_bakeinput_sources.js', []],     // the 0082 closure covers out-of-dir sources/includes, not just `deps` (0354); #614 adds the opts.defs sibling legs
  ['test_sibling_resolve.js', []],       // #614: resolveSiblingRepo — env override wins (and never falls through), a linked worktree resolves the MAIN clone's sibling via the gitdir pointer, naive fallback, null when absent
  ['test_sibling_tests.js', []],         // #613: sibling-owned test discovery — every malformed-manifest shape is a NAMED invalid (never a silent zero-member green), prefixed keys kill the same-basename collision in summary/log/resume/filter at once, evidence.extra makes a never-run sibling member an EVIDENCE failure, --resume freshness stats entry.src, a sibling red fails the suite
  ['test_diff_rules.js', []],            // compiler.js/host.js diff rules select the run.py corpus; exclusions pinned (0362)
  ['test_browser_preflight.js', []],     // #559: the browser install pre-flight refuses at gate start — worktree missing tests/browser/node_modules names the exact ln -s fix; healthy/ambient-pinned trees untouched; version hatch never excuses absence
  ['test_gate_history.js', []],          // #725: dispatcher evidence retention — runId + boundary/per-row host telemetry, per-suite transcript tee'd into history/<runId>/, a retry leaves the prior archive byte-identical, a LIVE .gate-lock refuses at exit 2 writing nothing (dead holder stolen), prune keeps HISTORY_KEEP dropping oldest, and hostSuspect labels a failing row WITHOUT touching status (never-a-pass)
  ['test_heavylock_gate.js', []],        // #561: tests/run.js reserves the heavy lock up front — a contended gate exits 3 BEFORE any suite (no summary write), --dry-run and light-only gates never contend, and the kernel runner JOINS the gate's reservation instead of contending against it; all under a private-TMPDIR lock scope
  ['test_python_resolve.js', []],        // #483: the pinned host-python resolver — $PYTHON override → .venv → main clone's .venv (worktree read-through), NEVER $PATH; drift/broken/dead-override refuse naming the fix; integration leg launches the resolved interpreter and matches it to the pin
  ['test_launcher_convention.js', []],   // package /bin/sh launchers are spawn-free: no command substitution, both plant sites probed (0444)
  ['test_source_packages.js', []],       // #407: mechanical <name>-sources synthesis — both derivations, mechanical exclusions, uniform defs, payload-root srclib ('.') validate/fold/build
  ['test_stdinc_fold.js', []],           // #439: baked /usr/include — the fold plants EXACTLY the compiler's merged header map byte-equal (hazard 1), collisions + missing-ext fail loud (hazard 2), coexists with every shipped srclib package
  ['test_netbridge_wrapper.js', []],     // #393: bridge answers are named, never "unreachable"; non-Latin-1 crosses the hop; dead bridge keeps ENETUNREACH
  ['test_browser_out_dirs.js', []],      // no tests/browser output path names a committed dir (logs/ etc.) — sweeps must leave a clean tree clean (#399/#183)
  ['test_manifest_refs.js', []],         // #434: image.json referential integrity — dangling launcher/link/seed refs fail the bake; red-then-green + the v223 sameboy replay
  ['test_gcode_orientation.js', []],     // #505: the baked gcode orientation (GCODE.md) is pinned to the platform — doc paths are manifest keys, the cc flag surface is checked behaviorally against createCcDriver, wmctl verbs/shape against wmctl.c usage, SDL loop-model claims against sdl-gucos.md; red controls on the extractors
  ['test_unknown_type_diag.js', []],     // #708: an unknown type name in a DECLARATION names the identifier ("unknown type name 'Zzz'") across the ticket's case table (file scope, static, const, pointer, function decl); the bare implicit-int shape and the expression path's "Undeclared identifier" keep their wording; positive control: a real typedef still compiles
  ['test_null_trap.js', []],             // #709: default-off byte identity; semantic null-use coverage/exemptions; generated noinline V8 frame; in-OS flag honesty
  ['test_sdl_api_index.js', []],       // #677: the generated SDL API index (os/doc/sdl-api-index.md) is byte-in-sync with the header surface (mksdlindex --check), baked + referenced from GCODE.md, and the notably-absent boundary is pinned behaviorally (absent names fail undeclared, #672's SDL_RenderTextureRotated compiles); red controls on comparator/matchers/absence gate
  ['test_sdl_deadstrip.js', []],       // #722: the zero-byte witness on DEFAULT flags — a no-audio SDL program carries no #529-A literal (the dead-literal prune: dropped code sheds its rodata), with positive controls (referenced/global-pinned/address-taken literals survive) and a run smoke
  ['test_sdl_loadwav_diff.js', []],    // #723: SDL_LoadWAV differential vs the pinned upstream SDL 3.4.0 oracle manifest — 92 fixtures byte-identical in spec/len/decoded sha256/exact error string; demand-link keyed on EXTERNAL-LINKAGE SYMBOL IDENTITY, proven by ADMISSION probes (missing-source oracle: statics/locals of the spelling never fire, extern refs and block-scope externs do, withdrawal spares static forward decls) plus every-mode zero-byte witnesses and variable/EInitList/address-taken routes; red controls on the comparator
  ['test_sdlttf_link.js', []],           // #468: the SDL_ttf veneer's link contract — a plain <SDL.h> program links in a freetype-less fs (pay-for-what-you-use), and a <SDL3_ttf/SDL_ttf.h> program there fails LOUD naming ft2build.h, never as an undeclared TTF_* (the header-really-declares positive control); render acceptance is tests/kernel/test_sdlttf_e2e.js
  ['test_default_packages.js', []],      // #419: defaultPackages — fold-time validation (unknown/duplicate/gated/non-array names refuse before a bake) + bakeSystemImage derivation (non-empty set -> /usr/share/gucman/defaults, empty set -> NO file) + the shipped manifest folds clean with its declared set
  ['test_skip_baseline.js', []],         // #582: the py skip baseline — RED controls both directions (new skip / stale entry), the netting trap, fuzz/live- exemption, and the committed file pinned set-equal to PY_CATEGORIES with attributions
  ['test_pool_exclusive.js', []],        // #579: the suite-runner pool's `exclusive` axis — same-key rows never overlap even on an unbounded budget, distinct/absent keys still run concurrently, a lone row heavier than the whole budget still runs (no deadlock), and the RED CONTROL that a big WEIGHT is not a serializer (7+7 both admitted at a 24 GiB host's 14.4 GB budget)
  ['test_png_helper.js', []],            // #657: tests/lib/png.js — the screenshot decode substrate: spec-filtered scanlines (types 0-4 applied forward, independent of the decoder), multi-shot stream walk, alpha preservation, and the POSITIVE CONTROLS (a one-pixel change is detected; truncation/palette/bad-filter throw loudly)
  ['../spawn/test_spawn_host.js', []],   // 0006 Layer A+B: the posix_spawn struct ABI + host-side marshalling (path/argv/envp/cwd/file_actions/flags/pgid) round-trips byte-for-byte through runModule with fake spawnHooks. Registered by #167/#431: tests/spawn/ was in no suite AND had no RULES row, so it reported UNMAPPED and ran nowhere
  ['../serve/test_first_run.js', []],    // `node serve.js .` prints a URL that 200s (COOP/COEP)
  ['../serve/test_clang_overlay.js', []],// `serve.js --clang` overlay on-ramp: fold-in vs sibling-absent (0141)
  ['../serve/test_native_base_purity.js', []], // CLANG-CPP-EPIC II guardrail (a), 0416-generalized: NO gated (-clang/-rust) name in the base set
  ['../serve/test_serve_with_clang.js', []],  // guardrail (b): serve-with-clang preflight → loud exit 1, never base fallback
  ['../serve/test_mkpkg_clang.js', []],       // guardrail (c): mkpkg --clang nativeApp sha256 round-trip
  ['../serve/test_mkpkg_rust.js', []],        // 0416: mkpkg --rust — purity + POSITIVE control in one run, sha256 refusal, absent-sibling exit 1, rust drift gate, unknown-gate validation
  ['../serve/test_mkpkg_isolation.js', []],   // guardrail (d): repo isolation (0388) — a differing build must not prune another repo's payloads; --pool shares the warm cache; one writer per out dir
  ['../serve/test_mkpkg_minbase.js', []],     // #518: declared minBase rides the index verbatim (0 included), undeclared defaults to the image version, garbage refuses; pure-data packages/ defs must declare an explicit floor
  ['../serve/test_mkpkg_version_guard.js', []], // #595: a version DOWNGRADE over a published entry refuses loudly naming both versions ("0.10" > "0.9" numerically, equal republish is routine); --allow-downgrade is the stated-rollback override
  ['../serve/test_mkpkg_baseline.js', []],    // #598: explicit baseline decision, served-floor refusal/provenance, and sourcesVersion history guard
  ['../serve/test_mkpkg_defs.js', []],        // #612: ordered --defs definition sources — a compiled sibling def (+ its -sources companion) builds/reuses from its OWNING root, cross-source duplicate names refuse naming both files (gated dups included), --defs preflight is loud, and foldPackages relocates sibling paths so ROOT-bound bake readers still compile them
  ['../serve/test_image_determinism.js', []], // two bakes of one tree are byte-identical (0249 content-hash stability)
  ['../serve/test_sibling_guard.js', []],     // #614: the dev origin's sibling guard — bad GUCOS_PACKAGES refuses, a served index missing a sibling package refuses naming the mkpkg --defs fix, --minimal demands the /packages half, the fat shape warns loudly, --no-extra-packages opts out, cross-source dups refuse at serve start
];

// ---- suite-membership guard (#314's mechanism, applied here by #167/#431) ----
//
// The list above is HARDCODED and, unlike the kernel and blockfs suites, had
// no completeness check — so test_console_capability.js (0248/CD27, landed
// red→green at e2579556) sat on disk in NO list for weeks while every host
// gate reported green. BEFORE ensurePrebakedImage() deliberately, the
// tree-guard precedent: a launch we are about to refuse must not first write a
// 111 MB blob into the tree.
//
// The rows span several directories, so each one needs its own set-equality
// call — and the set of directories is DERIVED FROM THE ROWS, never written
// down beside them. A hardcoded list (this guard shipped for one hour as
// `['serve', 'spawn']`, caught in review) is the very defect it exists to
// kill, moved up one level: `tests/` has 20+ sibling directories, so an
// ordinary future row like `../unit/test_x.js` would run happily while
// tests/unit went unguarded, and the next test_*.js added beside it would be
// orphaned again in silence. Deriving instead makes the guard's coverage track
// the thing it guards: a row in a new directory either starts guarding that
// directory automatically, or — if its shape cannot be classified — REFUSES
// the run naming the row. It can never silently do neither.
var HOST_MEMBER_RE = /^test_.*\.js$/;
var ROW_RE = /^(?:\.\.\/([A-Za-z0-9_.-]+)\/)?([A-Za-z0-9_.-]+)$/;   // "file.js" | "../dir/file.js"
var partitions = new Map();     // directory (relative to __dirname) -> [{ file }]
var unclassified = [];
tests.forEach(function (t) {
  var m = ROW_RE.exec(t[0]);
  if (!m) { unclassified.push(t[0]); return; }
  var dir = m[1] ? '../' + m[1] : '.';
  if (!partitions.has(dir)) partitions.set(dir, []);
  // Only test_*.js rows are members for set-equality purposes; a row naming
  // some other script is still CLASSIFIED (so its directory gets guarded),
  // it just is not one of the files the pattern is comparing.
  if (HOST_MEMBER_RE.test(m[2])) partitions.get(dir).push({ file: m[2] });
});
if (unclassified.length) {
  process.stderr.write('\x1b[31m[suite-registry] tests/host/run.js: row(s) belong to NO guarded partition, '
    + 'so the directory they live in would go unguarded and a test_*.js added beside them would execute NOWHERE:\x1b[0m\n');
  unclassified.forEach(function (r) { process.stderr.write('  ' + r + '\n'); });
  process.stderr.write('  Rows must be "test_x.js" (this directory) or "../<dir>/test_x.js" (one sibling).\n'
    + '  A deeper path needs this guard extended to reach it — do not just add the row.\n');
  process.exit(2);
}
partitions.forEach(function (entries, dir) {
  assertMemberRegistry({
    dir: path.resolve(__dirname, dir), pattern: HOST_MEMBER_RE,
    label: 'tests/host/run.js' + (dir === '.' ? '' : ' (' + dir + ' rows)'),
    entries: entries,
    // Deliberate exclusions ONLY, each naming the live ticket that owns
    // registering it. Empty is the healthy state.
    exclude: [],
  });
});

// serve.js re-bakes a stale os-system.img BEFORE listening (todos/0082), so
// test_first_run's 5s URL deadline needs the fixture fresh up front — the
// same prebake the kernel/browser runners do. Without this, the first host
// run after touching any bake input (host.js, compiler.js, os/) fails on
// the bake, not on anything serve.js did wrong.
ensurePrebakedImage();

var failures = 0;
for (var [file, args] of tests) {
  console.log('\n===== ' + file + (args.length ? ' ' + args.join(' ') : '') + ' =====');
  var r = spawnSync(process.execPath, [path.join(__dirname, file)].concat(args), { stdio: 'inherit' });
  if (r.status !== 0) failures++;
}
console.log('\n========================================');
console.log(failures ? failures + ' host test file(s) FAILED' : 'All host tests passed');
process.exit(failures ? 1 : 0);
