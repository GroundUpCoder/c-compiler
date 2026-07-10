# 0076 — desktop polish parity sweep (curation turn, no code)

The feature-parity counterpart to the 0033/0039/0073 bug sweeps: walk the
desktop shell room by room against a Win95-first (then Win7) reference
model, record have/partial/missing, and give every worthwhile gap a
numbered owner. Output of this turn: **items 0101–0107 filed** (slotted
right behind 0098, the tail of the desktop-polish cluster), plus the
rejection ledger below. No feature code, per the item's own discipline.

Context: half the sweep's expected yield had already been pre-filed on
2026-07-10 as the 0089–0096 QoL cluster (commit 13ccad5) — clipboard,
context menus, fileman ops, recycle bin, sounds, snap, screensaver,
ctlpanel hub. This turn verified the *rest* of the surface in code
(three parallel read-only surveys over os/wm.c + kernel.js wm seam,
os/win32/user32.c + PORTS.md, os/win32/fileman.c + the done items) and
filed what nothing owned.

## Room-by-room table

Verdicts verified against source, not from memory; cites are in the
filed items. **Owner** = the queue item (existing or new) that owns the
gap; — = have, or rejected (see ledger).

### Start menu

| Affordance | State | Owner |
|---|---|---|
| Program groups / cascading flyouts | have (0078) | — |
| Run… | have (0078) | — |
| Keyboard nav + type-ahead | have (0078) | — |
| Start chord (Ctrl+Esc) | have (0078) | — |
| Search box, pinned, MRU/recents | missing | 0098 |
| Shut Down / power row | missing | 0051 (hook recorded in 0078) |
| Jump lists / tiles / fs search | missing | rejected (0078 non-goals stand) |

### Desktop

| Affordance | State | Owner |
|---|---|---|
| Icon grid + double-click launch | have (0029/0066) | — |
| Host→desktop file-drop ingest | have (0067; host-side only by design) | — |
| Single/multi-select, marquee, drag-move, arrange, keyboard | missing | 0077 |
| Right-click menus (New ▸ / Sort by / Refresh; icon menu) | missing | 0091 |
| Rename-in-place (F2 / click-pause) | missing — 0077 non-goals it | **0103 (new)** |
| Delete-to-trash from desktop | missing | 0093 |
| Wallpaper | missing | 0049 |
| Theme/appearance picker | missing | 0089 (Display applet) |
| Icon spacing/grid config | hardcoded #defines | rejected |

### Taskbar

| Affordance | State | Owner |
|---|---|---|
| Window buttons + overflow shrink + clock | have (0031) | — |
| Hover thumbnails (Aero Peek) | have (0063) | — |
| Minimize/restore animations | have (0063) | — |
| Right-click a window button (Restore/Min/Max/Close) | missing | 0091 |
| Right-click empty bar (Cascade/Tile/Min-All/Properties) | missing | **0101 (new)** |
| Show Desktop affordance | missing | **0101 (new)** |
| Clock date tooltip | missing (clock is draw-only, no hit test) | **0101 (new)** |
| Quick Launch strip | missing | rejected (post-95; Start+desktop cover it) |
| Notification tray + balloons | missing | rejected (no producer apps yet) |
| Button grouping (Win7) | missing | rejected (overflow shrink suffices) |

### Windows

| Affordance | State | Owner |
|---|---|---|
| Drag-move, frame resize, title dbl-click max, min/max/close boxes | have (kernel chrome, 0025/0030) | — |
| Cycle chord, z layers, fixed-size scaling, shadows/alpha/glass | have (0032/0038/0024/0063) | — |
| Aero Snap (drag-to-edge) + Win+arrow chords | missing | 0095 |
| System menu (Alt+Space) + keyboard Move/Size | missing (kernel drag is pointer-only) | **0102 (new)** |
| Shake-to-minimize | missing | rejected (niche; revisit with 0095 if cheap) |
| Double-click-edge vertical maximize | missing | rejected (obscure) |

### Common dialogs / controls

| Affordance | State | Owner |
|---|---|---|
| Dialogs from templates, MessageBox modal, menus, accelerators | have (0058/0068) | — |
| comdlg32 file dialogs | have (comdlg32.c) | — |
| EDIT selection + WM_COPY/CUT/PASTE + caret; BUTTON focus rect | have | — |
| Clipboard *backing store* (cross-process) | file-clipboard only | 0090 |
| Tab order (IsDialogMessage is Esc-only; modal loop skips it) | missing (0058 descope) | **0104 (new)** |
| Alt+mnemonics + underline render | missing | **0104 (new)** |
| Default-button Enter / Esc-in-modal | missing/partial | **0104 (new)** |
| Edit-field right-click menu | missing | 0091 |
| Cursor shapes (I-beam, resize arrows, wait) | stubs; browser default arrow everywhere | **0105 (new)** |
| Tooltips control | missing | rejected (zero port demand — PORTS.md is empty) |
| LISTBOX PageUp/Down | missing | folded into 0104 |

### File manager

| Affordance | State | Owner |
|---|---|---|
| Navigate/Up/path bar/Go; openwith + "With" picker | have (0048/0072) | — |
| rename/delete/copy/cut/paste/mkdir/properties + confirms | missing | 0092 |
| Details columns (size/date), status bar, sort/hidden toggles | missing (refill discards its stat) | **0106 (new)** |
| Multi-select (LISTBOX is single-select) | missing | **0106 (new)** |
| Enter-opens, F5/external refresh, Back history | missing (0073 seeds Enter) | **0106 (new)** |
| Drag out of / between fileman panes | missing | rejected for now (0092 non-goal stands; DnD is a follow-up after ops) |

