# #761 — embedded debug information for source-built distribution binaries

Epic: C/SDL developers need platform frames to distinguish their own faults
from compiler, libc, SDL and system-tool faults. This implements the concrete
serial audit campaign item, not a broader debugging subsystem.

## Measurements before the policy decision

Product tree: `5b5f121756d06203644cb03ad291049f58a7fa49`. Real
`vendor/busybox/bin.json` hush built twice via buildProject, with a temporary
wrapper setting `compilerOptions.emitNames` only at generateCode. Both builds'
non-custom wasm sections were compared byte-for-byte and are identical.
Stripped: 249,903 bytes; `-g`: 295,914; metadata delta: 46,011 bytes (18.4%).
No production seam or shipping-policy implementation existed during these runs.

Chromium 149.0.7827.55, actual gucOS `?spawntrace=1` and
`window.__spawnTraces` (#350). Uploaded the two binaries to the guest Desktop;
24 serial launches, 12 per arm in alternating ABBA order. Each runs the real
shell's `-c echo` path. All 24 trace records used warm workers. Times in ms:

| Build | Spawn → first output p50 / p95 | Instantiation p50 / p95 |
|---|---|---|
| stripped | 2.515 / 4.670 | 0.080 / 0.110 |
| -g | 2.515 / 4.305 | 0.080 / 0.085 |

Trace scope is createWorker → first fd1/fd2 output; kernel-side module
lookup/compilation precedes k0. `hadModule` means a Module was handed to the
worker, not proof of a cache hit. This does not measure total cold startup,
all binaries, other engines, or prove a zero-cost claim. Twelve observations
per arm make p95 the maximum. No build-time figure is used as spawn evidence.

Engine memory was measured independently in 24 fresh, serial Node processes
(Node v25.8.2, V8 14.1.146.11-node.24), each loading host.js, the real binary,
and an 8 MiB BlockFS. Full GC before the baseline and in runModule.onReady,
with the actual live instance retained by runModule. Delta at ready, bytes:

| Build | RSS p50 / p95 | JS heap used p50 | External p50 |
|---|---|---|---|
| stripped | 1,687,552 / 1,785,856 | 235,560 | 116,480 |
| -g | 1,736,704 / 1,851,392 | 235,560 | 116,480 |

Both binaries execute the real hush echo command and return 0. Baseline already
includes the input byte buffer, so its extra 46,011 bytes are additional to
these deltas. RSS includes host/runtime allocation and is not a precise wasm
metadata instrument. Node measurements are not presented as browser memory.

A second real browser run measured aggregate owned Chromium process RSS via
`ps` before spawn and while the child hush blocked in `read` after its first
output. Same #350 trace, same ABBA order, 12 per arm. Median growth:
8,011,776 stripped / 8,404,992 debug bytes; p95 67,878,912 / 9,289,728.
The large first stripped launch outlier, warm-pool refills, browser/GPU heaps,
and shared pages make this an explicitly coarse instrument. It cannot isolate
per-module memory or establish a statistically significant metadata penalty.
It does measure the real browser process estate; raw per-process rows retained.

Evidence/scripts: `build/status-fixes/761-{build,spawn,memory,memory-runs,
browser-memory,summarize}.{cjs,mjs}` (as applicable), `761-spawn.json`,
`761-memory.json`, `761-browser-memory.json`, and `761-measurements.json`.
Initial browser attempt incorrectly waited for upload logs in __osOut; uploads
log to __osLogs. It timed out before any launch measurement. Corrected run is
the 24-record result above. Initial Node probe lacked BlockFS imports and
failed at instantiation; corrected runs all return 0. Neither failed probe is
included in the measured sample.

## Decision and implementation

Choose embedded `name` + `c.sourcemap` sections for every **source-built**
image/package binary. The measured warm-spawn medians coincide; Node's live
instance RSS median adds about 49 KiB, with no measured extra JS heap or
external allocation after the byte-buffer baseline. These limited measurements
support paying a bounded metadata cost for diagnostics that are available at
the moment a platform program crashes; they do not claim universal free debug.

Reject a sidecar: it adds matching/versioning and path-resolution failure modes
to the crash path, while these measurements do not establish a runtime cost
large enough to justify that machinery. Reject a separate debug image: it
requires two synchronized images and a developer must select it before a fault.

`buildProject` accepts fourth argument `{debug:true}`, metadata only, stripped
by default for direct callers. The existing seedEntries distribution seam
requests it, and passes `-g` to single-source cc builds. All four real adapters
(mkimage, mkpkg, headless boot, browser fallback bake) forward the option.
Optimization remains orthogonal. Prebuilt bin/native/overlay artifacts are
copied unchanged and retain their producer's metadata policy; this does not
claim to recover symbols that their producer omitted. Image version 284
invalidates persistent browser images. Developer docs state these boundaries.

RED `bfb06ec8`: actual buildProject output lacks the required name section.
Focused host regression now passes: direct API defaults stripped; opt-in works;
both seeded C/project paths carry both sections and real traps report main
with source line 1. Actual image comparison and integration gates follow below.

## Actual candidate image delta and focused validation

Two full `tools/mkimage.js --packages=all` bakes, same package membership and
local assets: baseline v283 **102,782,760 bytes**, candidate v284
**108,588,176 bytes**, **+5,805,416 bytes (+5.648%)**. These are actual sealed
fat-image files (`761-baseline.img`, `761-candidate.img`), not a projection or
a claim of deployment. No merge/deploy occurred. Wasm payload growth totals
5,804,746 bytes; the remaining delta includes updated docs and filesystem
layout. `761-images.json` records every binary. All **54/54** have nonempty
`name` and `c.sourcemap`; every binary's non-custom sections have the SAME
SHA-256 as its baseline counterpart. This candidate contains no stripped
prebuilt exception, but the documented producer boundary still applies to
other overlay/package selections.

New host regression and existing source-package rebuild test pass. Fresh
`761-integration` dispatcher: four newly executed kernel files pass
(cc_srclib, cc_srclib_e2e, abort_backtrace, ksvc), three newly executed browser
files pass (boots, abort_backtrace, spawntrace). Carried rows are not counted
as execution. The new host test is enrolled in the host runner.
Standard flake, final fresh full gate and final manual browser/headless
campaign sessions remain pending; this ticket stays in_progress until then.
