# 0154 — Agent-tree waits: wmctl wait label/text + convert the win32-app e2e sleep class (0083 residue)

- **Status**: open
- **Design**: this file (spawned from `todos/0083`)

## Goal

0083 landed `wmctl wait` over the WM window list (`win`/`nowin`/`count`/
`atleast`/`gone`/`flag`/`noflag`/`seq`) and retired the sleep-sync class in the
**pure-WM** kernel e2es (wm_service, snap, saver, cursor) and the browser
`os-*.mjs` files. It deliberately left the **win32-app** e2es untouched: their
sleeps mostly wait for *in-app control* state — a dialog's listbox refreshing,
an EDIT's text landing, a MessageBox opening/closing — which the WM window list
can't see. Those apps DO expose that state through the win32 agent tree
(`wmctl tree` / `wmctl gettext`, served per-process by user32 over
`/run/win32/agent.<pid>.sock`, todos/0058), so the fix is a second wait
primitive over that channel, then a file-by-file conversion.

Affected files (sleep counts at 0083 close): `test_fileman_ops_e2e.js` (55),
`test_recycle_e2e.js` (52), `test_ctxmenu_e2e.js` (43), `test_user32_e2e.js`
(39), `test_fileman_nav_e2e.js` (20), `test_paint_e2e.js` (18),
`test_notepad_e2e.js` (17), `test_ctlpanel_e2e.js` (17), `test_clipboard_e2e.js`
(17), `test_winmine_e2e.js` (15), `test_calc_e2e.js` (12), `test_fileman_e2e.js`
(9), `test_openwith_e2e.js` (8), `test_gdi32_e2e.js` (2).

## Plan

- Add `wmctl wait label LABEL [MS]` / `wmctl wait nolabel LABEL [MS]` and
  `wmctl wait text LABEL SUBSTR [MS]`: poll the agent tree (the existing
  `agent_scan`/`AQ_TREE`/`AQ_GETTEXT` machinery in `os/wmctl.c`) until a widget
  with that label exists / is gone / contains SUBSTR. Same failure-deadline
  semantics as the 0083 window waits (exit 1 on timeout, ~30ms poll). `label`
  matches the `wmctl click LABEL` resolver so tests key the wait on the same
  string they later click.
- Dialogs that surface as real WM windows (MessageBox, DialogBox `#32770`)
  can already use the 0083 `wait win`; prefer that where it applies. Reserve
  the agent-tree wait for in-surface control changes.
- Convert file by file (each independently landable, per 0083). Keep genuine
  timing subjects (negative "nothing happened" checks; coarse desk/`.icons`
  re-read ticks; pixel-histogram render settles with no single marker) as
  annotated `sleep`s — the 0083 rule.
- Bump `image.json` `version` (wmctl.c is a seeded bake input) and rebake the
  fixture.

## Acceptance

- No `sleep N` used purely as a *synchronization* primitive in the converted
  win32-app files (bounded-timeout condition polls / annotated timing subjects
  are fine).
- The converted files pass under load (the 0081 contention scenario), and the
  full kernel suite stays green.
