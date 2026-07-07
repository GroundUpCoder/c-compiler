# 0018 — quake windowed: relative mouse + pointer lock

The last vendor app joins the WM acceptance set. The feature is the
relative-mouse surface flag WM.md designed into "Input routing"; quake is
its consumer (mouse look). Landed across all five layers:

SDL3 C API (`SDL_SetWindowRelativeMouseMode`) → host.js
(`SURFACE_SET_FLAGS` 0x1006, flag word bit1) → kernel.js (wanted/active
lock state + relative routing) → UI bridge (Pointer Lock API) → and back
down as rel-flagged input-ring records → `__sdl_push_mouse_motion_rel_event`
→ `SDL_EVENT_MOUSE_MOTION` with true `xrel/yrel`.

## Decisions (and the why)

- **The lock gesture is kernel-hit-tested.** First cut had os.html request
  the pointer lock on ANY canvas mousedown while the flag was armed — which
  would have locked on title-bar clicks and broken window dragging (an
  acceptance line). But only the kernel knows what a click hit. So the
  page never decides: a client-area mousedown on the focused relative
  surface makes the kernel RE-SEND `onPointerLock(true)`, and the page
  calls `requestPointerLock()` inside that click's transient activation
  (the page→kernel→page round trip is well inside Chrome's activation
  window). Chrome/desktop/title clicks never re-offer. A no-gesture
  request (app startup) rejects quietly and the next client click takes
  the lock — which is exactly the browser-game UX everyone knows.
- **Wanted vs active.** WANTED (focused surface requested relative mouse)
  is kernel-computed and pushed to the bridge on change — focus moves,
  minimize, destroy, and flag clears all withdraw it. ACTIVE (the lock is
  actually held) is bridge-reported (`pointerlockchange` →
  `wmPointerLockChanged`), because ESC is browser-enforced and the kernel
  can't see it. Only ACTIVE flips routing — so after ESC the window is
  immediately draggable/closable again even though the app still wants
  relative mode. Losing wanted also force-clears active (the bridge exit
  is async; routing must not linger).
- **Rel records reuse WMEV.MOUSEMOTION** with word [5] = relative flag
  (words [2]/[3] become f32 dx/dy) instead of a new event type — the ring
  event numbers mirror real SDL event values, and a relative motion IS
  `SDL_EVENT_MOUSE_MOTION` on the C side. Old binaries never see rel
  records (they never set the flag), so the unused-word reuse is safe.
- **Injection needs no lock state.** `wmInjectPointer('rel', dx, dy)` (WMP
  kind 4, `wmctl relmove`) is post-hit-test by design like every inject —
  headless tests drive relative motion without any pointer-lock dance.
- **Locked buttons land at the client center.** SDL freezes the position
  in relative mode; games read deltas and button state, not coords.
- **Standalone pages got the feature too** (same SDL API, one window = every
  click is a client click): `{type:'sdl-relative-mouse'}` notify, page-side
  click-to-lock, `SDL_WEB.mouseMoveRelMsg` scaling movementX/Y by the same
  letterbox math as absolute coords so sensitivity doesn't change with CSS
  zoom.
- **`+mlook` is now quake's autoexec default.** The old config kept mouse
  look off for trackpad ergonomics — sensible when absolute-derived deltas
  fought the window edge, wrong now that the pointer lock exists. Keyboard
  bindings unchanged.

## Seeding

`/bin/quake` is an image.json `project` entry; `os-common.js buildProject`
grew `--allow-old-c` (same four-option expansion as the cc driver — and it
now THROWS on unknown compilerArgs instead of silently dropping them, which
is how this gap was almost missed). pak0.pak (18MB, tracked in-repo) +
autoexec.cfg land under `/root/id1` via `bin` entries — quake's basedir is
"." and hush starts in /root. The 18MB seed-time BlockFS write was the size
test 0018 wanted; it's unremarkable (first boot ~seconds). image.json is
**v14**.

## Testing

- `test_wm.js`: SET_FLAGS validation, wanted-state transitions on every
  path (flags/focus/minimize/restore/create/destroy), the client-click
  re-offer (and title-click non-offer), locked vs unlocked routing, rel
  injection record shape.
- `test_wm_policy.js`: INJECT_POINTER kind 4 over the socket, window-record
  flag bit3.
- `test_wm_e2e.js`: real C — `SDL_SetWindowRelativeMouseMode` round-trips,
  injected rel deltas arrive as `xrel/yrel` with frozen x/y, locked-bridge
  moves arrive relative.
- `test_os_apps_e2e.js`: quake seeds + boots in-OS headless (18MB pak,
  320x200 window, `r` flag in wmctl list, `wmctl relmove`,
  histogram-checked shot).
- `tests/browser/os-quake.mjs` (manual, real Chromium): the whole
  pointer-lock UX — wanted state reaches the page, click locks, locked
  motion doesn't wedge the present loop, exit unlocks, title drag still
  moves the window, wmctl close quits clean, wanted withdrawn at death.

## Gotchas for later

- `buildProject` used to SILENTLY ignore non `-D`/`-I` compilerArgs. Quake
  would have failed to parse at seed time with no hint why. It throws now.
- The kernel's re-offer fires `onPointerLock(true)` WITHOUT a state change
  — bridge handlers must treat wanted=true as idempotent (os.html's does:
  it just retries the lock if not held).
- **Chromium DENIES `requestPointerLock` under ALL Playwright-driven input**
  — headless AND headful, branded Chrome channel included, with
  `document.hasFocus()`, `userActivation.isActive` and visibility all green
  page-side. The rejection is `WrongDocumentError` ("root document ... not
  valid for pointer lock", playwright#20956): CDP clicks are not OS-level
  gestures to the browser-side mouse-lock permission gate. So the browser
  test asserts the OFFER round trip (a `__osPtrLockOffers` counter probe in
  os.html) and simulates the grant through the real `{kind:'lockchange'}`
  bridge path; the literal lock UX needs one human check in a real browser.
