# #601 + #604 — SDL3 veneer trivial-absence batch (one seam, two tickets)

Two #499-register tickets batched deliberately on one seam (the SDL3 veneer
in `compiler.js`): #601 (batch draws, state getters, the SDL_malloc family,
SDL_rand/srand, SDL_Log, GetBasePath/GetPrefPath) and #604 (event-queue
manipulation). Commits are split per ticket (`6a8dcd9c` = #601, `57183129` =
#604); the intermediate #601-only tree was verified to compile #601's test
payload while refusing #604's (the same 88 undeclared-identifier errors as
base), so each commit is independently attributable.

## Decisions and why

- **SDL_rand is upstream's LCG, not a libc `rand` alias.** SDL3's contract is
  `[0, n)` via a 32×32 high multiply over `state*0xff1cd035+0x05` (upstream
  selected the constants with PractRand/TestU01), and its seeding is
  independent of libc `srand`. Aliasing libc would have broken determinism
  contracts for ported code that seeds both. `SDL_rand_bits`/`SDL_randf`
  came along as natural completions — they are the same three lines of the
  same family. `SDL_randf` avoids a hex-float literal (`0x1p-23f`) in favor
  of `* (1.0f / 8388608.0f)` — same value, no dependence on hex-float
  support.
- **SDL_Log only; the priority family (SDL_LogError/Warn/Debug/…) stays
  absent-and-undeclared.** Honest members need the per-category priority
  store (`SDL_SetLogPriorities` filtering, INFO default threshold): without
  it, `SDL_LogDebug` would print traffic upstream suppresses, which is a
  behavioral lie. SDL_Log itself (INFO) is prefix-free to stderr upstream,
  so the veneer's message+newline matches.
- **SDL_GetWindowFlags returns create-time flags only.** The veneer stores
  the create flags in the window record (the popup TU adds BORDERLESS —
  popups are chrome-free by construction). Dynamic state bits (INPUT_FOCUS,
  MOUSE_FOCUS, MINIMIZED, MAXIMIZED) are NOT tracked and are never
  reported: focus events exist only under the OS WM, so latching them would
  return different answers per flavor for the same window state — the
  SDL_GetGlobalMouseState honesty rule applied. Documented as the contract
  in SDL.h.
- **SDL_GetRenderDrawColor tracks C-side.** The create-time default is
  white, which was verified to match BOTH upstream SDL3 and the host
  renderer's initial `drawColor [1,1,1,1]` (host.js sdlRenderers ctor) — so
  a get-before-any-set answers what the host would actually draw with.
- **SDL_GetBasePath follows the kernel32 `proc_info_init` + user32
  `res_chase` precedent**: argv[0] from `/proc/<pid>/cmdline`, a bare name
  re-run through `$PATH` (cwd-joining a PATH-found name invents a file that
  never existed — the 0048 lesson), then `realpath` to chase symlinks so a
  gucman `/usr/local/bin` link yields the package's real bin dir. SDL3
  ownership semantics: cached, owned by SDL (SDL3 changed this from SDL2's
  caller-frees). Fails loud (NULL + error) where there is no /proc.
- **SDL_GetPrefPath uses the XDG data-home shape** (`$HOME/.local/share/
  <org>/<app>/`) — upstream's own POSIX layout, under the writable `$HOME`
  per the ticket. Caller frees with SDL_free.
- **SDL_PushEvent's wake contract is structural, not implemented**: the
  runtime is single-threaded, so nothing can be parked while a push runs,
  and `SDL_WaitEventTimeout`'s loop re-polls before every park — a pushed
  event completes the next wait without parking. Stated in SDL.h and pinned
  by a test leg (push, then a 5 s-timeout wait returns in <1 s).
- **Has/Flush do not pump; PumpEvents is the explicit pump** (upstream
  semantics). PumpEvents binds the #485 non-blocking ring drain
  (`__sdl_pump`), which advances the #493 input snapshots — the push
  exports are this runtime's "updated by SDL_PumpEvents" point — so the
  upstream `SDL_PumpEvents` + `SDL_GetKeyboardState` no-event-loop idiom
  now reads exactly as documented.
- **SDL_PeepEvents implements upstream's NULL-events rule** (a counting
  peek capped at one — exactly what `SDL_HasEvents` needs).
- **image.json 261 → 262**: compiler.js is a bake input and every SDL
  binary in the blob rebuilds (the v237 SDL-batch precedent).

## Test notes

- Both tests are red-controlled against the pre-change compiler: #601's C
  payload fails with 33 undeclared-identifier errors, #604's with 88.
- The #601 pixel legs draw the polyline at half-coordinates
  (`{8.5, 60.5}`…) so probed pixel centers sit strictly inside the 1px
  line quads — the test pins the batch/connectivity semantics (the new
  surface), not the edge-sampling rule of the pre-existing singular
  SDL_RenderLine.
- The #604 test uses the waitevent harness (compiler.js + worker_threads
  kernel, no image bake); the #601 test uses the sdl_render driveBoot
  harness because its acceptance needs the real fs (base/pref paths), the
  in-OS cc, and `wmctl shot`.

## Gaps surfaced (for the coordinator, not filed here)

- The SDL_Log priority family (see above) — would need the priority store.
- SDL_GetWindowFlags dynamic state bits — would need per-flavor focus/
  minimize tracking with honest per-flavor absence semantics.
- `__sdl_eq_alloc` does not check malloc failure (pre-existing; every
  push-export shares it).
