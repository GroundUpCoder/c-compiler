# 0136 — EDIT control interactive scrollbars (WM_VSCROLL / WM_HSCROLL)

- **Status**: deferred (mass-deferred 2026-07-12; was: open)
- **Design**: `todos/WIN32.md` (EDIT status). Umbrella 0133; word-wrap
  (0137) is best sequenced after this since it shares the scroll/line model.

## Goal

The multiline EDIT requests `WS_VSCROLL`/`WS_HSCROLL` (notepad creates it
that way) but the scrollbars are non-interactive: `edit_proc`
(`os/win32/user32.c`) handles no `WM_VSCROLL`/`WM_HSCROLL` and never calls
`SetScrollInfo`, so scrolling is caret-driven only — you cannot click the
arrows/track or drag the thumb to move through a long document. This wires
the standard EDIT scrollbar behaviour.

First confirm the substrate: check whether the user32 SCROLLBAR support
(the standard control exists per WIN32.md — "SCROLLBAR with Windows
notify-only semantics") already renders a bar for a control's `WS_*SCROLL`
style and posts `WM_VSCROLL`/`WM_HSCROLL`, or whether the EDIT must own its
non-client scrollbars. Scope the item to whichever seam is real (verify in
`user32.c` before coding — do not assume a bar is drawn).

## Plan

- Track scroll metrics in `EditState`: total lines vs visible lines (vert),
  and max line width vs client width (horiz). Keep them in sync with the
  existing `topLine`/`scrollX` the caret path already maintains.
- Publish them via `SetScrollInfo(SB_VERT/SB_HORZ)` (range/page/pos) whenever
  the text or client size changes, so the thumb size/position is correct.
- Handle `WM_VSCROLL`/`WM_HSCROLL`: SB_LINEUP/DOWN, SB_PAGEUP/DOWN,
  SB_THUMBTRACK/THUMBPOSITION, SB_TOP/BOTTOM → adjust `topLine`/`scrollX`,
  clamp, `SetScrollInfo` the new pos, invalidate. Keep the wheel (0134) and
  caret-follow paths going through the same clamp so all three agree.
- Horizontal scroll requires the multiline draw offset to honour `scrollX`
  (today it's hard-wired to `EDIT_PAD` for multiline) — this is the shared
  seam with 0137; land the `scrollX`-honouring multiline draw here so 0137
  builds wrap on top of a scrollable control.

## Acceptance

- e2e: a multiline EDIT with content exceeding both dimensions publishes a
  correct thumb; injected `WM_VSCROLL`/`WM_HSCROLL` messages (and thumb-drag)
  move `topLine`/`scrollX` and clamp; the scroll pos round-trips through
  `GetScrollInfo`.
- Manual: dragging notepad's vertical/horizontal scrollbars moves the view;
  arrows/page regions work.
- No regression in caret-follow scrolling or existing notepad legs.
