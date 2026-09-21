# #797 — Optional native SDL3/WebGPU for standalone Node

User requested reuse of sibling c-compiler-simplified's native backend, then
explicitly scoped gucOS out and asked for graceful absence when distributing
only compiler.js + host.js. Implementation authorized in this thread on
2026-09-21. Base tree: 450c1c1c; sibling source: 08cfe69.

Gamedev justification: compile and run the existing C/SDL game API directly on
Node without npm installation, while preserving the browser development path.
This is a user-requested standalone backend, not a gucOS GPU migration.

## Implementation

- Ported plain C Node-API addon, pinned dependency builder and JS adapters from
  the sibling. SDL3 and wgpu-native use typed handles, not exposed pointers.
- Preserved injected/browser/kernel backend precedence. Standalone Node lazily
  probes only for SDL/clipboard/GPU imports. `auto` tolerates absence and reports
  present-but-unloadable binaries; `native` requires the addon when used; `null`
  explicitly requests the legacy headless simulation.
- Absent auto backend retains local helpers/timers but refuses video/audio/pad
  initialization and device creation. GPU adapter requests report unavailable.
  Existing local clipboard storage remains available without the addon.
- The C veneer previously ignored __sdl_init's result. It now handles failure,
  preserves SDL_WasInit state on failure and forwards subsequent init/quit
  subsystem calls to native SDL; non-native backends preserve C-side tracking.
- Runtime owns native resource cleanup across return, trap and setup failure,
  with GPU teardown before SDL. GPU callbacks join the existing frame loop.
- Generated JS embeds the native adapter and backend selection; the old unused
  @kmamal/sdl loader callback is removed.
- Tests that intentionally simulate SDL explicitly select null. New optional
  tests prevent missing libraries from masquerading as devices and forbid npm
  resolution. Native integration is enrolled in the host suite; the runner
  explicitly reports unavailable optional test tiers. Direct native test scripts
  require their backend and fail if it is missing.

## Evidence executed locally

- `node native/build.js`: compiled this repo's addon against the sibling's
  cached SDL/wgpu installations copied into this tree's ignored build/native.
  Download-from-empty-cache behavior was inspected, not exercised.
- `node tests/native/sdl.js`: passed 55 SDL/clipboard import inventory and real
  dummy-driver tests, including pixel results, audio consumption, event pumping,
  cleanup, compiled C/generated JS, and copied native libraries outside both repos.
- `node tests/native/webgpu.js`: passed 48 imports/228 enum translations, actual
  GPU compute/render/readback, mapped writes after memory growth, error scopes,
  repeated execution and cleanup, and compiled/generated JS execution.
- `node tests/host/test_native_optional.js`: passed relocated compiler/host,
  console execution, SDL failure/error state, GPU-unavailable callback, explicit
  native/null selection and broken-addon degradation, with npm imports forbidden.
- SDL-only build (`--no-webgpu`) passed the SDL suite and reported GPU adapter
  unavailable for the compute fixture. Restored the combined build afterward.
- SDL-filtered unit run: 23 passed, 0 failed.
- Required diff gate: passed on the fifth invocation with the documented Node
  runtime workaround; full scope and result below.

## Boundaries

No physical gamepad or visible-window presentation claim. macOS arm64 exercised;
other inherited build targets untested here, Windows build unsupported. Node,
OS libraries and drivers remain runtime requirements. Third-party binaries stay
ignored; retain their licenses/notices when distributing them. Sibling quad
batching and additional C API extensions were not imported. No external agent
threads or internal sub-agents performed this work.

## Gate sequencing correction

The first diff gate passed unit/native tests but was stopped (exit 130) after
`test_first_run.js` timed out: `os/os-system.img v299 but input-stale (host.js is
newer) — baking…`. I had fixed the unavailable backend's timer baseline after
the image bake began; its start-time freshness stamp correctly made the image
stale. This was my gate sequencing error, not a native backend failure. The
focused absence test now verifies the first SDL_GetTicks read includes time
since SDL_Init(0). Source was frozen before restarting the full diff gate.

The timeout also exposed a separate existing test cleanup defect: the failed
test left serve.js reparented to PID 1 with its image-baker child still running.
I verified their commands and terminated exactly those owned processes, then
verified the gate lock was released before restarting. The separate cleanup
bug was filed as #798; no unrelated test-harness fix is included in #797.

Additional focused validation: `node tests/native/webgpu.js --surfaces` passed
on macOS arm64, including actual native window surface creation, resize,
exclusive presentation-path ownership and window-owned GPU cleanup. This does
not certify visible frame presentation or physical input devices. The clean
gate rerun passed the server startup test that timed out in the first run.

## CLI delimiter regression caught by the corpus

