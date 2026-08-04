# #485 — SDL_PollEvent pumps the input ring (poll-only loops were input-dead)

## The bug

`SDL_PollEvent` (compiler.js `__SDL.c` veneer) only read the wasm-side C
event queue. The OS input ring drained into that queue exclusively inside
`pumpWait`/`waitMulti` (`SDL_Delay`, `SDL_WaitEvent*`, user32's GetMessage)
or the callback-model frame driver. Upstream SDL3 pumps inside
`SDL_PollEvent` itself. So the most common SDL main loop in existence —

```c
while (running) { while (SDL_PollEvent(&ev)) ...; update; render; present; }
```

— with no `SDL_Delay` and no `SDL_WaitEvent` anywhere received **no input,
ever**: measured (filer's `/tmp/sdlrepro` repro) an injected ESC keydown and
a `WMEV_QUIT` close request never arrived; the window was unclosable and the
app unquittable. A foundation gap for the gamedev epic — this is *the* game
main-loop idiom.

## The fix — a dedicated `__sdl_pump`, not `__sdl_pump_wait(0)`

`pumpWait(0)` is already a non-blocking drain (user32 uses it at GetMessage
entry), but its entry deliberately fires the **frame-idle release** (0169):
"this app is back to waiting on events", which releases the kernel-side
wantFrame pin so the compositor may park. That signal is *correct* from
GetMessage/WaitEvent and *wrong* from a hot poll loop — a 60fps poll app
calling it every `SDL_PollEvent` would post a frameIdle message per frame
and churn the compositor through park/doorbell/unpark cycles per present.

So: a new import `__import int __sdl_pump(void)` that calls host.js
`drainInput()` and returns — never parks, never touches the frame-idle
gate. `SDL_PollEvent` calls it at entry. Dry-ring cost is two atomic loads
(`WMIR_RPOS`/`WMIR_WPOS`), fine at many-calls-per-frame.

Wired in all four SDL env flavors:
- surface flavor, headless transport → `drainInput`
- surface flavor, browser transport → `drainInput`
- null flavor (no ring) → `return 0`
- standalone-page flavor (events page-pushed, no ring) → `return 0`

`SDL_WaitEvent*` semantics unchanged — its internal `SDL_PollEvent` calls
now also pump, which is a harmless (idempotent, single-consumer,
same-thread) double drain ahead of `pumpWait`'s own entry drain.

No dupe/concurrency risk: `__sdl_pump`, `pumpWait`, and `waitMulti` all run
as imports on the app's own worker thread; the ring is single-consumer by
design and each record is drained exactly once, whichever drain gets there.

## Test

New leg in `tests/kernel/test_sdl_delay_e2e.js` (folded in rather than a
new file — reuses the harness and leaves the suite registry untouched):
`pollbox`, a poll-only loop with **no Delay/WaitEvent anywhere**, booted as
its own OS process under a second in-process kernel. The test injects a key
mid-spin (must surface as `SDL_EVENT_KEY_DOWN` → `PKEY` line), then sends
`WMEV_QUIT` via `kernel._wmEventTo` (what the title-bar close sends) — must
surface as `SDL_EVENT_QUIT`, and the app must exit cleanly (halt 0).

Red control (predicted before running, per protocol): with the veneer edit
reverted, existing legs L0–L3 stay green, then the #485 leg boots, prints
`PLOOP`, the window appears, and `waitOut2('PKEY ')` times out after 8s with
`out2 == "PLOOP\n"` — FATAL, exit 1.

## Gate results (2026-08-04, after lock release)

- **Red control: matched the pre-recorded prediction exactly.** With the
  compiler.js veneer edit reverted, L0–L3 all green, then
  `FATAL Error: timeout waiting for "PKEY "; out2="PLOOP\n"`, exit 1 —
  the poll-only app spun input-dead with the window up.
- **Green:** fixed tree, 15/15 checks (incl. the three #485 legs), exit 0.
- **Full diff gate** (`tests/run.js --diff origin/main`, all 25 suites):
  todos/unit/host/blockfs/py×19 green; **kernel 157/157** (evidence
  157/157, `test_sdl_delay_e2e.js ok 7.2s`); sweep failed 49/50 on a pure
  env problem — the worktree lacked the `tests/browser/node_modules`
  symlink, so playwright resolved 1.61.1 against the 1.61.0 pin and every
  file refused at launch (the harness's own message: "an install problem,
  not a product problem"; the known worktree-needs-BOTH-symlinks gotcha).
  After symlinking, the full unfiltered sweep re-ran **50/50 green**
  (evidence 50/50). Artifacts judged directly: both
  `build/test-kernel/summary.json` and `build/test-browser/summary.json`
  show `done:true`, `filter:null`, `recorded == total`, zero non-pass.
  Note the dispatcher `build/test-run/summary.json` reflects only the
  sweep re-run (a `tests/run.js <suite>` invocation replaces it); the
  first run's dispatcher verdict lives in its own transcript.

## Bookkeeping

- `os/image.json` version 233 → 234: compiler.js is a bake input and every
  baked SDL binary changes; the in-browser OPFS gate is version-only.
- Verified without the heavy lock (stand-down for #158's gate): the veneer
  compiles, the emitted wasm imports `__sdl_pump`, and the null-flavor CLI
  (`node host.js`) runs a PollEvent/WaitEventTimeout program to a clean
  exit — proving the no-ring env satisfies the new import.
