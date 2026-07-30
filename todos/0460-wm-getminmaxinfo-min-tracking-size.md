# 0460 — win32: WM_GETMINMAXINFO + MINMAXINFO — enforce a minimum window tracking size

- **Status**: open
- **Difficulty**: medium — small in lines, but it is a **platform** change in the `user32` + `wm`
  choke files and needs a wm e2e leg, so it is a HEAVY-class lane for scheduling.
- **Design**: this file. Source: the `0459` software-manager resize investigation, 2026-07-30;
  filed by master cont-221.
- **Provenance**: jku, 2026-07-30, on the software manager: *"best win32 practice should be properly
  supported."* This is **the one genuine platform gap** that investigation found versus Windows best
  practice. jku was explicitly told it is **optional** and not required for `0459`, so this is a
  follow-on, not a blocker.

## Goal

Give gucOS win32 apps a way to enforce a **minimum window tracking size**, so a resizable window's
layout cannot be dragged smaller than usable.

## Verified starting state (master cont-221, at `7a1496c0`)

🔴 **The whole mechanism is absent, not merely unwired.** Measured with positive controls:

| probe | hits | reading |
|---|---|---|
| `WM_GETMINMAXINFO` in `os/` | **0** | the message does not exist |
| `MINMAXINFO` in `os/` | **0** | **the struct does not exist either** |
| `WM_SIZE` in `os/` (control) | **22** | instrument sound, tree correct |

⇒ This ticket **creates** the message *and* its structure; it does not flip a switch. Both halves
are owed: a `MINMAXINFO` type in the win32 headers and a `WM_GETMINMAXINFO` send at the right point
in the resize path.

⚠️ **Path note:** the window manager is **`os/wm.c`** and the kernel is **`kernel.js` at the repo
root** — *not* `os/win32/wm.c` and *not* `os/kernel.js`. Several carried notes get this wrong.
Re-derive every line number at spawn ((EN)).

## Plan

1. **Header**: define `WM_GETMINMAXINFO` and the `MINMAXINFO` struct (`ptReserved`, `ptMaxSize`,
   `ptMaxPosition`, `ptMinTrackSize`, `ptMaxTrackSize`) in `os/win32/include/windows.h`, next to the
   existing `WS_THICKFRAME` / window-message definitions. Match the real win32 field order — apps
   ported from ReactOS will assume it.
2. **Send it**: `os/win32/user32.c` must give the app a chance to fill the struct **before** a
   resize is committed, and default the fields sensibly when the app does not handle the message
   (real win32 supplies defaults, and an unhandled message must not clamp a window to 0×0).
3. **Enforce it**: `os/wm.c` clamps the drag/`WMP_RESIZE` geometry to `ptMinTrackSize` /
   `ptMaxTrackSize`. Decide and document where the clamp lives — the wm is the only party that sees
   a drag in progress, so clamping in the app is not sufficient.
4. **Interaction with the two exclusive scaling modes**: read `os/wm.c:937` — *"RESIZE vs SET_DST
   legal — exclusive modes, todos/0021/0024"*. A minimum tracking size is meaningful **only on the
   `WMP_RESIZE` path**; a fixed-size window is bitmap-scaled and has no tracking size. Do not apply
   the clamp to `SET_DST` windows.
5. **Adopt it in one consumer** so the feature is not dead code: `0459`'s software manager is the
   natural first caller once it is resizable. If `0459` has not landed, use `fileman` — but a lane
   that adds the message and clamps nothing has not finished the ticket.

## Acceptance

- `WM_GETMINMAXINFO` and `MINMAXINFO` exist in the win32 headers with real win32 field order.
- An app that handles the message and sets `ptMinTrackSize` **cannot** be dragged (or snapped, or
  restored) below that size.
- An app that does **not** handle it behaves exactly as it does today — 🔴 **no regression for the
  22 existing `WM_SIZE` consumers**, and no window clamped to zero by an unhandled default.
- The clamp applies on the `WMP_RESIZE` path only; `SET_DST` (fixed-size) windows are untouched.
- At least one in-tree app enforces a real minimum.
- A wm e2e leg asserts the clamp holds under a drag that tries to go below it.
- Full gucOS gate green. Standing gucOS auto-ship applies; bundle rather than deploying per-commit.

## Out of scope

- **DPI awareness / `WM_DPICHANGED`** — moot for now: gucOS's `SET_DST` scaling is a window-manager
  zoom, not a per-monitor DPI concept.
- **Moving-edge resize (W / N / NW / NE / SW)** → `0294`.
