# #791 browser acceptance

Runtime under test remains the independently code-approved 0d31aa17. The
acceptance-only follow-up fixes numeric WM surface-ID usage, uses a pixel-aligned
rectangle baseline, and adds read-only actual-transport and installed/served
identity checks. No renderer/font/kernel/lifecycle/Small source changed.

Initial frozen clipping harness failed because it passed a window title where
wmctl move requires a numeric SID. Failure artifacts are preserved under
build/renderclip/2026-09-14T09-06-52-594Z and 2026-09-14T09-12-24-475Z. The rerun
with numeric IDs passed all 16 probes on each backend; successful artifacts:
build/renderclip/2026-09-14T09-13-10-323Z. Actual surface evidence: CPU SID3/PID10,
frameSeq42, no bitmap; GPU SID4/PID23, frameSeq42, 192x128 ImageBitmap.

Initial font comparison failed 2539 channels, all confined to rows63/64 occupied
by the decorative SDL_RenderLine baseline. Software covers row64; GPU covers
row63. Outside those rows all channels matched within tolerance2. This is an
observed line-rasterization difference, not a font/clipping parity pass. Original
screenshots and timing observations remain in
build/fontbridge-browser/2026-09-14T09-13-38-413Z. Replacing that fixture-only
baseline with a one-pixel filled rectangle yields a passing whole-scene
comparison, with actual CPU shared-memory/GPU ImageBitmap transport checks.

The image is v291 with the full dev package set, not a deployed release.
Local/served image SHA256:
97ab49af836d9bc6a421f66f38f218d853e4b46ecaedd66a1c4f7f3e22d0a51c.
Installed Small snapshot:
aba6f88a4dd392b6e0c91d9a3253740b692b49a2bc4d28e20889a55f68a576a1.
Installed selected-file hashes are checked against the sealed local image;
local/served image, metadata and host-source bytes also match. This is not an
independent whole-OPFS image-byte hash. Each successful run records browser
version, source hashes, installed transcript, backend observation and versioned
surface/screen PNGs in its evidence.json.

Font cold timing covers close/open, codepoint rasterization, CPU copy, texture
creation/upload, scene draw and RenderPresent submission (32 samples). Warm
covers cached-texture drawing and submission (128 samples). These are CPU-side
call/submission timings, not GPU completion or display latency. Module load is
outside the measured loop. Screenshots observe completed output separately.

## Measured passing run (no injected load)

Source artifact: build/fontbridge-browser/2026-09-14T09-14-38-185Z/evidence.json.
Chromium 149.0.7827.55. Values in milliseconds; nearest-rank percentiles, with
p99 of 32 samples being that sample set's maximum. This small fixture is not an
end-to-end editor benchmark or a GPU speedup measurement.

| Backend | Operation | n | p50 | p95 | p99 |
| --- | --- | --- | --- | --- | --- |
| CPU | cold font object/raster/upload/submit | 32 | 2.450 | 6.930 | 41.315 |
| GPU | cold font object/raster/upload/submit | 32 | 2.035 | 5.540 | 6.935 |
| CPU | warm cached-texture draw/submit | 128 | 0.385 | 0.425 | 0.435 |
| GPU | warm cached-texture draw/submit | 128 | 0.050 | 0.075 | 0.095 |

“Cold” recreates the font object against an already-loaded process-local module;
“warm” reuses the uploaded text texture and performs no glyph lookup or run
rasterization. Neither measures process/module startup, GPU completion, display
latency, or dynamic-text cache-hit cost. Actual frameSeq160 plus captures establish
completed output separately from the submission-time measurement.

## Frozen acceptance repeats

At acceptance-only commit 4a03977894acd9b561bcaff32a7c4cf88da279fa:
`node tests/browser/os-sweep.mjs --filter=os-renderclip,os-fontbridge --repeat=3 --under-load`
exited 0: 6/6 passed, both files stable3/3, ten CPU load generators, one browser
job, 52.7s. This covers 2/76 browser members, not the full sweep. Preserved summary:
build/791-acceptance/focused-repeat-summary.json; log: focused-repeat.log alongside.

Versioned screenshot/evidence SHA256s, per-run transports, and each repeat's raw
performance records are in 791-browser-artifacts.json. Representative exact-tip
artifacts: build/renderclip/2026-09-14T09-16-27-849Z and
build/fontbridge-browser/2026-09-14T09-16-05-990Z. Each contains CPU.png, GPU.png,
CPU-screen.png, GPU-screen.png, evidence.json. Author visually inspected the
representative CPU clipping surface and GPU font desktop capture, plus the
initial passing GPU clipping desktop and initial font mismatch surfaces.
Automated probes establish pixel/backend/identity assertions; visual inspection
is additional evidence, not a substitute.

Independent coordinator thread 01a09ec1-854e-711f-8fd0-0cdf3b1addca approved the
acceptance-only delta at exact 4a039778. Its reported independent saved-image
comparison found maximum font CPU/GPU channel difference1; syntax/diff checks
passed and transport detection was traced to the kernel bitmap receipt path.
This is external coordinator review, distinct from the author executions above.

## Standard flake tripwire completed

`node tests/flake.js` exited 0 in 516.2s at unchanged test/runtime tip 4a039778.
The legs ran serially with ten CPU load generators:

- Kernel: 12/12 executed runs passed, four selected members each 3/3 stable,
  279.2s. This is 4/206 kernel members, not the full kernel suite.
- Browser: 18/18 executed runs passed, six selected members each 3/3 stable,
  236.6s. The substring tripwire filter also selected the two doompage tests.
  This is 6/76 browser members, not the full browser suite. The summary also
  retains six carried runs from the preceding focused graphics repeats; those
  are not counted as newly executed standard-tripwire runs.

Raw log: build/791-acceptance/standard-flake.log. Preserved summaries:
standard-flake-kernel-summary.json and standard-flake-browser-summary.json in
that directory. The kernel and browser rows both report green; the outer
process exit 0 was observed. After completion the host heavy-lock file was absent.
No author heavy process remains. Coordinator owns integration mapped/release
gates; no main merge, push, deploy, lifecycle source edits or Small writes occurred.

The final evidence-only commit adds this report and the artifact index; tested
runtime and acceptance source bytes remain those of 4a039778 (runtime 0d31aa17).
