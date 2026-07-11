# 0154 — Agent-tree waits: `wmctl wait label/text` + the win32-app e2e conversion

The 0083 follow-on. 0083 landed `wmctl wait` over the kernel WM *window list*
and converted the pure-WM kernel e2es; it deliberately left the **win32-app**
e2es alone because their sleeps mostly wait for *in-app control* state (a
dialog's listbox refreshing, an EDIT's text landing, a MessageBox opening) that
the window list can't see. Those apps DO expose that state through the win32
agent tree (`wmctl tree`/`gettext`, served per-process by user32 over
`/run/win32/agent.<pid>.sock`, todos/0058), so this adds a second wait primitive
over that channel, then converts the 14 win32-app files file-by-file.

## The primitive — `wmctl wait label|nolabel|text` (`os/wmctl.c`)

Built on the SAME `agent_scan`/`AQ_GETTEXT` machinery `wmctl click LABEL`/
`gettext` already use, so a wait keys on the exact string a later action clicks:

- `wait label LABEL [MS]`   — a widget resolving to LABEL exists in ANY win32 app
- `wait nolabel LABEL [MS]` — no win32 app has a widget with LABEL
- `wait text LABEL SUBSTR [MS]` — that widget's `WM_GETTEXT` text contains SUBSTR

`probe_one` sends one `AQ_GETTEXT` per app: `AQ_R_TEXT` back ⇒ the label
resolved (and, with `substr`, the text contains it). `do_agent_wait` polls
`agent_scan` every 30ms to a failure deadline (default 15000ms, exit 1 on
timeout — a *deadline*, not a sync sleep), routed BEFORE `wmp_connect` in `main`
like the other agent-tree ops (they talk to apps, not the kernel endpoint). A
missing `/run/win32` leaves `found=0`, so `wait label` keeps polling until the
app comes up and `wait nolabel` is trivially satisfied. LABEL resolves by window
text ('&' stripped) or `CLASS:n` (e.g. `EDIT:0`, `LISTBOX:0`), same as `click`.

## The conversion (14 files, ~324 → ~73 `sleep` lines)

Rules applied uniformly (spec captured in the item + `/tmp` working notes):

- **Boot** → `wait label <button>` (agent serving ⇒ controls built + window
  listed + WM_CREATE/PAINT/ready already out) or `wait win TITLE` for non-user32
  SDL windows (gdidemo, sameboy, term).
- **A WM window opens/dismisses** (MessageBox, `#32770` dialogs, comdlg32
  file dialogs, wm.c `ctxmenu`/popups) → `wait win`/`wait nowin TITLE`. Real
  windows are visible in `wmctl list`, so this uses the 0083 primitive.
- **In-surface control text lands** (typed into an EDIT then read; a listbox
  refreshes; a volume STATIC updates) → `wait text LABEL SUBSTR`. This is the
  robust fix for the classic `wmctl key …; sleep 1; wmctl gettext …`: kernel key
  events are drained then dispatched one-message-per-loop-iteration, so the poll
  is exact where the sleep was a guess.
- **Owner-initiated resize** (winmine difficulty, fileman/notepad reflow where
  the geometry IS the assertion) → a bounded `wmctl list | grep WxH` poll.
- **Async side effects landing in a file or the clip slot** (openwith's spawned
  launcher, calc/notepad Copy, term paste) → a bounded `clip -o`/`grep`/`[ -s ]`
  poll — a condition poll, not a fixed sleep.
- **DROP** where a sleep only gated a stdout print and the next command is
  another agent op (the loop serves one agent request then dispatches one queued
  message per iteration, so the prior WM_COMMAND lands first) or where ops are
  FIFO in the one input ring (paint's drawing sequence).

### What stays an annotated `sleep` (the 0083 rule — genuine timing subjects)

The key finding, hit independently in three files: **the agent tree resolves
HWNDs, not menu items.** `agent_find` (user32.c) walks only windows, so an
in-surface `TrackPopupMenu` / menu-BAR dropdown item is *clickable* (AQ_CLICK
posts by label) but *not gettext-able* — `wait label`/`text` (AQ_GETTEXT) can't
observe it opening/closing. So in-surface menu open/close settles have no wait
signal and stay annotated (calc's Edit menu, winmine's Options bar, fileman/
ctxmenu/recycle TrackPopupMenus). Same for: pixel-only render settles before a
`wmctl shot` (winmine gameplay, paint canvas), the per-line ` focus ` marker in
a dialog tree (user32 session B — tree-only, not label/text), a WM_TIMER clock
that must advance a real second (ctlpanel), double-click detection windows,
coarse wm.c desktop `.icons` re-read ticks (recycle/openwith), and negative
"nothing happened" checks. Every kept sleep now carries a one-line reason.

## Verification

Each converted file run green individually (mine 2–3× for stability where I
dropped inter-op sleeps); assertions and `==markers` are byte-for-byte
unchanged in all 14 (only the boot-script arrays moved). Full kernel suite
(parallel, so also the 0081 contention check): `node tests/kernel/run.js` — **58
passed, 0 failed** (385s). `os/wmctl.c` recompiles clean; the new
`wait` routing is additive (existing `wait win/…` unchanged). Image bumped v73→
v74 (wmctl.c is a seeded bake input) and the fixture rebaked.

Work split: user32/gdi32/openwith/calc/fileman/notepad/clipboard/winmine/
ctlpanel/paint converted directly; ctxmenu/fileman_nav/fileman_ops/recycle via
parallel subagents against the same spec (each self-verified, diffs reviewed —
no assertion touched).
