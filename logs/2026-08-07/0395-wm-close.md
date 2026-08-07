# #395 — wm.close: a real close-window keyboard action (lane-395)

Ticket: `#395` (light, P2). Branch `lane-395` off `de218a24`. Implementation
commit `9dde9a04`.

## What shipped

- `os/keys.h`: `KTOK_CLOSE` token; `KSA_CLOSE` id; `KS_ACTIONS` row
  `wm.close` — windows **Alt+F4**, macos **Ctrl+Alt+W** (deliberately NOT ⌘W:
  the host eats it until the ⌘-passthrough spike; the override system makes
  `bind.wm.close cmd+w` a one-line user rebind the moment capture works).
- `os/wm.c`: `hotkey_dispatch` case `KTOK_CLOSE` → the **existing** `CM_CLOSE`
  path (`WMP_CLOSE_REQ`, the 'x'-box request-close semantics). Guarded by
  `find(sid)` — own furniture never enters `wins[]` (every `r.pid == own_pid`
  branch of EV_CREATED returns before tracking), so the chord cannot close the
  desktop/taskbar/menus. Auto-repeat (`flags & 2`) is skipped: a close moves
  focus to the next window, so a held chord would cascade through the stack.
  (`cycle` accepts repeat deliberately; `overview` skips it; close follows
  overview's polarity because it is destructive.)
- `os/image.json` v243 → v244 (wm.c is a bake input).
- **kernel.js: untouched** (Finding 1, below).

## Finding 1 verdict: AGREE — the ticket's kernel.js work item is unnecessary

The kickoff's mechanism reading is correct, and I add one measurement that
makes it airtight:

- The kernel evaluates grabs ONLY under `if (this._wmSubs.size)`
  (`kernel.js`, wmKey top). **No subscriber ⇒ no chord fires at all**, default
  table included. So `WM_DEFAULT_GRABS` serves exactly the window
  [WM subscribes, WM's first GRAB_SET].
- `os/wm.c` `main()` pushes `grab_table_push()` immediately after the
  SUBSCRIBE R_OK — **before** `SDL_Init`, before any furniture window, before
  the event loop drains the window snapshot. The boot window in which the
  default table serves /bin/wm is a few RPCs wide, with no app window yet in
  existence to close and no realistic keystroke in flight.
- `wm.overview` is the worked precedent: complete and shipping with **no**
  `WM_DEFAULT_GRABS` row and no reserved twin.
- The only other WM_DEFAULT_GRABS consumers are scripted-WM tests
  (subscribe, never GRAB_SET) riding the reserved legacy tokens — none
  dispatches EV_HOTKEY, so a close row there would be dead data for them too.

⇒ Adding the `KS_ACTIONS` row IS the installation. The ticket's "new
`WM_DEFAULT_GRABS` row + JS-side scancode twin" item is not done, on purpose.

## Finding 2: KSA_CLOSE slot choice and its consequence

Chosen slot: **last of the system block** (after `KSA_OVERVIEW`), which shifts
the numeric id of every app action by +1. Measured consumers of KSA ids:

- `os/win32/ctlpanel.c` `KB_CHORDS[]` — symbolic names, recompiled with keys.h.
- `tests/kernel/keybind_registry_probe.c` — symbolic, recompiled per run.
- `ovr_state/ovr_mods/ovr_key[]` — in-memory per process, rebuilt from the
  cfgstore each revalidate; **persistence keys on the NAME**
  (`bind.%s`, keys.h `ks_load`-side `snprintf("bind.%s", …)`), never the id.

So the id shift is compile-time only; nothing on disk or on the wire carries a
KSA number. (`KTOK_*` IS a wire value, but both ends of that wire are wm.c —
the kernel is token-blind — and `KTOK_CLOSE` is appended, shifting nothing.)

Why LAST specifically: §7.3 makes registry order the collision tie-break — the
EARLIER action wins a chord two overrides share, and `grab_table_push` drops
the later duplicate row. Close is the one destructive verb in the block;
placing it last means a user who fat-fingers two `bind.*` lines onto one chord
gets the non-destructive action, never a surprise close. The probe pins this
placement (`KSA_CLOSE + 1` is the first app row).

## ctlpanel Shortcuts panel: deliberately not touched

`KB_CHORDS[]` lists app edit verbs only — **no** system action (overview,
snap, cycle, start-menu, sysmenu) has ever been listed. Adding close alone
would be inconsistent; adding the whole system block is real scope beyond a
light ticket. Surfaced here rather than silently done or silently skipped.

## Scope fence

The macos edit-verb rows in `KS_TABLE` are untouched (diff shows the
`wm.close` registry row only — the wm-chord namespace, the permitted axis).

## Evidence

- **Repro before** (`build/repro-395-before.log`, tree `de218a24`+bake):
  notepad up, `wmctl skey 61 0 256` (Alt+F4) AND `wmctl skey 26 119 320`
  (Ctrl+Alt+W) through the real screen path → `wmctl list | grep -c` still
  **1**. Grep state: `wm.close` **0** hits, positive control `wm.overview`
  **5** hits.
- **Breakage A** (registry instrument): scratch-flipped the windows default to
  Alt+F5 in keys.h → `test_keybind_registry.js` FAILs
  `close windows = alt+f4` (and the probe exit-code check). Reverted.
- **Breakage B** (dispatch instrument, `build/breakage-b-395.log`):
  scratch-dropped the `KTOK_CLOSE` case body in wm.c, re-baked, ran
  `test_keymap_e2e.js` → driveBoot throws loud on
  `wmctl: wait nowin timed out after 8000ms` / `4000ms`, and the section
  counts show notepads accumulating (1→2→3) because nothing closes. Reverted;
  clean re-bake + full run green (`build/keymap-e2e-395-clean.log`).
- **Non-vacuity**: every close leg asserts POSITIVELY (window count 0 after
  the chord / count ≥1 for negative controls), and breakage B is the proof the
  green legs die when the feature is removed.

## Test re-cuts declared

- `keybind_registry_probe.c`: the shape check labelled
  `"first 8 registry entries are the system actions"` was renamed
  `"the system block precedes the app block"` — the **condition is
  byte-identical** (it was already symbolic); only the count-stale label
  changed. No assertion was weakened; three close assertions and one override
  assertion were added.

## Fixed sleeps

Two `sleep 0.5` in session H are negative-control settles (asserting the
ABSENCE of a close has no marker to wait on) — annotated inline per the
0171 discipline. The macos-flip leg uses the bounded inject-and-poll pattern
(the reval-leg precedent), never a bare sleep as sync.

## Ticket errata (beyond Findings 1/2, all minor)

- "`kernel.js:1091`" is the token constants; the table is at 1107 (and the
  repo-root path point from the kickoff stands).
- `CM_CLOSE` handler is at wm.c:3373 (ticket said menu row 3150; rows are
  3159/3222). Line numbers re-derived at `de218a24` as instructed.
