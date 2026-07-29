# 0429 — win32 DnD landing: de-stub DragAcceptFiles/DragQueryFileW/DragFinish/DragQueryPoint, WM_DROPFILES, fileman as source+target

- **Status**: open
- **Design**: `WM_DROPFILES` as the app-facing API (the OLE *legacy* path), over 0428's transport.

## Goal

Land 0428's kernel drag session in the win32 layer and in fileman, so jku's actual ask works:
**drag a file from one gucOS window into an open fileman window and have it move/copy there.**

🔴 **HARD-BLOCKED ON `todos/0428`.** Every primitive below consumes 0428's protocol. Do not start
this before 0428 has merged — you would be wiring to opcodes that do not exist yet.

**Scope note (build-to-the-goal):** de-stub the API for **any** window that asks for drops, not just
fileman. fileman is the first customer and the acceptance case; it is not the scope.

## Context you need

- **Why `WM_DROPFILES` and not OLE:** full OLE drag-and-drop is `IDataObject` + `IDropSource` +
  `IDropTarget` + a COM-marshalled modal drag loop. We have no COM. `WM_DROPFILES`/`HDROP` is the
  shell-only, files-only, one-way legacy path — which is exactly our first customer, and
  `os/win32/include/shellapi.h` **already declares the whole surface**. Adopt it; do not build OLE.
- **The four functions are HONEST no-op stubs**, `os/win32/shell32.c:118-135`, guarded by a comment
  that names the gap: *"the kernel has no DnD transport into surfaces (the desktop's 0067 drop lands
  FILES in /root/Desktop, not messages) — so accepting is a no-op and no WM_DROPFILES ever arrives.
  Queries answer 'no files' honestly rather than faking a drop."*
  🔴 **Once 0428 lands, that comment is FALSE. Delete it in this ticket** — a true comment that
  quietly becomes false is worse than no comment.
- **The payload parser already exists.** The 0090 clipboard format-2 file list is `"cut\n"`/`"copy\n"`
  then one absolute path per line, and **`SHClipPath(buf, i)` already parses exactly this format**
  (`os/win32/include/shellapi.h:32`). ⚠️ These verbs are in **`shellapi.h`, NOT `os/fileops.h`**.
  ⇒ `DragQueryFileW` walks the list via `SHClipPath`. **Do not write a second parser.**
- **`os/win32/fileman.c` currently has ZERO drag/drop code.** Verified: one case-insensitive match
  for `drag|drop` in the whole file, at `fileman.c:246`, and it is the unrelated
  `/* drop the oldest */` history-ring comment. You are adding both halves from nothing.

## Plan

1. **`os/win32/shell32.c`** — de-stub all four:
   - `DragAcceptFiles(hwnd, accept)` → `WMP_REQ_DRAG_ACCEPT`, setting the accepts-drops bit on the
     surface record.
   - `DragQueryFileW(drop, index, buf, n)` → walk the textual list with `SHClipPath`. Preserve the
     real win32 contract: **`index == 0xFFFFFFFF` returns the file COUNT**, and a NULL/zero buffer
     returns the required length rather than copying.
   - `DragQueryPoint(drop, p)` → the drop point from `EV_DROP`, returning whether it fell in the
     client area.
   - `DragFinish(drop)` → free the handle.
   - **Delete the "no DnD transport" comment.**
2. **`os/win32/user32.c`** — turn `EV_DROP` into a real **`WM_DROPFILES` (0x0233)** posted to the
   **child HWND under the drop point** (not blindly to the top-level window), with an `HDROP` whose
   lifetime the app ends via `DragFinish`. Leaking an `HDROP` per drop is a real failure mode —
   test it.
3. **`os/win32/fileman.c`** — **both halves**:
   - **source**: press + slop on a listview item, build the file list from the selection using
     `SHClipSetFiles`' format, then `WMP_REQ_DRAG_START`. Honour a multi-selection.
   - **target**: `DragAcceptFiles(TRUE)`; on `WM_DROPFILES`, **`SHFileMove` same-volume /
     `SHFileCopy` otherwise**, then refresh the view.
   - Get the ugly ones right: **drop onto its own source directory** (must be a no-op, not a
     self-copy), drop onto a **subdirectory row** vs. the listview background, name collision
     (`SHPasteDest` already resolves this — reuse it), and a drop that fails partway.
4. **`tests/browser/os-dnd.mjs`** — an end-to-end browser test in the style of the existing 0067
   `os-drop.mjs`.

## Open questions inherited from 0428

Copy-vs-move semantics and the modifier-key convention are settled **in 0428's design pass**. Read
0428's `Design` line before you implement step 3 — do not decide it a second time here.

## Acceptance

- All four `shellapi.h` DnD entry points are implemented; **no stub remains and the "no DnD
  transport" comment is gone**.
- Dragging a file from one fileman window into another moves it (same volume) or copies it
  (otherwise), and the destination view refreshes.
- Every edge case in Plan (3) is covered by a test, including drop-on-own-directory and the
  `HDROP` lifetime.
- `tests/browser/os-dnd.mjs` passes in the full browser sweep.
- Full kernel suite green, full browser sweep green, **artifact tallied** (`recorded == total` is
  not enough — tally `results[].status`; if `carried > 0` / `runs > 1` / a `filter` is set, report
  the **first full run's** numbers). `node tests/todos/run.js` 5/5.
- ⚠️ A full browser sweep rewrites 3 tracked `logs/` PNGs and drops 1 untracked one. **Restore them
  before you close.**
