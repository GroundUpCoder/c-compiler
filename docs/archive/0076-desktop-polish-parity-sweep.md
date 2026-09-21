# 0076 — desktop polish parity sweep

- **Status**: done (2026-07-11) — sweep complete; room-by-room
  have/partial/missing table + rejection ledger in
  `logs/2026-07-11/0076-desktop-polish-parity.md`. Filed **0101–0107**
  (0101 taskbar bar-menu/Show Desktop/clock date, 0102 window system
  menu + keyboard move/resize, 0103 desktop icon rename-in-place, 0104
  user32 dialog keyboard, 0105 pointer cursor shapes, 0106 fileman
  navigator v2, 0107 Paint accessory), slotted behind 0098 at the tail
  of the desktop-polish cluster. Gaps already owned were
  cross-referenced (0049/0051/0077/0089–0096/0098/0088), not
  re-filed; no feature code in this turn, per the item's discipline.
- **Design**: `todos/WM.md` "The desktop shell"; `todos/WIN32.md`. The
  repeatable-sweep format is established by todos/done/0033 (bug sweeps);
  this is its **feature-parity** counterpart, not a defect hunt.

## Goal

A repeatable curation turn whose whole output is **newly-scaffolded
numbered items**: enumerate the desktop-shell affordances a real
Win95/Win7 desktop has that ours doesn't yet, and file the worthwhile
ones into the queue. Where the bug sweeps (0033/0039/0064/0073) find
*divergence from correct behavior*, this finds *missing polish* — the
class that start-menu-restyle (0078) and desktop multi-select (0077)
fell into precisely because nothing was tasked with looking for them.

This is NOT `queue.js --reflection`. Reflection is system-owned queue
curation across the whole repo; this is a scoped, human-triggerable
feature-ideation pass over the desktop shell that *emits* ordinary items.

## Method

Walk the shell surface against a reference mental model (Win95 first,
then Win7/Aero), room by room, and for each affordance record: have it /
partial / missing. Rooms:

- **Start menu** — program groups / All Programs flyout, search box,
  pinned + recent (MRU), Run…, power/lock, jump lists (→ 0078 owns the
  current gap; note anything 0078 descopes).
- **Desktop** — multi-select + drag-move + arrange/auto-arrange (→ 0077),
  right-click context menu (New ▸, Sort by, Refresh), rename in place,
  wallpaper/theme picker (0049 owns wallpaper), icon spacing/grid.
- **Taskbar** — right-click menus, window grouping, tray/clock tooltip,
  Show Desktop, quick launch, window preview (0063 owns Aero Peek).
- **Windows** — snap/aero-snap, shake-to-minimize, double-click-edge
  maximize, system menu (Alt+Space), keyboard move/resize.
- **Common dialogs / controls** — tab order (0058 descope), context
  menus on edit fields, tooltips, keyboard mnemonics.
- **File manager** — rename/delete/copy/cut/paste, selection, properties
  (0073 records fileman is launcher-only today).

## Discipline

- Output is `queue.js add` calls, one per worthwhile affordance, each
  pointing at the relevant design doc; NOT a hand-maintained wishlist in
  this file (those drift — see logs/2026-07-10/todos-single-source.md).
- Skip anything an existing open item already owns; cross-reference it
  instead of duplicating.
- Descoped/rejected ideas get a one-line "considered, not now, because…"
  in the dev log — not silent omission.
- This item does **not** implement anything. It also does not create
  another parity-sweep item; re-triggering the cadence is a human call.

## Acceptance

- Dev-log entry: the room-by-room have/partial/missing table + the
  scoped/rejected split with rationale.
- The worthwhile gaps exist as new open items (`queue.js check` clean),
  each design-doc-linked.
- No feature code in this item's own turn.
