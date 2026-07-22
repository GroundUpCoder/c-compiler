# 0281 — modal dialogs (MessageBox) get their own taskbar buttons

- **Status**: open
- **Design**: WMP surface flags (wm_proto.h), user32 modal creation, wm.c draw_bar; found by bughunt-sc

## Goal
A MessageBox is just another top-level surface, so wm.c gives it a taskbar
button (notepad's save-confirm shows as a second "Notepad" button). Win95
never lists owned/modal popups. WMP has no ownership/transient concept.

## Plan
- Add a transient/owned surface flag: user32 sets it on modal surfaces
  (SDL window flag → kernel surface flag bit → WMP record bit, the
  WMP_F_ALPHA precedent), wm.c's bar skips flagged surfaces.
- Same flag can later suppress min/max title-bar boxes on modals (kernel
  chrome currently draws whatever fits) — note, don't scope-creep.
- e2e: notepad dirty-close → exactly one taskbar button while the confirm
  is up; Alt-Tab/cycle behavior decided + pinned (skip transients).

## Acceptance
Modal up ⇒ no extra taskbar button; test_user32_e2e leg green.
