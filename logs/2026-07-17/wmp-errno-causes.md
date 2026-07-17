# WMP failures name their real cause (arch CS7, todos/0242)

`_wmpDispatch`'s `ok(r)` helper mapped every falsy wm* result to
`R_ERR [22]`, so EINVAL was the only errno the WM protocol could ever
speak — even though the kernel knew the distinct causes and threw them
away (the ring-full `{errno:'EAGAIN'}` shape, the not-resizable refusal,
the subscriber-gated policy gestures). The C side compounded it:
`wmp_cmd()` `wmp_skip`-ped the R_ERR payload, and wmctl printed generic
"refused"/"no such window" text. Net: no caller — human or agent — could
tell no-such-sid from not-resizable from no-WM from ring-full.

## What landed

Class fix, three layers, no per-op special cases:

- **kernel.js**: the wm* command methods now return `0` on success or an
  errno NAME on failure; the ONE dispatch site maps the name via
  `WMP_ERRNO` (numbers pinned to the libc errno.h / host.js errnoMap) into
  the R_ERR payload. The full cause table:
  - `EINVAL` (22) — bad/unknown sid, out-of-range dims/layer, unknown
    inject kind, SHOT/THUMB of a bogus sid (methods whose ONLY failure
    mode is a bad argument — MOVE, FOCUS/RESTORE, MINIMIZE, RESTACK —
    stay all-EINVAL deliberately: that is their real cause, not a funnel).
  - `EPERM` (1) — the surface's declared mode forbids the op: RESIZE on a
    non-resizable surface, SET_DST on a resizable one, ACTIVATE on
    borderless.
  - `ENODEV` (19) — the op needs a subscribed WM and none is: CYCLE, MENU,
    SNAP, SAVER, SYSMENU, ACTIVATE.
  - `ESRCH` (3) — the target surface's owning process is gone
    (`_wmEventTo`; defensive — surfaces are reclaimed at exit, so it is
    reachable only in the teardown window).
  - `EAGAIN` (11) — event-ring delivery would drop: RESIZE, CLOSE_REQ,
    INJECT_KEY/POINTER into a full (or absent) ring.
  - `ENOSYS` (38) — unknown op (unchanged, the pre-existing precedent).
  `_wmEventTo` names its own failure now, so kernel-RPC `SURFACE_RESIZE`
  also reports the true cause instead of a hardcoded EAGAIN. `wmKey` keeps
  its boolean UI-bridge contract (`=== 0` at the tail); `wmGlass` and
  INJECT_SCREEN have no failure mode — stated, not skipped.
- **os/wm_proto.h**: `wmp_cmd()` keeps 0/-1 but sets `errno` from the
  R_ERR payload via the new `wmp_consume_err()` (shared with the
  typed-reply paths — do_shot/do_thumb use it too). Additive: existing
  callers byte-compatible, any future caller gets the cause for free.
  Extends the 0234 "errno tells the truth" line (wmp_read_all's
  ECONNRESET).
- **os/wmctl.c**: refused commands report
  `wmctl: <op>: <strerror(errno)>`, with a "(no WM subscribed)" hint on
  ENODEV. The generic "resize refused"/"no such window" strings are gone.

## Errno choices (and the gap they exposed)

ENOTSUP and ENOTCONN were the semantically-canonical picks for
mode-forbidden and no-WM, but the libc `strerror` only names errnos ≤ 39 —
both would render "Unknown error", defeating the human-facing half of the
fix. EPERM ("Operation not permitted") and ENODEV ("No such device")
are distinct, truthful, and render. The strerror socket-family gap is
filed as todos/0243 (it already mis-reports every sockets program's
perror today); if it lands, flipping 0242's picks is possible but the
wire values are additive so there is no pressure.

## Red→green

Pre-fix, the new asserts all read payload 22: test_wm_policy's
`[65,22]` on MENU-no-subscriber / RESIZE-ring-full / RESIZE-non-resizable /
SET_DST-resizable / ACTIVATE-borderless (5 FAILs), test_wm's 12 FAILs on
the errno-name returns. Post-fix: distinct 19/11/1/22 and all green.
The ring-full leg floods the client's cap-64 ring with injects, then
RESIZEs — the EAGAIN that used to vanish. test_wm_service_e2e asserts the
wmctl stderr text end-to-end ("Invalid argument" vs "Operation not
permitted" vs "No such device (no WM subscribed)").

No compiler.js / host.js change (host.js's errnoMap already had every
number). Image v111.
