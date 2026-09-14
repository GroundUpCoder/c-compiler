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
