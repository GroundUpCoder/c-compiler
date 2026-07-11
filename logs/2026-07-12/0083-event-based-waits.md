# 0083 — Event-based waits: `wmctl wait` and the pure-WM/browser conversion

Retired the `sleep N` guess-wait synchronization class from the tests that
could observe their conditions, and gave the rest owners.

## What landed

**The primitive — `wmctl wait` (`os/wmctl.c`).** A new subcommand that polls
`WMP_LIST` on the open WM connection every 30ms until an observable condition
holds, with a failure-deadline timeout (default 15000ms; exit 1 on timeout, so
the ms is a *deadline* not a sync sleep):

- `win TITLE` / `nowin TITLE` — a window with that exact TITLE column exists / doesn't
- `count TITLE N` / `atleast TITLE N` — N (or ≥N) windows titled TITLE
- `gone SID` — SID no longer listed
- `flag SID CH` / `noflag SID CH` — SID present and its FLAGS column has / lacks CH
- `seq SID N` — SID present and `frame_seq >= N`

The `frame_seq` field was already in the 80-byte `wmp_rec` (todos/0024), so the
"repainted since" signal is free. Factored the FLAGS-column builder out of
`do_list` into a shared `rec_flags()` so `list` and `wait` can't drift. The
list output is byte-identical to before (verified: full kernel suite green).

**Why a poll, not a subscribe.** `wmctl` connects unsubscribed and only sees
replies (`wm_proto.h` comment). A subscribe+event-drain path would need the
kernel to push list-deltas; polling `WMP_LIST` on the already-open fd is a few
lines, reuses `wmp_next_reply`, and a 30ms interval is imperceptible next to the
wasm-spawn latencies these waits replace. The timeout is the only knob and it's
a failure signal, which is exactly what a flaky sleep should have been.

## What converted

- **Pure-WM kernel e2es** — every sleep that was really "wait for a window to
  appear / disappear / change flag" became a `wmctl wait`:
  - `test_wm_service_e2e.js`: 53 sleeps → waits. Spawns → `wait win`/`count`,
    menus/popups (startmenu, ctxmenu, startrun, peek, datepop, sysmenu) →
    `wait win <title>` / `wait nowin <title>`, `min` → `wait flag m`, taskbar
    restore/focus/cycle → `wait flag f`, `close`/`kill` → `wait gone`/`nowin`.
    136 ok, 0 fail. Wall clock ~100s (was dominated by the 114 sleeps).
  - `test_snap_e2e.js`, `test_saver_e2e.js`, `test_cursor_e2e.js`: spawn +
    screensaver/preview raise/dismiss + minimize/restore/focus flags. All green.
- **Browser `os-*.mjs`**: mostly already event-based after 0146's `waitOut`/
  `waitPixel`/`waitScreen` extraction. 3 genuine conversions in `os-shell.mjs`
  (a blind pre-check settle → `waitPixel` on the asserted pixel; two strip-menu
  dismissals → `waitNotPixel` on the menu face clearing). Everything else was a
  real timing subject and got a `// timing subject:` annotation.

## What stayed a sleep (on purpose)

The 0083 rule: a bounded-timeout condition poll is fine; a *bare* sleep is only
allowed when it's a **timing subject** with no observable:

- **Negative assertions** — "single click does NOT launch", multi-select Enter
  is a no-op, `*-DELTA-0` checks. Waiting-until would make the assertion vacuous.
- **Geometry round-trips on an existing window** — `max`/`resize`/sysmenu
  move+size: no new/removed window, and the post-`seq` value isn't computable
  from the script. Left as annotated sleeps.
- **Coarse re-read ticks** — wm.c re-scans `/root/Desktop` and `.icons` on a
  ~1s timer; the "new icon picked up" moment has no window-level signal.
- **In-surface control / render settles** — desktop inline-rename editor state,
  pixel-histogram paste renders.

## The residue (owned, not dropped)

The win32-app e2es (fileman, ctxmenu, recycle, user32, notepad, calc, winmine,
ctlpanel, clipboard, openwith, paint, gdi32 — ~295 sleeps) sleep mostly for
*in-app control* state — a dialog listbox refreshing, an EDIT's text landing —
which the WM window list can't see. Those apps expose it over the win32 agent
tree (`wmctl tree`/`gettext`, todos/0058), so the fix is a second wait primitive
(`wmctl wait label/text`) then a per-file conversion — filed as **0154**. The
term tty-render waits + the emulator/misc timing-subject audit are **0155**.
Browser runtime confirmation stays operator-owed (**0153**/**0064**; Playwright
isn't installed in this clone).

## Gotchas

- **`wmctl.c` is a seeded bake input** — bumped `image.json` `version` 72 → 73
  and rebaked `os/os-system.img` so warm e2e boots stay ~1-2s (a cold in-worker
  bake is ~90s). Any later edit to a seeded `os/*.c` restales the fixture; the
  suite runner (`tests/lib/image-fixture.js`) rebakes once up front.
- `wait gone` takes a **SID**, not a PID — the kill legs pass `$WSID`, not the
  `$FPID` they `kill -9`.
