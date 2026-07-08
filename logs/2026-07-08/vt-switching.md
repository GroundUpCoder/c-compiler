# VT switching: tty ↔ desktop (todos/0022)

os.html gets Linux-console semantics: the xterm tty is **VT1**, the desktop
**VT2**, and the page shows exactly one at a time — Ctrl+Alt+F1/F2 (with
Ctrl+Alt+1/2 as an alias) or the clickable `1:tty` / `2:desktop` switch in
the status strip. Boot lands on VT1.

## Why (and why it's this small)

Availability under partial failure, not layout: VT1's path is kernel worker
+ xterm only — no compositor, no wm, no GPU — so the shell stays fully
usable while the desktop is broken or merely suspect. It's the maintenance
mode / escape hatch; the everyday terminal is a window since 0020.

Per the design (WM.md "Screen, VTs, and scaling fixed-size clients") this is
**pure UI-bridge work**: zero kernel/compositor/protocol change. The kernel
keeps compositing while VT2 is hidden — frames are mailbox, so the cost is
bounded and the desktop is always current when you switch back. boot.js is
untouched (headless has no desktop).

## Decisions

- **Hiding is `display:none` via `body[data-vt]` CSS**; one attribute is the
  whole page-side state machine. xterm can't measure a hidden pane, so VT1
  entry re-fits *after* unhiding, then focuses the term; VT2 entry focuses
  the canvas.
- **Keybinding is Ctrl+Alt+F1/F2 on a window-level CAPTURE listener** — it
  fires before xterm's key handling and before the canvas's forwarding
  handler, so the chord works identically on both VTs. Ctrl+Alt+1/2 is an
  alias because bare F-keys are OS-contested on some platforms (macOS media
  keys). Matched on `e.code`, so keyboard layouts don't matter.
- **Stuck-modifier release**: switching VT2→VT1 mid-chord means the app saw
  Ctrl/Alt keydowns whose keyups will land on the xterm. setVt synthesizes
  ControlLeft/AltLeft keyups into the focused surface — the same class of
  fixup every console switcher does. (`wmKey` no-ops with no focus, so it's
  safe when no window exists.)
- **Pointer lock**: explicitly exited when leaving VT2 (don't rely on the
  browser noticing the hidden element), and lock *requests* are gated to
  VT2 — the wanted state persists and re-arms per 0018 on the next client
  click after returning.
- **halt / boot-error force VT1** — the notice lives on the tty; the escape
  hatch is where failures surface.

## Test fallout (the real cost)

With exactly-one-visible, every browser test that interleaves shell typing
and canvas work needs to be on the right VT: pixel sampling and mouse input
on VT2, `page.keyboard.type` into the shell on VT1 (which also replaces the
old `page.click('#terminal')` refocus trick — VT1 entry refocuses the term).
Pixel waits on VT1 could stall forever on stale frames: the worker-side
compositor rAF may idle while its placeholder canvas is hidden, which is
fine (mailbox) but means "wait until teal" must run on VT2. os-wm/os-doom/
os-quake/os-gpubox/os-term got `setVt()` calls at each transition;
os-boots is tty-only and needed nothing.

New acceptance: `tests/browser/os-vt.mjs` — boot lands on VT1 full-page;
chord → VT2 interactive (teal + taskbar); back mid-doom (shell works,
desktop intact + animating on return); `kill $WMPID` → VT switching and the
shell still work over kernel-chrome fallback (the failure-mode rationale,
demonstrated); `exit 3` from VT2 → halt forces VT1. The shell-output checks
use a quote-split (`echo VT1-O''K`) so the needle can't be satisfied by the
command's own tty echo.

## Gotchas

- `#status` used to be a bare text node; anything writing
  `statusEl.textContent` would have wiped the new switch controls — status
  text now targets a `#statusmsg` span.
- The seeded image is untouched (os.html isn't seeded) — image.json stays
  **v16**; no re-seed needed.
