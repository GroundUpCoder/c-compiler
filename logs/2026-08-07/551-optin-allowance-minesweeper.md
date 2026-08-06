# #551 round 2 — software opt-in, the SDL_AppInit allowance, minesweeper proof

Continues `logs/2026-08-06/551-refusal-callbacks.md`. Design authority: #551
ticket comments 019fd754 (opt-in), 019fd76b (play-through acceptance),
019fd77d (three items), 019fd789 (the AppInit finding).

## Item 1+2 — the software renderer is an EXPLICIT opt-in now

`SDL_CreateRenderer(win, "software")` selects the leg-C CPU rasterizer
(shm flip — no GPU frames, no budget, legal from any loop shape). NEVER
auto-selected: NULL/"gucos" stay GPU, and unknown names ("opengl",
"metal") still fail with "Couldn't find matching render driver" — the
stale #497 comment that premised that failure on the rasterizer not
existing is rewritten with the code. `SDL_SetHint`/`SDL_GetHint` landed
(grow-only store, any name round-trips) with upstream's env-override rule:
`getenv(name)` beats the stored value, which is exactly what makes
`SDL_RENDER_DRIVER=software ./game` work on byte-unmodified third-party
source. `SDL_CreateRenderer(name=NULL)` falls through to
`SDL_HINT_RENDER_DRIVER`. Host side: the two renderer backends mint
handles in separate spaces, so the mode locks at the process's first
renderer create and mixing fails loudly; the standalone page flavor
refuses "software" loudly (no shm tier there — and no blocked-worker
hazard either). Headless flavor ignores the flag (it IS the software
tier).

## Item 4 — the SDL_AppInit allowance (direction A, argued)

The first-present refusal killed a CORRECT callbacks app that presents
once inside `SDL_AppInit` (which runs while the header-provided main() is
still on the stack) — a dead-end error telling the app to adopt the model
it already uses. Adopted direction (A): the refusal fires on the SECOND
GPU-transport present while main() is live. Why (A) over (B, branching
message): a blocking loop reaches its second present within one frame
time, so the diagnostic still fires effectively immediately; the cost is
ONE recyclable-once-main-returns frame against a budget in the thousands;
a "loop hidden inside SDL_AppInit" presents twice, so that escape stays
closed; and (B) keeps a correct app dead with better wording — a remedy
would still be needed, and (A) IS the remedy. Deviation from the original
"fires at the FIRST present" language is recorded here deliberately.

Invalidated committed assertions, re-cut with MORE coverage (the standing
rule): test_gpu_present_clamp's "refusal ships NOTHING" leg became
first-ships/second-refuses (plus a full callbacks-splash shape leg and a
software-mode leg — 23→28 legs); os-loopguard's "wmFrames flat" leg
became "<= one allowance frame per refused app", and it grew a
splash-in-AppInit C fixture (must run clean, exit 0) plus a FIX-1 rescue
leg (the refused delayloop binary re-run under SDL_RENDER_DRIVER=software
works).

## The message

Re-cut to jku's approved shape (019fd754): FIX 1 = the software opt-in,
FIX 2 = SDL_MAIN_USE_CALLBACKS, Details: /usr/share/doc/sdl-gucos.md; the
"detected" line names SDL_RenderPresent() vs wgpuSurfacePresent() from the
refusal site. One deviation flagged for jku's copy pass: the closing line
reads "Exiting (status 69)." — the approved draft had no status figure;
the number makes the shell-visible RC self-explaining. No vendor budget
figure anywhere (test-asserted).

## Discoverability (all four surfaces)

1. The message is self-sufficient (above). 2. `/usr/share/doc/sdl-gucos.md`
baked from `os/doc/sdl-gucos.md` (loop models, the opt-in, why, quitting
rules). 3. gcode's system prompt teaches both rules BEFORE an agent writes
a blocking loop. 4. `todos/SDL3.md`: the #551 bullet carries the opt-in and
the allowance; the Hints backlog section flipped to landed.

## Minesweeper — the flagship demo, proven end to end (2026-08-07)

