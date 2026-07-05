# Browser-path conformance items: shifted keysym (false positive) + WGPU_WHOLE_SIZE

2026-07-05

## Why

First two items off `todos/CONFORMANCE-REMAINING.md`'s browser section. The
section was labeled "need browser testing" — but `tests/browser/` already IS
that harness (Playwright Chromium + real Safari), so these were taken
test-first against it, same discipline as the unit conformance corpus:
write the spike + check, watch it fail with the predicted symptom, fix,
watch it pass. One of the two turned out to be a false positive — the
test-first discipline is what made that safe (see below).

## SDL shifted-letter keysym — FALSE POSITIVE, reverted, pinned

The conformance item claimed `keysym()`'s `e.key.charCodeAt(0)` is wrong
because "SDL keycodes are unshifted (Shift+a must give SDLK_a=97)". A fix was
applied (`toLowerCase()`), the new browser test went green — and then a doc
sweep before commit found `todos/SDL3.md` had **already retired this exact
finding as a false positive in the 2026-06 audit**. Re-verified against
upstream: SDL3's `SDL_keyboard.c` computes event keycodes as
`SDL_GetKeyFromScancode(scancode, keyboard->modstate, true)` — keycodes are
**modifier-applied** in SDL3 (Shift+a ⇒ SDLK_A=65; "unshifted" is SDL2
semantics). DOM `e.key` is exactly the modifier-applied produced character,
so the ORIGINAL code was the faithful implementation. Reverted.

What's kept: the spike/check pair, inverted to **pin SDL3 semantics**
(`sdl-shifted-keysym-{spike.c,check.mjs}`: Shift+A must deliver 65 +
`SDL_KMOD_SHIFT`, plain a delivers 97; delivering 97 for Shift+A fails).
`keysym()` grew a comment pointing at SDL3.md and the test.

**Lesson:** this stray has now been "found" by two independent reviews
(2026-06 audit, 2026-07 campaign) — the July campaign confirmed it by
matching SDL2 expectations, i.e. "confirmed during review" in the todo did
not mean "verified against the right spec version". When a finding
contradicts a documented past decision, check the decision log first
(`todos/SDL3.md` had the answer, with citations, all along). Behavior that
looks-wrong-but-isn't needs a pinning test more than correct-looking
behavior needs anything.

Chromium note: SDL spikes need `--enable-unsafe-webgpu --enable-features=Vulkan`
even for plain 2D — the SDL renderer is WebGPU-backed.

## WGPU_WHOLE_SIZE through the buffer-map path

`WGPU_WHOLE_SIZE` (u64 ~0) truncates to `(size_t)-1` in ILP32, arrives in JS
as i32 −1, and `size >>> 0` turned it into 4294967295 — mapAsync validation
error ("Size must be a multiple of 4"), and `wgpuBufferGetMappedRange` would
`malloc((size_t)-1)` → OOM abort before even reaching the host.

Two-sided fix, because the C wrapper allocates the staging copy and therefore
needs the *resolved* size before the host call:

- host.js `__wgpu_buffer_map_async`: `size < 0` ⇒ call `mapAsync(mode,
  offset)` (rest of buffer) — mirrors the existing set_vertex/index_buffer
  special-case.
- compiler.js wrapper `wgpuBufferGetMappedRange`: `size == (size_t)-1` ⇒
  `size = __wgpu_buffer_get_size(buffer) - offset` (new host import, added to
  the real env and the no-WebGPU stub env) before the malloc.
- webgpu.h: added `WGPU_WHOLE_MAP_SIZE` (`(size_t)-1`, upstream parity — the
  map functions take `size_t`, so this is the macro that doesn't truncate).

Test: `webgpu-wholesize{.c,-renders.mjs}` — the webgpu-readback flow but
mapping with offset 8192 + WHOLE_SIZE/WHOLE_MAP_SIZE (nonzero offset so the
`bufSize - offset` resolution is actually exercised). Pre-fix: black canvas +
the 4294967295 validation error. Post-fix: exact pink round-trip.

Note: programs compiled with the new compiler import `__wgpu_buffer_get_size`,
so they need the matching host.js. In-repo that's automatic (emitted pages
embed host.js at compile time); only hand-assembled old-host/new-compiler
combos would notice.

## Verification

- `webgpu-wholesize-renders.mjs`: fail→pass (pre-fix: black canvas +
  `MapAsync(..., 8192, 4294967295)` validation error).
- `sdl-shifted-keysym-check.mjs`: green against the reverted (original)
  keysym() — pins modifier-applied delivery.
- Neighbors: `sdl-scancode-check`, `sdl-input-check`, `webgpu-readback`,
  `webgpu-mapwrite` all pass.
- Unit suite: 694 passed, 0 failed, 3 skipped.
