#!/usr/bin/env node
'use strict';
// Runs the host-level suite: host.js's Node output path and the aux
// entry points around it (serve.js first-run). Fast, Node-only.
//   node tests/host/run.js
var { spawnSync } = require('child_process');
var path = require('path');
var { ensurePrebakedImage } = require('../lib/image-fixture.js');

// Cross-tree preflight (todos/0341) — BEFORE ensurePrebakedImage(), which bakes
// a 111 MB blob into the SCRIPT's os/ directory. A cross-tree launch would
// rewrite another tree's image fixture, which is a write, not just a read.
require('../lib/tree-guard.js').assertSameTree(__dirname, { label: 'tests/host/run.js' });

// serve.js re-bakes a stale os-system.img BEFORE listening (todos/0082), so
// test_first_run's 5s URL deadline needs the fixture fresh up front — the
// same prebake the kernel/browser runners do. Without this, the first host
// run after touching any bake input (host.js, compiler.js, os/) fails on
// the bake, not on anything serve.js did wrong.
ensurePrebakedImage();

var tests = [
  ['test_epipe_listeners.js', []],       // runModule must not stack stream 'error' listeners
  ['test_stdout_flush.js', []],          // exit drains piped stdout; queued chunks survive memory.grow
  ['test_console_ring.js', []],          // console SAB ring blocks (pty backpressure), never overruns
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
  ['test_netbridge_wrapper.js', []],     // #393: bridge answers are named, never "unreachable"; non-Latin-1 crosses the hop; dead bridge keeps ENETUNREACH
  ['test_browser_out_dirs.js', []],      // no tests/browser output path names a committed dir (logs/ etc.) — sweeps must leave a clean tree clean (#399/#183)
  ['../serve/test_first_run.js', []],    // `node serve.js .` prints a URL that 200s (COOP/COEP)
  ['../serve/test_clang_overlay.js', []],// `serve.js --clang` overlay on-ramp: fold-in vs sibling-absent (0141)
  ['../serve/test_native_base_purity.js', []], // CLANG-CPP-EPIC II guardrail (a), 0416-generalized: NO gated (-clang/-rust) name in the base set
  ['../serve/test_serve_with_clang.js', []],  // guardrail (b): serve-with-clang preflight → loud exit 1, never base fallback
  ['../serve/test_mkpkg_clang.js', []],       // guardrail (c): mkpkg --clang nativeApp sha256 round-trip
  ['../serve/test_mkpkg_rust.js', []],        // 0416: mkpkg --rust — purity + POSITIVE control in one run, sha256 refusal, absent-sibling exit 1, rust drift gate, unknown-gate validation
  ['../serve/test_mkpkg_isolation.js', []],   // guardrail (d): repo isolation (0388) — a differing build must not prune another repo's payloads; --pool shares the warm cache; one writer per out dir
  ['../serve/test_image_determinism.js', []], // two bakes of one tree are byte-identical (0249 content-hash stability)
];

var failures = 0;
for (var [file, args] of tests) {
  console.log('\n===== ' + file + (args.length ? ' ' + args.join(' ') : '') + ' =====');
  var r = spawnSync(process.execPath, [path.join(__dirname, file)].concat(args), { stdio: 'inherit' });
  if (r.status !== 0) failures++;
}
console.log('\n========================================');
console.log(failures ? failures + ' host test file(s) FAILED' : 'All host tests passed');
process.exit(failures ? 1 : 0);
