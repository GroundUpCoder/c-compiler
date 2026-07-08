# Scoping the desktop shell (todos/0028–0033)

With the outer-geometry queue complete (0022–0025 + the 0027 doom
native-present follow-on), a session reviewed what the desktop still
lacks to *feel* like a window manager, and queued the next round:
start menu, desktop icons, title-bar min/max boxes, taskbar polish,
window cycling, and a repeatable bug-sweep format. Design landed as
WM.md "The desktop shell"; items are 0028–0033.

## What the investigation established (verify-first notes)

The interesting outcome is how little kernel work the shell needs —
three findings that were checked against the code, one of which
contradicted a first-pass read:

- **wm.c can own many windows, with per-event dispatch.** A first pass
  claimed SDL events don't say which window they hit, which would have
  made a taskbar+menu+desktop wm process awkward. False: input-ring
  records carry the surface id, host.js `drainInput` maps sid → window
  handle, and the C runtime fills `windowID` in every event struct
  (compiler.js `__sdl_push_*`). Multi-surface wm.c is fully plumbed.
- **The desktop layer needs no protocol change.** Today a click that
  hits no surface is invisible to the WM (kernel hit-test returns
  `'desktop'` to the embedder only). Rather than adding an
  EV_DESKTOP_CLICK, a fullscreen borderless wm surface RESTACKed to
  the bottom (place=1 already means that) turns every desktop click
  into an ordinary client click on the wm's own layer — which also
  solves start-menu dismiss-on-click-outside.
- **Title-bar buttons split cleanly on the 0025 precedent.** The bar
  has exactly one box today (close). Minimize is already kernel
  mechanism → the min box can be kernel-direct (works in maintenance
  mode); the max box just emits EV_TITLE_ACTIVATE, the double-click's
  event, so wm.c's existing toggle needs zero changes.

The one genuinely new kernel mechanism in the round is the cycling
chord (0032): keys have no grab today, and the chord must be one the
browser will actually deliver (OS-level Alt-Tab never reaches the page
on Windows/Linux — the Ctrl+Alt family aligns with the VT chords).
No-WM dispatch was debated both ways: a kernel focus-next fallback is
stateless and matches the kernel-chrome/raw-box precedents, but the
decision went the other way — **no subscriber → the chord is not
intercepted at all** and the key passes through to the focused app.
Rationale: the kernel never silently eats keystrokes, cycling is
purely WM policy (the maximize precedent), and maintenance mode is
already covered by mouse click-to-focus plus VT1.

## Decisions recorded

- Menu entries are folder-driven (`/etc/menu`), not hardcoded: symlink
  = exec target, one-line text file = argv line (covers `term snake`).
  Desktop icons reuse the semantics from `/root/Desktop`.
- Spawned GUI apps get cwd=/root (doom's WAD is cwd-relative). Child
  stdio for service-spawned children is the open question 0028 must
  resolve (a parentless service has no fd 0/1/2 to inherit).
- Bug sweeps are numbered items with a standing checklist (pointer-lock
  needs a human — Playwright can't grant it; gpubox adapter flake;
  Dawn+SIGKILL abort; snake's double-q exit), and findings become
  minimal repro tests before fixes — the conformance-corpus discipline
  applied to the OS.
- 0026 (mount points) slid below the shell round in *Next up* — no
  dependency either way, pure priority call while the WM thread is hot.

## Not queued (still-standing deferrals)

WM frame surfaces v2 (X11-reparenting-style: wm-drawn decoration
surfaces composited around clients — full Win95 fidelity, kernel chrome
as fallback), damage rects, `direct` transport, DPR support, left/top
edge resize, per-stream audio volume: all still lack a forcing
consumer; re-scored during this review and left recorded in WM.md.
