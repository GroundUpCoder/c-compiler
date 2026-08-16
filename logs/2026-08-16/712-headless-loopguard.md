# #712 — the blocking-loop + GPU-present refusal fires in boot.js too

Lane `lane/712` off `main @ 8fd47e71`. Ruling (@master, this thread): option
(b) — enforce headless — gated on a positive-controlled blast-radius
measurement with a hard ≤3-file threshold; option (c) (`--strict-present`
opt-in) declined outright.

## The measurement (came back at ZERO)

Corpus: every `SDL_RenderPresent`/`wgpuSurfacePresent` reachable headless
(tests/, os/, vendor/, tools/), instrument positive-controlled with a
constructed known-positive naive.c that the scan found. Every candidate
classified from its own source, not from absence:

- five kernel renderer e2es present exactly once — legal, the refusal fires
  at the SECOND present (the #551 SDL_AppInit allowance);
- `test_sdl_rendertarget_e2e` pins "exactly ONCE" in its own comment (the
  bound-target present fails in the C veneer before the host import);
- `test_render_vsync_e2e` uses the explicit `"software"` driver — the
  sanctioned escape, exempt by design in both hosts;
- `padbox`/`pollball`/`gpubox`/`multiwin` are callbacks/frame-seam apps —
  main() returns before any present;
- vendor/ has zero `SDL_RenderPresent` users; browser fixtures are governed
  by the existing browser guard already.

Zero conversions ⇒ well under threshold ⇒ (b) implemented.

## The shape of the fix (host.js only, plus doc + test)

The #551 machinery — message builder, refuser, `guardPresent`, the
`setMainLive` arming seam — hoisted from the browser flavor's closure to
`createSurfaceSDL` scope and shared. Three decisions worth recording:

- **The headless guard keys on the REQUEST, not the transport.** Headless,
  the software rasterizer serves every renderer, so transport cannot
  distinguish the tiers — but the `software` bit already crosses on
  `__sdl_create_renderer`, so only default-tier (GPU-request) renderers are
  guarded. One program now behaves identically under os.html and boot.js:
  naive shape dies at frame 2 in both; `SDL_RENDER_DRIVER=software` runs in
  both. (An alternative — guarding all headless renderer presents — would
  have broken the sanctioned escape and made the two hosts disagree in the
  opposite direction.)
- **The Dawn/webgpu.h shm present tail gets the same guard** (via
  `'webgpu.h surface'`), completing parity with the browser guard's two
  vias. No in-repo consumer trips it (multiwin/gpubox are frame-seam apps).
- **The message stays jku's approved #551 shape**; the headless variant
  substitutes only where the browser text states browser facts (header
  line 2, WHY paragraph, closing line). Browser output is byte-identical —
  `os-loopguard.mjs`'s pinned phrases are all in the shared body. The
  headless WHY says plainly why a host with no GPU budget refuses anyway:
  the same program dies at its second frame for every desktop user.

Deliberately NOT changed: `createNullSDL` (windowless processes present
nothing — there is no transport to guard), and the standalone-page flavor
(its event loop is the main thread's; the #551 comment there already
records why the hazard does not arise).

`sdl-gucos.md` gains the both-hosts paragraph — the doc's unconditional
"gucOS refuses" is now true as written, which was the ticket's contract
complaint.

## Finding A (separate commit)

The #711 review's finding A rode along as its own commit: the four batch
draw calls validated liveness per element through the singular entry
points (32N registry compares for a condition that cannot change
mid-loop). Singular bodies hoisted into unguarded statics; batches guard
once. Pixel goldens unchanged. The remaining per-element cost is the host
call itself — that belongs to #689.

## Verification

- sdl unit corpus (17 files, incl. exact-value render goldens) green after
  each commit — proves no false refusal from unarmed embeds (run-unit
  drives the backend without `setMainLive`, the same exemption the browser
  flavor always had).
- New kernel e2e `test_loopguard_headless_e2e.js` (registered): naive shape
  → exit 69 + the headless-variant message; SAME binary under
  `SDL_RENDER_DRIVER=software` → runs to completion; single present → exit
  0. Red control (pre-#712 host.js: naive runs 600 frames to exit 0) and
  the diff gate both had to wait for the v271 ship gate's heavy lock —
  results recorded in the lane thread, not assumed here.
- image.json 270 → 271: host.js/compiler.js are bake inputs, sdl-gucos.md
  is baked content.

## Counter-pass (Codex review findings — both real, both fixed)

**The first landing's webgpu-tail guard was INERT.** `shmSurface.present`
runs inside `shmPresentTail`'s `mapAsync` continuation — after the wasm
stack unwinds — so `mainLive` is false there by construction and the guard
could never fire. The review asked for acceptance coverage of the webgpu
transport; writing it exposed the placement defect. The guard moved to the
synchronous `__wgpu_surface_present` import's shm branch (exposed as
`shmSurface.guardMainLivePresent`), which is the same position the browser
flavor counts the CALL (`presentTo` guards before its own early-returns).

Two measured facts shaped the test:

- a blocking `main()` headless can never acquire a Dawn device — the
  adapter/device callbacks ride the event loop a blocking loop never
  yields (probe: NO-DEVICE-IN-MAIN). So the only raw-webgpu present a
  main-live program can issue is a deviceless `wgpuSurfacePresent()`, and
  counting the CALL (as the browser does) is what makes the guard
  reachable at all;
- the deviceless path needs no Dawn package — `SDL_GetWGPUSurface`'s
  shm-surface record is created deviceless — so
  `test_wgpu_loopguard_headless_e2e.js` never skips. It ran RED (6 FAILs,
  `WNAIVE-EXIT=0`) against BOTH the no-guard base `8fd47e71` and the
  inert-placement first landing `014a4c12`, and green after the move —
  the second red is the review finding demonstrated executable.

**Doc honesty fix (finding 2):** `sdl-gucos.md` claimed both hosts use
"the same message"; the message deliberately varies its host-facts lines.
Now says: same exit status, equivalent diagnostic — same detection line
and fixes, rationale worded per host.
