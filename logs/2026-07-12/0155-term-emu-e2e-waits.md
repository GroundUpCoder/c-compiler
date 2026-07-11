# 0155 — Retire the hard-tail kernel e2e sleeps (0083 residue)

The last of the 0083 sleep-sync sweep: the settles that were neither cleanly
window-observable (done in 0083) nor win32-agent-tree (0154). Two new `wmctl`
wait primitives + audit-and-annotate over the term/emulator/misc e2es.

## New wmctl wait conditions — `dim` / `dst` (os/wmctl.c)

The bulk of the residue was **RESIZE/SET_DST ack round-trips**: a settle where
the signal is a *same-window geometry change*, not a window appearing. 0083's
`wait win/flag/seq/count` couldn't express "the client acked its resize". Added:

- `wmctl wait dim SID WxH` — SID present AND buffer `w==W && h==H`. Fires when a
  RESIZE ack lands. **Position-agnostic** on purpose, so a WM-placed window
  needn't have its origin pinned in the test.
- `wmctl wait dst SID WxH` — SID present AND on-screen `dst_w==W && dst_h==H`.
  Fires when a SET_DST / scale-to-fit ack lands (fixed-size window maximize).

Both parse `WxH` with one `sscanf`, key off the existing `WMP_LIST` `wmp_rec`
(`w/h/dst_w/dst_h`), and take the default 2-arg (SID, WxH) shape — no change to
`do_wait`'s arg-count logic. The condition eval is the same poll-to-deadline
loop as the rest of `wm_cond_met`.

## Conversions vs. annotations

The rule applied, file by file: **convert what has a clean event observable;
annotate the genuine timing subjects with a one-line reason** (the 0154
precedent — no bare synchronization sleep survives, `grep "'sleep "` is clean).

- **Window spawn** → `wait win TITLE`; **teardown** (kill/close/exit) →
  `wait nowin TITLE` / `wait gone SID`.
- **Geometry acks** → `wait dim` / `wait dst` (winbox max/restore, fixbox
  scale-to-fit max, sysmenu Size commit, term drag-resize, gpubox client
  resize, cairo resize).
- **Minimize/restore state** (Show Desktop toggles) → `wait flag/noflag SID m`
  on the lower of the two fresh winbox sids (captured in-shell; Minimize All &
  co. set every window in ONE wm.c pass, so once TWA's flag flips in a list
  snapshot, TWB's has too — checked in JS).
- **Cascade** → `wait dim TWA 614x427` (the uniform box).
- **Launch deltas** → `AC=$(… grep -c winbox$)` + `wait atleast winbox $((AC+1))`
  (the 0098 search-launch pattern, reused for the desktop activate legs).
- **Async filesystem outcomes** (rename commit, orphan `mkdir`, the `less` rc
  file) → bounded polls `for i in $(seq 1 N); do [ -e … ] && break; sleep 0.05;
  done` (the 0090/0092 idiom).
- **notepad open** (title "…Notepad", not exact) → bounded `wmctl list | grep -q
  Notepad` poll (the winmine leg's idiom).

### gpubox — `wait seq SID 1`
gpubox `-f N` renders a **frozen pose**: the first Dawn present *is* the final
content, so `wait seq $SID 1` (first present) subsumes the variable Dawn
adapter/device init AND the render — strictly more robust than a fixed
`sleep 4`. Used only here; the game/emulator renders are NOT frozen (see below).

### Kept as annotated timing subjects
- **Multi-frame content renders** — term's pty echo + `ls` output + vi/less
  alt-screen bursts, and every game/emulator boot-animation-to-shot settle
  (sameboy checkerboard/CGB intro, punes blue fill + A-button white tint, mgba
  test ROM, doom/quake/gameboy first frames). A single `wait seq +1` would
  under-wait (catches the echo/boot frame, not the asserted content), so a
  generous annotated sleep is the *correct* wait here — the todo called these
  "genuine timing subjects with no cheap observable."
- **Coarse wm.c `desk_load` polls** (~1s tick) — creating a Desktop file then
  waiting for the icon grid to re-scan; no per-icon window to wait on.
- **In-surface desktop selection / inline-rename renders** — navy label strips,
  editor open/dismiss; the WM window list can't see them (the todo anticipated
  these "may have no observable").
- **Keyboard move/size mode-engage settles** — the popup stays as the key
  grabber with no flag; position nudges change x/y (no `dim` observable).
- **Negative checks** — single-click-does-not-spawn, Enter-on-multi-select
  no-op, EEXIST-keeps-both, Esc-leaves-untouched, grayed-Size-is-a-no-op.
  The passage of time is the test.
- **hush readiness** — `term &` → `wait win term` then a small annotated sleep
  before typing (no observable for "inner hush is at its prompt").

## test_os_boot.js — audit, no change

Its two "sleep" hits are the *subject under test*, not synchronization: `sleep
30 &` is the named background job that `pgrep -l`/`pkill`/`pgrep` find and kill;
`usleep 1000` exercises the usleep applet. Nothing to retire.

## Result

Sleep-line counts (bare sync → all annotated/converted):
wm_service 53→38, term 22→12, sameboy 5→3, punes 5→3, mgba 2→1, gpubox 5→0,
os_apps 3→1, cairo 3→2. Every surviving sleep carries a one-line reason;
`grep "'sleep "` over the eight files shows no bare entry.

Image bumped **v74→v75** (wmctl.c is a seeded bake input); prebaked fixture
rebaked. Each changed e2e verified individually (all PASS) and the full kernel
suite is green.
