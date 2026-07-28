# SOFTWARE-NATIVE.md — the software manager, native-Win32 redesign, on a real SysListView32

- **Status**: design pass, 2026-07-28 — no implementation; tickets to be
  queued by the master coordinator after review (ids deliberately NOT
  allocated here, per the 0358 cross-ref rule — this doc is the
  COMMAND-ALTERNATIVES.md-style topic-doc precedent from the 0337/0338
  split).
- **Design inputs**: `os/win32/software.c` (the app being redesigned),
  `todos/WIN32.md` (veneer conventions: fail-loud 0211, A/W, "one
  toolkit" comctl32 stance), `todos/0131-ctlpanel-restyle.md` (the same
  shape of ask, deferred), `todos/0130-default-programs-applet.md`
  (re-opened; a direct customer of the new control),
  `todos/done/0106-fileman-navigator-v2.md` (the existing hand-rolled
  details view), `todos/OS.md` + `todos/TOOLKIT.md` (the agent-drivable
  pillar).

## 0. The ask, and what it actually means (Reading A vs B)

jku asked to "redesign the software manager UI to use win32 instead."
The premise had to be verified first, because **the software manager GUI
is already a Win32 app**: `os/win32/software.c`, 972 lines,
`#include <windows.h>`, a real WndProc, one HWND per package card,
`wmctl`-drivable by design (ticket #81). There is no other
software-management surface to be "moved to win32": `os/image.json`
seeds exactly one GUI (`/usr/bin/software`, plus its Accessories menu
link and Desktop link), and `gucman` (`os/gucman/gucman.c`) is the
CLI-only engine underneath it by locked contract. So Reading B ("jku
means some other surface") collapses under verification — every reading
lands back on software.c.

**This design is built to Reading A: the ask is about IDIOM, not
substrate.** software.c uses the Win32 *API* but paints a modern
*storefront*: its own header comment says "one fixed 640x460 window.
White header (title, count subtitle, Refresh), a card list (one
'PkgCard' child per package: name+version, summary, colored state, one
Install/Remove button)". White background, gray hairline separators,
green/blue/orange state text, an app-store card per package — it is the
one app on the desktop drawn in a 2020s App-Store aesthetic while
everything around it (taskbar, Start menu, ctlpanel, fileman, winmine,
the dialogs) speaks classic native Win32: COLOR_BTNFACE chrome, sunken
wells, menu bars, status bars. "Use win32 instead" = **make it look and
behave like a native Win32 program** — the Add/Remove-Programs shape: a
columned list of packages in native chrome, a menu bar, a status bar,
selection + one action button.

If jku corrects this to Reading B, nothing below is wasted: the control
work (§3) is app-independent, and any new Win32 front-end over gucman
would be software.c§2's rebuild with a different z-order of the same
parts.

## 1. The scoping crux: no list-view control exists

Verified inventory of the control estate today:

- `os/win32/user32.c` registers exactly **BUTTON, STATIC, EDIT,
  LISTBOX, SCROLLBAR** (`ensure_builtin_classes`, user32.c:5187).
  COMBOBOX — contrary to easy assumption — is **not** registered: it
  appears only in the dialog-template class table with a "not grown yet
  (0211)" comment, and a template asking for it takes the fail-loud
  path.
- `os/win32/comctl32.c` (214 lines) provides **only the status bar**
  (`STATUSCLASSNAMEA`); `InitCommonControls` is an honest no-op ("one
  toolkit, nothing to register").
- **No SysListView32, no SysHeader32, no toolbar, no treeview.**

A native list-with-columns look therefore forks into:

- **Path 1 — build the real control**: SysListView32 (report view) +
  SysHeader32 in comctl32, then rebuild software.c on it.
- **Path 2 — approximate**: owner-draw/space-padded LISTBOX, fake
  header, software-manager-local.

## 2. Recommendation: Path 1. The list-view is a platform gap, not a software-manager detail

The core principle (CLAUDE.md, binding): a capability that naturally
pertains to the goal gets implemented properly, at the right level of
generality — "no current customer" is not a valid scope cut. Here we
don't even need the principle's teeth, because **the customers already
exist and have each hand-rolled an approximation**:

1. **fileman** (0106, shipped): details columns are `%-28s %10s %s`
   space-padding into a mono-font LISTBOX — the code comment documents
   itself as a workaround: *"The mono font makes space-padding an honest
   column (LB_SETTABSTOPS-free, 0106)"*. It works only because the font
   is mono; it re-sorts by rebuilding every row string; the header is a
   menu, not a clickable column.
2. **comdlg32's file dialog** (0048): another LISTBOX directory listing
   that would be a report view anywhere else.
3. **0130 Default Programs applet** (open, re-opened 2026-07-27 by
   jku's command-alternatives ruling): its plan literally reads "a
   LISTBOX of" key→command associations — two-column data (plus the
   cmdalt shadow-diagnosis column from COMMAND-ALTERNATIVES.md §8)
   about to be flattened into padded strings because that is all that
   exists.
4. **This redesign** — the fourth customer.
5. **0131 ctlpanel restyle** (deferred) plausibly wants it for a
   category/detail hub.
6. **The port corpus**: PORTS.md shows zero listview demand today only
   because the corpus (winmine/notepad/calc) was chosen to fit the
   veneer. The next tier of classic raw-C Win32 apps — regedit,
   taskmgr, anything Explorer-shaped — is listview/treeview-first.
   Building the control converts a whole class from "impossible" to
   "PORTS.md tail work".

Path 2 would add a **fourth** hand-rolled column hack, and the fifth
(0130) is already queued behind it. The escape hatch ("genuinely high
complexity AND misaligned with goals") does not apply on either horn:
complexity is moderate — LISTBOX, the nearest sibling, is ~330 lines;
the whole menu engine extraction (menucore.c) is 578; comdlg32 is 717;
a report-view listview + header lands in that band, out of patterns
(selection marks, notify, draw_well, freetype text) that all exist —
and alignment is total: Win32 was chosen as THE toolkit precisely
because its widget set is the OS's widget set (WIN32.md §"Why Win32").

**One honest counterpoint, addressed head-on**: strict Win95 fidelity
would argue for Path 2 — the *actual* Win95 Add/Remove Programs was a
tabbed dialog with a plain LISTBOX and an "Add/Remove…" button. If the
goal were pixel-faithful 1995, the LISTBOX approximation is the
authentic artifact. But the estate's "native" envelope already spans
eras deliberately (Aero effects 0063, Win7 snap 0095, XP-style Start
cascades 0132), 0131 explicitly aims XP/Win7 for ctlpanel, and the
columned report view is the native idiom of every Windows utility from
2000 on (Add/Remove 2000, Task Manager, Explorer details). The
platform investment and the aesthetic target point the same way.

## 3. Ticket 1 — the control work (comctl32: SysListView32 + SysHeader32)

New code lives in `os/win32/comctl32.c` (or a sibling `listview.c` TU
added to `lib.json` if comctl32.c grows past taste — the menucore.c
precedent of one facility per TU; either way it is veneer-side, zero
kernel change). Registration: `InitCommonControlsEx(ICC_LISTVIEW_CLASSES)`
registers both classes (real comctl32 semantics); plain
`InitCommonControls()` registers them too (it is the "register
everything" legacy entry — and the corpus calls it). comctl32.c's
header comment ("one toolkit, nothing to register") gets updated — it
stops being true the moment comctl32 owns real classes.

### Scope — report view, properly; other views deliberately out

- **LVS_REPORT only.** Icon/small-icon/list/tile views have no customer
  and no ImageList substrate (icons are stub handles estate-wide); a
  creation style asking for them takes the 0211 fail-loud path
  (`WIN32_UNSUPPORTED`), not a silent fallback. This is the narrow
  escape hatch used honestly: those views are real complexity with no
  alignment — the report view IS the capability every customer above
  needs.
- **SysHeader32 is a real, separately-registered control** (the Windows
  architecture: the listview creates its header as a child). It owns
  column layout, paints BTNFACE button-style segments (draw code shared
  with the existing button bevel idiom), fires HDN_ITEMCLICK, and
  supports divider drag-resize (cursor feedback can be a later polish;
  the drag itself is in scope — it is half the "native feel" of a
  report view). Reusable alone; fileman's migration (§6) gets
  click-to-sort headers for free.
- **Message surface** (ANSI generic + W entries per the corpus
  convention — LVITEMW/LVCOLUMNW translate at the message choke, the
  WM_SETTEXT precedent):
  `LVM_INSERTCOLUMN/DELETECOLUMN/GETCOLUMN/SETCOLUMN`,
  `LVM_INSERTITEM/DELETEITEM/DELETEALLITEMS/GETITEMCOUNT`,
  `LVM_SETITEMTEXT/GETITEMTEXT` (subitems),
  `LVM_GETITEM/SETITEM` (text, state, lParam),
  `LVM_GETNEXTITEM` (LVNI_SELECTED/FOCUSED),
  `LVM_SETITEMSTATE/GETITEMSTATE` (LVIS_SELECTED|LVIS_FOCUSED),
  `LVM_ENSUREVISIBLE`, `LVM_HITTEST`, `LVM_SORTITEMS`,
  `LVM_GETSELECTEDCOUNT`,
  `LVM_SETEXTENDEDLISTVIEWSTYLE` (LVS_EX_FULLROWSELECT honored;
  others reported once). `commctrl.h` grows the structs/consts.
- **Notifications** via `WM_NOTIFY`/NMHDR (the define exists; nothing
  in user32 needs to change — it is a SendMessage to the parent):
  `LVN_ITEMCHANGED`, `NM_CLICK`, `NM_DBLCLK`, `NM_RCLICK`,
  `LVN_COLUMNCLICK`.
- **Selection**: single-select and LVS_SINGLESEL first-class; extended
  multi-select included — the marks/anchor/shift-range logic lifts
  directly from LISTBOX 0106 (`lb_mark_range` and friends), and
  fileman's migration needs it.
- **Keyboard/wheel**: arrows/PgUp/PgDn/Home/End, `WM_GETDLGCODE` →
  DLGC_WANTARROWS (the LISTBOX pattern), wheel scroll.
- **Scrollbar**: a REAL vertical scrollbar — an embedded SCROLLBAR
  child managed by the control (the software.c precedent; notify-only
  semantics already exist). NB this deliberately does NOT repeat the
  known LISTBOX divergence ("LISTBOX WS_VSCROLL: no scrollbar is
  drawn", WIN32.md 0211 audit) — the new control ships with its bar
  from day one.
- **Painting**: gdi32 only — `draw_well` sunken frame, per-column
  clipped `TextOut`, full-row COLOR_HIGHLIGHT selection, focus rect on
  the focused row. Right/center column alignment (LVCFMT_*) honored
  (Size columns want right-align).

### The agent surface — the part that must not regress (hard requirement)

Today every package is an HWND whose text is
`"<name> <version> [<state>]"`, so `wmctl tree` sees the catalog and
`wmctl wait label 'punes 1.0 [installed]'` resolves by exact window-text
match. Collapsing the catalog into ONE control would, naively, destroy
all three agent properties (tree visibility, label waits, label
clicks). Verified mechanics that shape the fix:

- `wmctl wait label` / `wait text` ride `AQ_GETTEXT` through the same
  label resolver as `wmctl click` (wmctl.c; user32.c `agent_find_ex` —
  exact match on '&'-stripped text, BUTTONs first).
- The tree dump escapes a control's WM_GETTEXT into a one-line
  `text='…'` field **truncated at 160 bytes** (`tree_dump`'s
  `char text[160]`) — a whole catalog cannot live there.
- Menu items are the precedent for non-HWND agent targets: `menu_dump`
  emits them as their own indented lines, and AQ_CLICK/AQ_GETTEXT
  special-case open menus (the 0171 fix). Windows itself does the same
  thing — MSAA exposes listview rows as accessibility children.

So the listview implements the same pillar, generically:

1. **WM_GETTEXT = the content, row-per-line** (the LISTBOX/status-bar
   convention extended): line 0 is the header (`Name | Version | Size |
   Status`), then one line per row with subitems joined `" | "` and the
   `"> "` selection prefix. `wmctl gettext SysListView32:0` reads the
   whole catalog; `wmctl wait text SysListView32:0 'punes | 1.0'` waits
   on any cell flip. (`wait text` takes CLASS:n labels — the resolver
   is shared — so no wmctl change is needed.)
2. **Rows are lines in `wmctl tree`**: a veneer-internal "agent
   children" message (`AQM_DUMPCHILDREN` in win32_internal.h — name
   TBD) that `tree_dump` sends to every window; a control that answers
   returns a malloc'd block of pre-indented lines
   (`lvrow i=3 sel text='punes | 1.0 | 1.2 MB | installed'`) spliced
   under its `win` line, the menu_dump shape. Generic by design: the
   seam is user32↔any-control, so a future treeview (or a retrofitted
   LISTBOX dump) uses it unchanged, and user32 stays ignorant of
   comctl32 internals.
3. **Rows are click/label targets**: a sibling `AQM_FINDLABEL` message
   — `agent_find_ex`, having missed on HWNDs and menus, offers the
   label to each shown control; the listview matches a row by its
   column-0 text (exact, '&'-stripped), selects it (state + ENSUREVISIBLE
   + LVN_ITEMCHANGED + NM_CLICK), and AQ_GETTEXT on the same label
   returns that row's joined line — so `wmctl click punes` selects the
   row and `wmctl wait label 'punes'`-class waits still resolve.

Net: `wmctl tree` after the redesign shows MORE than today (all
columns, not just the card text), waits stay pixel-free and
substring-tight, and clicks address rows by name instead of the
fragile `BUTTON:n` ordinal arithmetic the current e2e has to predict
(test_software_e2e.js's `punesBtn = 2 + sortedIndex` — a known
maintenance trap: the tier-2 Start-menu work already had to re-derive
it once when a header button shifted the ordinals).

### Acceptance for ticket 1

- ctldemo grows a listview pane (columns, selection, sort, scroll,
  notify echo) — the controls acceptance app stays the one place every
  control is demonstrable.
- New `tests/kernel/test_listview_e2e.js` (registered in the kernel
  runner's explicit registry): message-surface round-trips, header
  click → sort, agent legs (tree rows, click-by-row-label, wait text),
  keyboard/wheel/scrollbar.
- `wmctl tree` / gettext output format asserted (it is test-facing,
  like the LISTBOX join).
- Zero `win32: unsupported` reports from the booted app suite
  (the 0211 bar).

## 4. Ticket 2 — software.c rebuilt native (hard-dep: ticket 1)

**What survives untouched (most of the file)**: the entire model + job
engine — catalog fetch/parse (`gucman index` spawn), the install-DB
scan, orphan + baked-package listing, the minBase gate, the job
spawn/tick/end machinery with its capture files and WNOHANG waitpid,
FS_WATCH on the DB dir via RegisterFdWake, the desk-shortcut flag, the
one-job-at-a-time rule. Every locked invariant from the header comment
stands: gucman IS the engine; no synthesized state; offline still lists
the installed set; closing mid-job leaves the crash-safe child alone.

**What changes (the ~350 UI lines)**:

- **Window**: `WS_OVERLAPPEDWINDOW` — resizable now (WS_THICKFRAME +
  min-size guard; the listview and status bar reflow on WM_SIZE). The
  fixed 640×460 storefront existed because the card layout was exact;
  a report view has no such constraint, and resizability is itself part
  of the native idiom (the kernel resize path is proven — term).
- **Chrome**: COLOR_BTNFACE background (the white brush and hairline
  separators go); a **menu bar** — File ▸ Refresh (F5) / Exit, Help ▸
  About Software (ShellAbout); the real **comctl32 status bar**, two
  parts: the live gucman ticker (today's status STATIC), and the
  count readout (today's header subtitle, e.g. "14 applications - 6
  installed"). The `wmctl wait text msctls_statusbar32:0 …` form
  covers both for tests (parts join in WM_GETTEXT already).
- **The list**: one SysListView32, LVS_REPORT | LVS_SINGLESEL |
  LVS_EX_FULLROWSELECT. Columns: **Name | Version | Size | Status**.
  Status cells carry the exact `state_token` strings of today
  (`available`, `installed`, `installed, not in catalog`,
  `needs newer OS`, `built-in`, `installing`/`removing` on the active
  row) — keeping the tokens identical keeps test needles and human
  vocabulary stable. Sort-by-column via LVN_COLUMNCLICK (name default).
- **The detail strip** (between list and buttons): a STATIC with the
  selected package's summary + "Requires: <deps>" — the card's second
  line, relocated; empty when nothing is selected.
- **Actions**: one **Install/Remove BUTTON** bottom-right whose label
  follows the selection (`Install` for available, `Remove` for
  installed/orphan; disabled for built-in / needs-newer-OS / no
  selection / job running — the exact card_sync gating, one button
  instead of N), the **"Install to Desktop"** BS_AUTOCHECKBOX
  bottom-left (unchanged semantics), Refresh living in the menu + F5
  (the dedicated header button goes; `wmctl click Refresh` now resolves
  the menu item — same label, and menu items are already click
  targets). The empty/error **notice STATIC** stays (its exact label
  is a test needle: "Cannot reach the package repository").
- **Double-click** on a row = the default action (NM_DBLCLK → same
  path as the button) — the Explorer idiom.

**Image bump**: software.c, comctl32, user32 all ride the baked blob —
`image.json` version bumps with the landing (the estate rule).

## 5. Test/e2e plan (the existing legs, concretely)

Affected surfaces (verified by grep, not assumed):
`tests/kernel/test_software_e2e.js` (the acceptance file) and
`tests/browser/os-minimal.mjs` leg 2 (installs through this UI, reuses
the BUTTON:n prediction). `test_desk_icons_e2e.js` keys only on the
Desktop glyph — unaffected.

- Card-label waits `wmctl wait label '<name> <ver> [<state>]'` become
  `wmctl wait text SysListView32:0 '<name> | <ver> | … | <state>'`
  (substring over the joined dump — same real-state-flip semantics,
  since the rows are rebuilt from the re-read DB exactly as cards are).
- `wmctl click BUTTON:${punesBtn}` (ordinal prediction) becomes
  `wmctl click punes` (row select) + `wmctl click Install` — no
  ordinals left in either test; the "prediction matches the tree"
  re-verification leg is deleted rather than ported (nothing left to
  predict).
- Scroll-to-reveal legs (`wmctl down $SWID …` on the scrollbar) become
  ENSUREVISIBLE-by-selection or stay as scrollbar pokes on the
  listview's bar — either is pixel-free.
- The tree-dump assertions re-key on `lvrow` lines; the
  `vis=1 … text='Cannot reach…'` notice legs survive unchanged.
- New: a sort-by-column leg, a resize-reflow leg (the window is
  resizable now), and the flake gate (`node tests/flake.js`) after the
  e2e lands, per the estate rule for new e2e legs.
- Suite mapping: `os/` paths already route to kernel + sweep in
  tests/run.js RULES — no new rule needed; the browser boot cost rides
  the existing os-minimal file.
- A **manual human look pass** before any pixel goldens move (the
  golden-rebake lesson) — this is an aesthetics ticket; the human eye
  is the acceptance oracle for the chrome itself.

## 6. Cost estimate (lane-days) and ticket split

| Piece | Est. | Notes |
| --- | --- | --- |
| (a) Control work: SysListView32 + SysHeader32 + commctrl.h + the AQM agent seam in user32 + ctldemo pane + test_listview_e2e | **3–4** | ~800–1000 lines C total; every pattern (marks/anchor, draw_well, notify, freetype text, scrollbar child) has an in-tree sibling to lift from |
| (b) software.c rebuild | **1–1.5** | the model/job engine survives verbatim; ~350 UI lines replaced by ~400; menu/status/dialog idioms all exist |
| (c) Test/e2e updates (software e2e rewrite, os-minimal leg 2, flake gate, image bump) | **1** | mostly mechanical needle rewrites; the ordinal-prediction machinery is deleted, not ported |

**Total: ~5–6.5 lane-days.** Path 2 for contrast: ~2–2.5 lane-days,
after which the platform still has no list-view and 0130 hand-rolls the
fifth approximation.

**Split: two tickets, one follow-on** (order is a hard dependency):

1. **`comctl32-listview`** — §3 entire. Independently landable and
   testable (ctldemo + test_listview_e2e); bumps the image (ctldemo is
   baked).
2. **`software-native-redesign`** — §4 + §5, `blockedBy` ticket 1.
3. *Follow-on (soft, recommended, separately schedulable)*:
   **`fileman-details-listview`** — migrate fileman's space-padded
   columns (and plausibly comdlg32's file dialog) onto the real
   control; retires the 0106 approximation and is the proof of
   generality. 0130 (Default Programs) should also be annotated at
   pickup to build its association list on the new control instead of
   its currently-written "a LISTBOX of" plan.

## 7. What I would NOT do, and why

- **No icon/list/tile listview modes, no LVS_OWNERDATA virtual mode,
  no checkboxes, no column drag-reorder, no ImageList** — no customer,
  real complexity; each is one fail-loud report away from being
  demanded honestly (the 0211 policy is the demand log). This is the
  narrow escape hatch, used with its name stated.
- **No treeview in this pass** — the obvious next control when a
  regedit-class port arrives; the AQM agent seam (§3) is designed so it
  slots in without touching user32 again.
- **No keeping the card storefront as an alternate view/toggle** — the
  no-zombie-fallbacks rule; the redesign replaces, it does not fork.
- **No gucman/engine changes, no concurrent jobs, no in-GUI progress
  synthesis** — the locked division of labor is load-bearing and
  audited by the e2e's real-filesystem assertions.
- **No ctlpanel restyle smuggled in** — 0131 stays its own deferred
  item; it simply inherits a better toolkit when picked up.
- **No bespoke per-app column engine as a "cheaper" middle path** —
  that is Path 2 wearing a mustache; the estate already has three of
  them, which is the evidence file for Path 1, not a pattern to extend.
