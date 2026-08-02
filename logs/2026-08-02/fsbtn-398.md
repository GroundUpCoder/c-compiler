# #398 — Full Screen toggle button in #vtbar

`#fsbtn` joins the `#vtbar` right cluster (last child, after `#uploadbtn` —
`#oskbtn`'s `margin-left: auto` right-aligns everything from it onward, so a
tail append disturbs nothing). It drives the browser's element fullscreen on
`document.documentElement`.

Decisions and why:

- **The `.on` class is owned by the `fullscreenchange` event, never the
  click.** Fullscreen ends by routes the button never sees — Esc, hold-Esc,
  browser chrome — and a click-owned class would stay stuck lit after any of
  them. The handler only *requests* transitions; the event is the one source
  of truth for state. (This is also the truthfulness leg in the test: enter
  by click, exit programmatically, assert the button unlit.)
- **`#vtbar` stays visible in fullscreen.** It is the only mouse route back
  out; hiding it would leave hold-Esc-2s as the sole exit — the trap-shaped
  UX Chrome's escape hatch exists to rescue users from. A chromeless
  reveal-on-mouse-to-top mode is explicitly not v1.
- **Feature-gated visibility, hidden-by-default.** CSS hides `#fsbtn`; JS
  sets `body[data-fs-ok]` only when `document.fullscreenEnabled` and
  `documentElement.requestFullscreen` both exist. iOS Safari (video-only
  fullscreen) never shows the control instead of showing a dead one. The
  gate direction matters: if the JS never runs, the button stays hidden
  rather than dead.
- **The handler is the future `keyboard.lock()` host** (the pending Cmd-W
  passthrough spike): the lock/unlock calls slot in next to the
  request/exit pair — ~5 lines later, no new subsystem. Deliberately not
  implemented now.
- `requestFullscreen()` rejections (no user activation / permission) are
  caught and logged as a warning: `fullscreenchange` never fired, so the
  unlit button is already truthful — but the console still names the cause.

Test: `tests/browser/os-fsbtn.mjs` (sweep membership by discovery). Seven
legs: visible+unlit where supported, click-enter lights via the event,
`#vtbar` laid out in fullscreen, click-exit, the non-click-exit truthfulness
leg, and an unsupported-host leg that spoofs the API away with an init
script (the gate runs at parse, so it asserts right after reload — no
second boot-to-ready). Red control demonstrated against pre-fix `os/os.html`
(leg 1 fails: no `#fsbtn` node); green 7/7 after the fix. Both were
single-file hand runs with the heavy lock free — the kernel+sweep gate is
deferred to the coordinator's RELEASE turn.

Headless note: element fullscreen works fine in the sweep's headless
Chromium — `fullscreenElement` is set and `fullscreenchange` fires, so no
headed carve-out was needed.
