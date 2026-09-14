# #791 — process-local font bridge checkpoint

Follows clipping commit 8721073c on author/791-render-font, rooted at requested
main 16cb5333. No Small repository, kernel, User32, window lifecycle, input or
frame-ownership edits. Shared font facilities support in-guCOS game-development
editors and tools.

The new memory-only C/Wasm module reuses FreeType and fontcore probe/render/tofu.
The process loader reads face files over the existing process filesystem once,
then glyph/run operations remain local. Fonts have explicit ordered fallback
faces, metrics, bounded LRU glyph caches and close. Owned result handles survive
cache churn, font close and caller memory growth; copy produces RGBA8 for the
existing SDL texture upload path. Scalar c.__font_* imports are directly usable
from Small. Full signatures, bounds, errors and codepoint-layout limits are in
os/fontbridge/README.md. The name codepoint_run deliberately promises no shaping,
kerning or bidi; this is not an implementation of a standard-named text layout API.

fontcore gains a checked render seam that distinguishes blank glyphs from failed
render/allocation and bounds bitmap allocation before malloc. Existing consumers
retain the old fc_render_face wrapper/return contract. The image gains the module,
C import header and documentation. Image version is deliberately left for the
coordinator's combined integration/release; this author neither merges nor ships.

Executed direct focused checks:

- tests/host/test_fontbridge.js: real compiled FreeType pixels and metrics,
  independent per-glyph composition versus run coverage, UTF-8 failures, cache
  churn, font/result capacity limits, stale handles, memory growth and teardown.
- Its Small arm compiled through an installed snapshot/cc driver and executed
  through actual runModule c.__font_* wiring, allocating/copying/releasing real
  glyph pixels. Snapshot: aba6f88a4dd392b6e0c91d9a3253740b692b49a2bc4d28e20889a55f68a576a1.
- SDL clip facade unit 1/1, real software SAB clipping pixels, SDL API index,
  browser harness pure unit checks (including unique ports).
- Font browser C fixture compiled using createCcDriver and the new public header.
  Browser JavaScript syntax checks and git diff --check passed.

The coordinator's independent clipping review found missing host test enrollment.
Both new host tests are now registered. The host runner printed registry equality
68/68 (plus 1/1 spawn and 13/13 serve) before its unconditional image bake. That
attempt was stopped immediately: only author runner 31260, shell 31257 and bake
child 31262 were terminated, and subsequent ps confirmed all absent. No suite
completed and no green gate is claimed. Inspection afterward confirms this host
runner does not implement --filter; direct test commands are the focused path.

Graphical fixtures are authored, not executed at this checkpoint. They collect
actual gucOS wmctl surface/screen PNGs, served-source hashes, image hashes,
installed runtime/binary identities and (font fixture) cold/warm p50/p95/p99.
Timings explicitly measure CPU-side calls/submission, not GPU completion/display
latency. Guest PNG transport avoids blank OffscreenCanvas page screenshots and
uses the existing Node PNG decoder, with no Canvas2D helper. The coordinator
reserved heavy order: callback gate, #789 lifecycle acceptance/repeats, then #791.
Browser CPU/GPU results, screenshots, measured percentiles and independent font
review remain open under #791; this checkpoint does not close the ticket.
