# 0090 — System clipboard — cross-app copy/cut/paste

- **Status**: done (2026-07-11) — the full plan landed, no descopes: ONE
  kernel-held slot {fmt, bytes} behind CLIP_SET/CLIP_GET (0x0302/0x0303;
  chunked through the kernel page, per-pcb staged so a dying writer can't
  tear it; fmt 1 = UTF-8 text, tagged for 0092's file lists); the C
  surface is the real SDL3 clipboard API in __SDL.c over host.js
  `createClipboard` (`__clip_set`/`__clip_get`; kernel via new spawnHooks,
  process-local fallback standalone); user32's clipboard API + EDIT
  WM_COPY/CUT/PASTE re-based onto it (the 0048 $HOME/.clipboard file is
  gone); term grew drag-selection + Ctrl+Shift+C/V (plain ^C stays
  SIGINT); `/bin/clip` (os/clip.c, seeded, image v51) is the shell
  bridge. Non-goals stayed non-goals (recorded here + SDL3.md's clipboard
  section: history/OLE/host-browser integration — no follow-up items
  needed; 0092 already owns the file-list format). Acceptance green both
  ways: tests/kernel/test_clipboard_e2e.js (15 checks incl. survives-
  writer-exit + ~170KB chunking) and the os-shell.mjs notepad→notepad
  Ctrl+A/C/V/X leg. Dev log: logs/2026-07-11/0090-clipboard.md.
- **Design**: `todos/WIN32.md` (USER32 surface), `todos/KERNEL.md` (the
  cross-process control plane owns the shared clipboard state). Implements the
  Win32 clipboard API in `os/win32/user32.c` over a kernel-held buffer; wires
  the EDIT control (notepad) and the terminal.

## Goal

There is no system clipboard: copy/paste can't cross windows, and the Win32
`OpenClipboard`/`SetClipboardData`/`GetClipboardData` calls the apps expect
aren't backed by anything. This is the single most "it's a real OS" enabler —
notepad, the EDIT fields, fileman file-ops (0092), and edit-field context
menus (0091) all want one shared clipboard. Ship a real one.

## Plan

- **Kernel-held store** — one clipboard buffer owned by the control plane
  (`kernel.js`), not per-process, so it survives the owning window closing
  (Win95 semantics). CF_TEXT first; a format tag so CF_BITMAP/file-list
  (0092's cut/copy of files) can be added later.
- **Win32 API** — implement `OpenClipboard/EmptyClipboard/SetClipboardData/
  GetClipboardData/CloseClipboard/IsClipboardFormatAvailable` in
  `os/win32/user32.c` as thin RPCs to the kernel store. `WM_COPY/WM_CUT/
  WM_PASTE` for the EDIT control.
- **Wire the EDIT control** — Ctrl+C/X/V in the standard EDIT (notepad, all
  dialog text fields) go through the store; selection → CF_TEXT.
- **Terminal bridge** — term copy/paste (0020) reads/writes the same store so
  text moves between GUI apps and the shell.

## Non-goals (record, don't build)

- Clipboard *history*/clipbook viewer — one slot, like Win95. A viewer could
  be a later applet.
- OLE / delayed rendering / `WM_RENDERFORMAT` — set the bytes eagerly.
- Host-browser clipboard integration (paste from outside the OS) — separate
  concern; revisit on demand.

## Acceptance

- Headless: a test app `SetClipboardData(CF_TEXT,...)`, a *second* process
  `GetClipboardData` reads it back verbatim after the first exits.
- Browser (`os-shell.mjs`): select text in one notepad, Ctrl+C, Ctrl+V into a
  second notepad — the text appears; Ctrl+X removes it from the source.
