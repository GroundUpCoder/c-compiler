# #607 — SDL3 gamepad subsystem: browser Gamepad API backend, kernel routing, veneer object model

Lane: `lane/607-gamepad` (worktree off `main` 71ad436e). Design approved by
@master pre-implementation (adjudication on the ticket); follow-ons #714
(rumble) and #715 (standalone-page pads) were filed by @master during review.

## What landed

Four layers, one honest subsystem — `SDL_Init(SDL_INIT_GAMEPAD)` now succeeds
because a real backend exists behind it, and the refusal message shrank by
exactly that one subsystem:

- **Page (os.html):** the Gamepad API is Window-only and poll-based, so the
  poller lives in the page — a rAF loop armed by `gamepadconnected`, disarmed
  when the browser stops reporting pads (zero per-frame work padless). It
  diffs against the last-forwarded snapshot and ships only changes through
  the existing `wm-input` seam, already SDL-mapped (W3C standard mapping →
  SDL button/axis ids; the analog triggers become SDL axes 4/5). Pads with
  `mapping !== "standard"` are not forwarded — a documented absence, not a
  broken half-pad.
- **Kernel:** `_pads` registry + `padConnect/padDisconnect/padButton/padAxis`
  — the ONE entry set for both producers (browser poller stamps the idle
  clock; WMP injection does not, the INJECT_KEY rule). Routing is
  focus-follows like the keyboard, with **freeze-on-unfocus +
  reconcile-on-focus-gain** (the Chrome per-page model): `_wmSetFocus` diffs
  the new owner's per-pcb view against the registry and pushes synthetic
  added/removed/state deltas, so a newly-focused app is always current and a
  background app sees frozen state, never a lying live one. Ring records use
  the SDL3 event numbers verbatim (0x650–0x654) under the WM_SAB_LAYOUT
  tripwire; instance ids are monotonic and never reused; names ride the new
  `PAD_NAME` RPC (0x2101) and outlive disconnect in a bounded cache.
- **Injection (headless twin):** WMP `PAD_CONNECT/DISCONNECT/BUTTON/AXIS`
  0x24–0x27 + `wmctl pad connect|disconnect|button|press|axis` — the same
  kernel entries, so a virtual pad is indistinguishable from a browser pad
  below the page layer. Works against boot.js unchanged.
- **Veneer (__SDL.c):** the SDL3 gamepad object model — list/open/close/
  name/state/events, SDL3-verbatim enums and event structs, upstream gates
  (ADDED synthesized at init for already-connected pads; BUTTON/AXIS events
  only for opened pads; REMOVED leaves an open handle valid-but-disconnected
  reading all-zero). `SDL_GetGamepads` is 0-terminated and `SDL_free`-able;
  string↔enum tables are upstream's mapping-DB vocabulary verbatim
  (`"a"`, not `"south"` — verified against SDL_gamepad.c).

Plus `/bin/padbox` (image v269): a live pad view that also prints one stdout
line per event — the e2e instrument and the real-pad verification vehicle.

## 🔴 Declared divergence (the one deliberate departure from upstream's letter)

**`SDL_INIT_GAMEPAD` does NOT imply `SDL_INIT_JOYSTICK` here, and
`SDL_INIT_JOYSTICK` still fails loud.** Upstream implies it because its
gamepad layer sits on a joystick layer; this runtime has no joystick-level
view at all (non-standard pads are not exposed, zero `SDL_Joystick*` symbols
exist — absence is link-loud). Raising the `WasInit` bit would name a
subsystem that does not exist — the PRINCIPLES.md honest-shape call, approved
by @master. Declared in: the SDL.h gamepad section comment, the SDL index doc
(Gamepads group note + notably-absent entry), and this log.
`tests/unit/sdl_init_flags` pins it (the JOYSTICK refusal leg replaced the
old GAMEPAD one in the same commit that filled the absence — the two-sided
edit).

## Honest boundary of the verification

- Unit (`sdl_init_flags` inverted + `sdl_gamepad_basics`), kernel e2e
  (`test_gamepad_e2e.js`, 30 legs incl. the reconcile/state-replay, WaitEvent
  wake, dedup, hotplug, name-survives-disconnect, and the real-OS
  padbox+wmctl part), and browser (`os-gamepad.mjs`, 13 legs incl. the
  lit-button pixel leg and poller disarm) — all green; both e2es stable 3/3
  under `--repeat 3 --under-load`.
- 🔴 **The real-pad leg is UNVERIFIED.** `os-gamepad.mjs` installs a
  `navigator.getGamepads` test double — everything from os.html inward is
  really exercised, but the browser's own pad enumeration and user-gesture
  gating are not. That leg needs jku with a physical controller on
  `/bin/padbox` in a browser session (@master is routing it).

## Deferred, with names

Rumble → **#714** (`Gamepad.vibrationActuator`, page-side async — wireable
through the same seam). Standalone non-OS page pads → **#715**. Documented
absences without tickets (ruled by @master): joystick-level API, mapping-DB
API, touchpad/sensor/LED/battery, `SDL_GetGamepadPlayerIndex`.

## Gotchas worth keeping

- `Sint16` did not exist in the veneer's SDL.h (**#707**, found independently
  by the #502 audit hours earlier) — added as a plain typedef rather than
  faking the axis type narrower.
- The three-sided ring edit (kernel WMEV / host WMEV_* / veneer exports) is
  really five-sided: `WM_SAB_LAYOUT.ev` carries the whole WMEV table, so the
  CD26 tripwire forces the host twin — and `drainInput`'s new cases guard on
  export presence so a pre-gamepad user binary on a persisted root volume
  degrades to not-seeing-pads instead of crashing its process worker.
- Cold-worktree prep, twice bitten: the package repo needed the #580
  upsert-over-seeded-index dance (81 enumerable + 13 producer-gated carried
  from the main clone's repo), and serve.js rebakes to the FAT image at
  startup — prebake with `node tools/mkimage.js --packages=all` or every
  browser test's `waitForServer` times out on the silent multi-minute bake.
- W3C→SDL quantization rounds page-side (`Math.round`, 0.5 → 16384) but
  truncates in wmctl (`(int32)(v*32767.0)`, 0.5 → 16383). Both are legal
  producers of an i16; tests pin each path's own value.