The sample script's launch line is now `SDL_RENDER_DRIVER=software
./minesweeper` (upstream ProgrammingRainbow source stays byte-unmodified;
the game's classic blocking loop is legal on the software tier).
`notes/run-minesweeper-sample-demo.mjs` driven to PASS in headless
Chromium 149: desktop tap → fileman → samples → the .sh → term → curl of
24 files from raw.githubusercontent.com → in-OS `cc *.c` (libpng+zlib) →
the game window "Minesweeper / Prato Fiorito" renders AND plays (a click
uncovered cells with real adjacency numbers; timer ticking). Evidence:
s3://groundupcoder/gucos/551-minesweeper-software/2026-08-07/
(0-desktop, 1-samples-folder, 2-term-fetching, 3-game-up, 4-game-clicked).
Driver repairs while getting there (it was written against v163): per-step
confirmed navigation (back-to-back injected keys + one 8s tail wait raced
under browser load), agent-click (`wmctl click LISTBOX:0`) instead of the
stale (100,40) coordinate click (today's toolbar/EDIT occupies that
point), and samples/ now holds "Web Demos/" ahead of the .sh (row 1, not
row 0). test_minesweeper_sample_e2e.js (which derives rows from the
manifest) passes untouched.

## Gate-membership recommendation for the play-through (argued, not armed)

Recommendation: (i) — KEEP IT A MANUAL ACCEPTANCE SCRIPT (notes/),
evidenced by this run + the S3 shots; do NOT arm it as a sweep member.
Why: it hard-depends on live raw.githubusercontent.com and ~2 minutes of
in-OS compile; a network-dependent member of the serial sweep WILL
eventually go red for reasons unrelated to this repo, and the repo's own
test-sync discipline holds that a test failing for the wrong reason is
worse than none. Everything hermetic about this flow IS gated:
test_minesweeper_sample_e2e (tap chain + script shape, headless, every
kernel run) and os-loopguard (the refusal + the SDL_RENDER_DRIVER=software
rescue proven on an in-OS-compiled fixture, every sweep). Option (ii)
(loud-skip member) still adds GitHub availability + ~5 min to every full
sweep; option (iii) (vendored snapshot) guts the demo's point — that
LIVE, unmodified third-party code builds in gucOS. If jku wants a
periodic canary, the right home is a cron/dogfood pass, not the merge
gate.

## Re-entrancy audit (the rescoped merge-gate item from 019fd737/019fd789)

Question: can a timer or promise continuation reach `drainInput()` (which
re-enters wasm via `__sdl_push_*`) while a wasm call is suspended?

- In the OS process-worker flavor, NO import is `WebAssembly.Suspending`:
  sdlDelay/pumpWait/waitMulti are raw `Atomics.wait`, fs is the sync SAB
  RPC, and the Suspending sleep/read implementations live in the
  standalone flavor only. Therefore a `WebAssembly.promising`-wrapped
  entry (main, or a frame callback under hasJSPI) can never actually
  SUSPEND mid-call — it runs synchronously to completion; the await's
  continuation runs only after the wasm frame has fully returned.
- The frame loop is strictly sequential by construction: scheduleFrame →
  (vsyncWait resolves, a task) → drainInput → invoke animFunc → return →
  scheduleFrame. `drainInput` is reachable from exactly two places — the
  pump imports (same synchronous stack as the wasm call that entered
  them) and the frame loop (only between frames, no wasm on the stack).
  There is no timer that calls it: the deadline pacer and vsyncWait both
  schedule doFrame, never drainInput directly.
- The wgpu async-callback exports (`__wgpu_call_*_cb`) are invoked from
  promise continuations, which under a blocked worker fire only at
  event-loop turns — i.e. between frames in the callback model, never
  inside a wasm call, for the same no-Suspending-imports reason.

Consequence: today's invariant is "wasm re-entry happens only when no
wasm frame is live". THE JSPI FOLLOW-UP CHANGES THIS: making any OS-flavor
park import Suspending makes suspension real, and then drainInput's frame-
loop call site and the wgpu callback exports become reachable mid-call —
that re-derivation is the follow-up ticket's burden, recorded here so it
is not rediscovered.

## Post-script: the gcode system-prompt line is REVERTED (jku ruling)

Surface 3 above (the hardcoded `system_prompt` literal in os/gcode/gcode.c)
is withdrawn on jku's explicit instruction — the SDL rule should reach
gcode as CONTENT through the doc mechanism #530 adds (GCODE.md support),
not as a string edit. Independently, the string edit was a measured
regression: gcode hashes cfg->system_prompt into every session record and
recomputes on resume, so changing the literal made EVERY existing session
print "resumed system prompt differs". os/gcode/gcode.c is byte-identical
to main again (verified: git diff origin/main -- os/gcode/gcode.c empty);
no test coupled to the line (git grep system_prompt -- tests/ = zero,
positive-controlled). Discoverability keeps three surfaces: the refusal
message itself, the baked /usr/share/doc/sdl-gucos.md it names, and
todos/SDL3.md; the prevention surface moves to #530.
