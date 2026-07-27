# 0315 — Re-check the DOOM/Quake callback-model workaround against 0224's cooperative SDL_Delay (comment may be stale — or may still be true for the rAF flavor)

- **Status**: open
- **Difficulty**: light (timeboxed — "the comment is still correct" is a valid,
  useful outcome; close it with the evidence)
- **Design**: this file.
- **Provenance**: **(decider call)** — noticed by Fable design pass D / the pygame
  synthesis, 2026-07-27. jku never raised it.

## The observation

`vendor/doom/src/main.c` (`DG_SleepMs`, ~line 178) carries this comment:

> `/* No-op in the browser rAF/callback model: there is no blocking sleep here.
>    main() registers doomgeneric_Tick via emscripten_set_main_loop(...,0,1) and
>    returns; the host drives it via requestAnimationFrame (no JSPI). ...
>    SDL_Delay would throw without JSPI (and a ... */`

`todos/done/0224` (shipped 2026-07-16) made `SDL_Delay` a **real cooperative
sleep in worker flavors**, and `tests/kernel/test_sdl_delay_e2e.js` proves a
classic `while(running){ poll; draw; SDL_Delay(16); }` C app runs as an OS process
with an IDLE-POWER park asserted. The pygame synthesis therefore describes DOOM's
comment as "now-stale", and notes DOOM and Quake were **restructured to the
callback model to work around a limitation that no longer exists**.

## ⚠️ Why this is a QUESTION and not a known defect — do not skip this

**0224 fixed `SDL_Delay` in WORKER flavors. The DOOM comment is explicitly about
the browser rAF/main-thread flavor.** If DOOM is still built as an rAF/main-thread
app, the comment may be **entirely correct as written** and there is nothing to
fix. Nobody has checked which flavor DOOM and Quake actually build as — the
synthesis asserted staleness without that step, and this ticket exists to do the
step rather than to inherit the conclusion.

So the first job is **not** to edit the comment. It is to answer:

1. Which flavor do `doom` and `quake` build as today — worker process, or
   main-thread rAF? (Check their `bin.json` entries and `cc2wasmFlags`; note
   `doom-clang` is a separate sibling build.)
2. Given that flavor, is the "SDL_Delay would throw without JSPI" claim **true or
   false right now**?

## Plan

- Answer (1) and (2) above with file:line evidence.
- **If the comment is TRUE:** close this ticket by recording that, and *sharpen
  the comment* so the next reader does not have to re-derive the flavor
  distinction — say which flavor it applies to and point at 0224 for the other.
- **If the comment is FALSE:** it is a live instance of the standing lesson that
  *a true-sounding comment naming a constraint is exactly why nobody re-checks
  it.* Delete/replace it, and then answer the real follow-up: **is restructuring
  DOOM/Quake back to a blocking main loop actually worth anything?** It probably
  is NOT worth it on its own — they work today — so the likely outcome is a
  comment fix plus a note, not a rewrite. **Do not restructure a working game to
  prove a point**; if you think a rewrite IS warranted, say why in a follow-up
  ticket rather than doing it here.

## Acceptance

- A recorded yes/no on whether the comment is currently true, with the flavor
  named and cited.
- The comment left in a state where the flavor distinction is explicit either way.
- No behavioural change to DOOM or Quake unless a follow-up ticket justifies it.
  If nothing changes but the comment, `tests/` need not move — but say so
  explicitly rather than leaving an unstated gate result.

## Notes

- `todos/LIABILITIES.md` is machine-checked by the `todos` suite. If your change
  rewrites a line anchored by a register entry the gate goes RED — re-anchor or
  retire it in the same commit.
- Related: `todos/done/0224` (the cooperative `SDL_Delay`), `todos/0161`
  (`SDL_WaitEvent` blocking on the input ring), `todos/SDL3.md` (design doc —
  remember it describes *intent*; `todos/done/` describes the world).