### Accessories (app surface)

| Affordance | State | Owner |
|---|---|---|
| term, calc, notepad, fileman; Games incl. winmine | have (seeded, image v48) | — |
| Paint | missing | **0107 (new)** |
| NES core (games growth) | missing | 0088 |
| WordPad, CharMap, Clock applet, media apps | missing | rejected (ledger) |

## Filed items (the sweep's output)

- **0101** taskbar polish: empty-bar context menu (Cascade/Tile/Min-All/
  Properties), Show Desktop strip, clock date popup. After 0091 (popup
  look). Also unlocks wm.c right-button routing (today every button is
  treated as button 1).
- **0102** window system menu + keyboard move/resize: Alt+Space via the
  EV_CYCLE chord pattern (new WMP EV_SYSMENU, MUST-MATCH trio), wm.c
  popup, arrow-key Move/Size modes. The window-management accessibility
  story. After 0091.
- **0103** desktop icon rename-in-place: F2/click-pause inline editor on
  the icon label, rename(2) under /root/Desktop. After 0077 (needs its
  selection state); 0077 explicitly non-goaled it.
- **0104** user32 dialog keyboard: real IsDialogMessage (Tab order via
  GetNextDlgTabItem), Alt+mnemonics with underline, default-button
  Enter, Esc in the modal loop, LISTBOX PageUp/Down. The 0058 descope
  coming due; every port dialog is keyboard-dead today.
- **0105** pointer cursor shapes: chrome resize cursors from the
  kernel's existing hit test + per-surface cursor state for SDL/user32
  (CSS cursors — the "native browser cursor" deviation stands, this
  picks *which*). Promotes the SDL3.md Mouse backlog line.
- **0106** fileman navigator v2: details columns, multi-select LISTBOX,
  Enter-opens, F5/external refresh, status bar, sort/hidden toggles,
  Back history. After 0092.
- **0107** Paint accessory: native gdi32 paint.c (ReactOS mspaint is
  C++ → excluded, the Solitaire rule), pencil/shapes/fill/palette, BMP
  via comdlg32, .bmp openwith, Accessories menu seed.

## Considered, not now (the rejection ledger)

- **Quick Launch strip** — post-95 shell (IE4); desktop icons + Start
  cover launching; Show Desktop (its main survivor) rides 0101.
- **Notification tray / balloon tips** — nothing would populate it; no
  background-app notification producer exists. Revisit when one does.
- **Taskbar button grouping** — Win7-class; the 0031 overflow shrink is
  adequate at realistic window counts here.
- **Shake-to-minimize** — niche Win7 delight; needs drag-velocity
  tracking in the kernel for one gesture. Note left in 0095's court if
  it falls out cheap there; not worth its own item.
- **Double-click window edge → vertical maximize** — obscure even on
  Windows; the frame's down-starts-resize model would need a delay.
- **Tooltips control (user32 TOOLTIPS_CLASS)** — PORTS.md aggregate
  demand is currently ZERO symbols; no port asks for it. The only
  wanted tooltip (taskbar clock) is wm.c-side and rides 0101.
- **Icon spacing/grid configurability** — compile-time #defines are
  fine until a theme system (0089 Display applet) wants them.
- **WordPad** — notepad + vi cover editing; rich text (RTF) is a
  rabbit hole with no other consumer.
- **Character Map** — single seeded mono font; low value until fonts
  grow.
- **Clock accessory / Date-Time applet** — the 0101 clock popup covers
  the daily need; a Date/Time applet can grow in the 0089 hub on
  demand (there's no RTC-set concept in-OS anyway).
- **GUI Task Manager** — busybox top/ps over /proc (0043) serve the
  need in term; a System applet lives in 0089's plan already.
- **Sound Recorder / Media Player / Volume Control app** — no audio
  *input* path exists; output volume lives in ctlpanel (0089 keeps it).
- **Solitaire / FreeCell** — C++ (the recorded ReactOS exclusion);
  card games would need a from-scratch rewrite nothing justifies while
  0088 (puNES) owns games growth.
- **Win key as Start chord** — browsers eat Meta; the 0078 Ctrl+Esc
  decision stands. Win+arrow inside 0095 is that item's problem
  (it may need the same fallback chord treatment).
- **Jump lists, tiles, filesystem search in Start** — 0078's recorded
  non-goals; nothing changed.
- **Lock screen / user switching** — no multi-user concept in the OS.
- **Fileman drag-and-drop (out of / between panes)** — 0092 records
  DnD-within-fileman as a follow-up after keyboard/menu ops; dragging
  *out* to the desktop belongs to the same future item. Deliberately
  not filed until 0092 lands and shapes it.

## Method note (for the next parity turn)

Three parallel read-only surveys (wm.c+kernel.js chrome/chords,
user32+PORTS.md, fileman+done-item descopes) against the room list in
the item, then ownership triage against `queue.js list`. The 0089–0096
pre-filing meant the sweep's marginal yield was the *seams the cluster
items had explicitly non-goaled* (0077's rename, 0058's tab order,
0092's navigator half) — worth checking non-goal sections first next
time; they are where owned-looking gaps hide. Re-triggering the cadence
stays a human call (the item's own rule: no self-perpetuating sweep).
