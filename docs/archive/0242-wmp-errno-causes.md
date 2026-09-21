# 0242 — WMP failures express their real cause (distinct R_ERR errnos, end to end)

- **Status**: done (2026-07-17; header flipped late — the work landed but the frontmatter was left saying open, corrected in the 0255 batch)
- **Design**: todos/WM.md ("Agent control channel"), kernel.js WMP block

## Goal

Arch-debt scan CS7: `_wmpDispatch`'s `ok()` funnel collapsed EVERY wm* failure
to `R_ERR [22]` (EINVAL) — the kernel already knew distinct causes (the
`{errno:'EAGAIN'}` ring-full shape, the not-resizable refusal, the
no-subscriber policy gates) and threw them away, `wmp_cmd()` discarded the
R_ERR payload i32, and wmctl printed generic "refused"/"no such window"
text. No caller could tell no-such-sid from not-resizable from no-WM from
ring-full.

## Plan

Class fix across the three layers (no per-op special cases):

- **kernel.js**: wm* command methods return `0` on success or an errno NAME
  on failure; ONE dispatch-site map (`WMP_ERRNO`) turns the name into the
  distinct R_ERR payload i32. Causes: EINVAL bad/unknown sid or args, EPERM
  the surface's declared mode forbids the op (RESIZE on non-resizable,
  SET_DST on resizable, ACTIVATE on borderless), ENODEV no WM subscribed,
  ESRCH target process gone, EAGAIN event ring full, ENOSYS unknown op.
  `_wmEventTo` names its delivery failure; SURFACE_RESIZE propagates it.
- **os/wm_proto.h**: `wmp_cmd()` keeps the 0/-1 contract but sets `errno`
  from the R_ERR payload (`wmp_consume_err`, shared with the typed-reply
  paths) — any present or future caller can strerror() the cause.
- **os/wmctl.c**: every refused command reports
  `wmctl: <op>: <strerror(errno)>` (ENODEV keeps a "(no WM subscribed)"
  hint); shot/thumb refusals ride the same helper.

ENODEV (not ENOTCONN) and EPERM (not ENOTSUP) were chosen because the libc
strerror table only names errnos ≤ 39 — the socket-family strings gap is
filed separately (todos/0243).

## Acceptance

- test_wm_policy.js: wire-level R_ERR payload asserts prove DISTINCT errnos
  (ENODEV pre-subscribe MENU; EAGAIN on RESIZE into a flooded ring; EPERM on
  RESIZE-non-resizable / SET_DST-resizable / ACTIVATE-borderless; EINVAL on
  bogus sid / size floor) — red pre-fix (all read 22), green post.
- test_wm.js: JS-API asserts on the same causes + full-ring inject EAGAIN.
- test_wm_service_e2e.js: wmctl's human-facing stderr names the cause
  ("Invalid argument" vs "Operation not permitted" vs "No such device (no
  WM subscribed)").
- Image v111 bake; kernel suite + browser sweep green.
