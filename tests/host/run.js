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
  ['test_append_fstat_fail.js', []],     // O_APPEND fstat failure fails the open — no offset-0 "append" (0233/CD4)
  ['test_pipe_read_block.js', []],       // pipe read blocks on a live writer; EOF only at write-end close (0233/CD5)
  ['test_stream_bulk.js', []],           // stdin/pipe ByteQueue: MB-scale byte-exact passthrough (CD28)
  ['test_singlefile_emit.js', []],       // .js/.html emit cuts host.js at @cc-strip-below; missing sentinel fails loud (CD15)
  ['test_gpu_present_binding.js', []],   // per-window GPU present tail: canvasBySid + bind-at-GetWGPUSurface (A4)
  ['test_harness_leaks.js', []],         // the startup reaper's "never delete a LIVE run's fixture/server" contract
  ['test_tree_guard.js', []],            // the cross-tree preflight REFUSES a foreign-cwd launch (0341) — the positive control, run every time
  ['test_pp_spread_bounds.js', []],      // no unbounded call-argument spread survives in compiler.js (0320)
  ['test_suite_record.js', []],          // a split suite's summary records its scope + merges, never clobbers (0339)
  ['test_sleep_clamp.js', []],           // sleep primitives request EXACTLY the asked duration — no clock in the assertion (0361)
  ['test_bakeinput_sources.js', []],     // the 0082 closure covers out-of-dir sources/includes, not just `deps` (0354)
  ['test_diff_rules.js', []],            // compiler.js/host.js diff rules select the run.py corpus; exclusions pinned (0362)
  ['test_launcher_convention.js', []],   // package /bin/sh launchers are spawn-free: no command substitution, both plant sites probed (0444)
  ['test_source_packages.js', []],       // #407: mechanical <name>-sources synthesis — both derivations, mechanical exclusions, uniform defs, payload-root srclib ('.') validate/fold/build
  ['test_stdinc_fold.js', []],           // #439: baked /usr/include — the fold plants EXACTLY the compiler's merged header map byte-equal (hazard 1), collisions + missing-ext fail loud (hazard 2), coexists with every shipped srclib package
  ['test_netbridge_wrapper.js', []],     // #393: bridge answers are named, never "unreachable"; non-Latin-1 crosses the hop; dead bridge keeps ENETUNREACH
  ['test_browser_out_dirs.js', []],      // no tests/browser output path names a committed dir (logs/ etc.) — sweeps must leave a clean tree clean (#399/#183)
  ['test_manifest_refs.js', []],         // #434: image.json referential integrity — dangling launcher/link/seed refs fail the bake; red-then-green + the v223 sameboy replay
  ['../spawn/test_spawn_host.js', []],   // 0006 Layer A+B: the posix_spawn struct ABI + host-side marshalling (path/argv/envp/cwd/file_actions/flags/pgid) round-trips byte-for-byte through runModule with fake spawnHooks. Registered by #167/#431: tests/spawn/ was in no suite AND had no RULES row, so it reported UNMAPPED and ran nowhere
  ['../serve/test_first_run.js', []],    // `node serve.js .` prints a URL that 200s (COOP/COEP)
  ['../serve/test_clang_overlay.js', []],// `serve.js --clang` overlay on-ramp: fold-in vs sibling-absent (0141)
  ['../serve/test_native_base_purity.js', []], // CLANG-CPP-EPIC II guardrail (a), 0416-generalized: NO gated (-clang/-rust) name in the base set
  ['../serve/test_serve_with_clang.js', []],  // guardrail (b): serve-with-clang preflight → loud exit 1, never base fallback
  ['../serve/test_mkpkg_clang.js', []],       // guardrail (c): mkpkg --clang nativeApp sha256 round-trip
  ['../serve/test_mkpkg_rust.js', []],        // 0416: mkpkg --rust — purity + POSITIVE control in one run, sha256 refusal, absent-sibling exit 1, rust drift gate, unknown-gate validation
  ['../serve/test_mkpkg_isolation.js', []],   // guardrail (d): repo isolation (0388) — a differing build must not prune another repo's payloads; --pool shares the warm cache; one writer per out dir
  ['../serve/test_image_determinism.js', []], // two bakes of one tree are byte-identical (0249 content-hash stability)
];

// ---- suite-membership guard (#314's mechanism, applied here by #167/#431) ----
//
// The list above is HARDCODED and, unlike the kernel and blockfs suites, had
// no completeness check — so test_console_capability.js (0248/CD27, landed
// red→green at e2579556) sat on disk in NO list for weeks while every host
// gate reported green. `tests/host/` and `tests/serve/` are separate
// directories with separate rows, so they get one call each. BEFORE
// ensurePrebakedImage() deliberately, the tree-guard precedent: a launch we
// are about to refuse must not first write a 111 MB blob into the tree.
var HOST_MEMBER_RE = /^test_.*\.js$/;
assertMemberRegistry({
  dir: __dirname, pattern: HOST_MEMBER_RE, label: 'tests/host/run.js',
  entries: tests.filter(function (t) { return t[0].indexOf('/') < 0; })
                .map(function (t) { return { file: t[0] }; }),
  // Deliberate exclusions ONLY, each naming the live ticket that owns
  // registering it. Empty is the healthy state.
  exclude: [],
});
['serve', 'spawn'].forEach(function (sub) {
  assertMemberRegistry({
    dir: path.join(__dirname, '..', sub), pattern: HOST_MEMBER_RE, label: 'tests/host/run.js (../' + sub + ' rows)',
    entries: tests.filter(function (t) { return t[0].indexOf('../' + sub + '/') === 0; })
                  .map(function (t) { return { file: path.basename(t[0]) }; }),
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