The second gate passed liabilities, unit (850 pass/3 skip), host (including
native integration), and BlockFS (15/15), but the C corpus reported 902 pass,
1 fail, 111 skip. `fakegit/w_checkout_restore` failed on `checkout -- k.txt`:
my new host option parser had removed the application's `--` delimiter.
I stopped the gate during its partial kernel leg; this was not a green gate.

Added an argv regression to test_native_optional.js: the program demands
`checkout`, `--`, `k.txt` exactly. It failed before the fix (expected exit 0,
actual 1). The host now stops option parsing at `--` while preserving that
argument for the application. The expanded optional test passed, and the
isolated real fakegit case passed (1/1). A third unfiltered diff gate follows
on the frozen source. No native addon source change was needed.

## Third gate: Node shutdown stall

The third gate passed units and native/optional tests but stalled in the unchanged
host member test_pp_spread_bounds.js after it printed every successful assertion
and `All checks passed`. PID 69188 remained alive more than five minutes at 0%
CPU. A macOS one-second `sample` recorded 780 main-thread samples in
`Environment::Exit -> DisposePlatform -> WorkerThreadsTaskRunner::Shutdown ->
uv_thread_join -> __ulock_wait`, with the V8 worker waiting in
`ConcurrentBaselineCompiler -> allocation retry -> CollectionBarrier::
AwaitCollectionBackground -> __psynch_cvwait`. This suggests a runtime shutdown
deadlock; root cause/reproducibility remain unverified. The member never loads
the native addon and had terminated normally in both earlier gates.

I interrupted the dispatcher and terminated that exact stuck child; this run
also is not a pass. Filed the separate stability investigation as #799. A fourth
unmodified-source diff gate is running with the same Node 25.8.2 runtime and no
special V8 flags. No test assertions or gate scope were weakened.

The fourth gate stalled at the same member again. Its sample showed the same
main-thread Shutdown/uv_thread_join and background ConcurrentBaselineCompiler/
CollectionBarrier waits. Interrupted it (exit 130) and terminated its owned
child. The isolated member then exited 0 both with `node
--no-concurrent-sparkplug` and with the equivalent launch preload below.

Fifth gate command (same unfiltered diff selection):

```sh
# /tmp/cc-native-serial-baseline.cjs contains:
# require('node:v8').setFlagsFromString('--no-concurrent-sparkplug');
NODE_OPTIONS="--require=/tmp/cc-native-serial-baseline.cjs" node tests/run.js --diff
```

This disables V8 concurrent baseline compilation for Node processes inheriting
NODE_OPTIONS. It changes the test runtime configuration, not assertions or suite
scope. The runtime workaround is part of this validation's stated limits; no
such flag is added to the product or committed test harness.

Later source inspection found the existing #549 note/guard at
`tests/blockfs/run.js:54-73`: BlockFS members use natural exit to avoid this
same shutdown pattern. Linked that evidence to #799, whose host member still
calls process.exit(). The fifth gate is progressing past the affected member.


## Completed validation (2026-09-22 local)

Fifth gate exited 0. Authoritative `build/test-run/summary.json` has runId
`20260921-141628-72958`, Node 25.8.2, `tier: "diff"`, `filter: null`, elapsed
3995376 ms, and all seven execution rows literally `status: "pass"`:
liabilities, unit, host, BlockFS, the batched Python corpus, kernel, and sweep.
The dispatcher selected 24 named suites. It deliberately omitted netsurf-patch;
this is a targeted merge gate, not a full ship gate or deployment.

- Unit: 850 passed, 0 failed, 3 skipped.
- Host: passed, including optional/broken/missing-addon tests and both built
  native integration tiers (SDL and WebGPU).
- BlockFS: 15 passed, 0 failed.
- C/Python corpus: 903 passed, 0 failed, 111 skipped.
- Kernel: 206 current members freshly executed and passed; `done: true`,
  `filter: null`, `selected: 206`, `executed: 206`, `resumed: 0`. Log evidence
  confirms all 206 current members post-date this run's start.
- Browser: 72 current members freshly executed and passed; `done: true`,
  `filter: null`, `selected: 72`, `executed: 72`, `resumed: 0`. Log evidence
  confirms all 72 current members post-date this run's start.

The persistent kernel/browser manifests each retain ONE historical, nonmember
pass: `test_small_e2e.js` and `os-small.mjs`, respectively. Thus their recorded
counts are 207/206 and 73/72, with `carried: 1`; these extra rows are NOT credited
to this invocation. No current member was resumed or satisfied by carried
results. I did not erase historical evidence to make the manifest counts look
cleaner. The stricter exact-count pre-deploy condition is not being claimed.

The Node concurrent-baseline-compilation workaround above applies to this gate.
Native SDL, WebGPU, window-surface lifecycle, SDL-only, relocation, and absence
checks had also passed separately on ordinary Node without that workaround.
Separate test-harness findings remain tracked under #798 and #799. No unrelated
harness repair, browser deployment, npm dependency addition, or gucOS backend
migration is included.
