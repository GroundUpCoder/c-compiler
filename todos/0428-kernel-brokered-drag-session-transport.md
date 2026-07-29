# 0428 — kernel-brokered intra-guest drag session (WMP_REQ_DRAG_START/ACCEPT + EV_DRAG_*/EV_DROP)

- **Status**: open
- **Design**: kernel-brokered, Wayland-shaped. See "Why this shape" below.

## Goal

jku asked for **intra-guest drag and drop**: drag a file from one gucOS window (or the desktop
icon grid) **into an open fileman window**, and have it move/copy there. This is entirely
guest-internal. It is **NOT** host-to-guest drag — that is `todos/done/0067`, already shipped, and
0067's drop lands *files in `/root/Desktop`*, not *messages into a surface*.

This ticket is the **load-bearing transport**. 0429 (win32 landing) and 0430 (desktop layer) are
wiring on top of it and are blocked on it.

**Scope note (build-to-the-goal):** build the general drag session — an arbitrary source surface,
an arbitrary target surface, a payload, and a full enter/over/leave/drop/end lifecycle. Do **not**
special-case "fileman to fileman" or "files only" because that is the first customer. The payload
happens to be a file list today (below); the session must not assume it forever.

## Why this shape — the design is already decided, do not re-litigate it

Four real-world models were compared:

- **X11 / XDND** — peer-to-peer. The *source* grabs the pointer and does its own hit-testing
  (`XQueryPointer`/`XTranslateCoordinates`), then sends `XdndEnter/Position/Status/Drop/Finished`
  straight to the target. **REJECTED**: it requires every client to enumerate and hit-test other
  clients' windows, which our surface model deliberately does not expose.
- **Windows / OLE** — `DoDragDrop()` + `IDataObject`/`IDropSource`/`IDropTarget`, a modal drag loop
  holding mouse capture, COM-marshalled `DragEnter/Over/Leave/Drop`. **REJECTED** as a model (no
  COM). But its **legacy path — `WM_DROPFILES` + `HDROP`** — is shell-only, files-only and one-way,
  which is exactly our first customer, and our headers already declare it. **ADOPTED as the
  app-facing API** (that is 0429).
- **macOS / AppKit** — `NSDraggingSession`, AppKit owns the loop, `NSPasteboard` carries the data.
- **Wayland** — **the compositor owns the drag**: it holds the pointer grab, hit-tests surfaces
  itself, and sends `wl_data_device.enter/motion/leave/drop` to whatever surface is under the
  cursor, brokering between `wl_data_source` and `wl_data_offer`. **THIS IS OUR SHAPE**, minus the
  mime-type/fd-pipe negotiation — our payload is one existing textual format (below).

The choice is forced by what already exists: **`kernel.js` is already playing the compositor role.**

## What already exists — VERIFIED IN THE TREE at `73c703d9` (do not re-derive; do re-check paths)

🔴 **The scoping pass that produced this ticket named three paths that are WRONG. Corrected here.**

1. **The win32 API surface exists, declaration-only.** `os/win32/include/shellapi.h:10-13` declares
   `DragAcceptFiles`, `DragQueryFileW`, `DragFinish`, `DragQueryPoint`; `:57` defines
   `WM_DROPFILES 0x0233`. All four are **honest no-op stubs** at `os/win32/shell32.c:118-135`, and
   the stub's own comment names this exact gap: *"the kernel has no DnD transport into surfaces
   (the desktop's 0067 drop lands FILES in /root/Desktop, not messages)"*. ⇒ This work is
   **de-stubbing a deliberately-declared surface**, not inventing an API.
2. **The payload format and the file verbs are already built and shipped.** The 0090 clipboard
   format-2 file list is a textual `CF_HDROP` equivalent: a `"cut\n"`/`"copy\n"` header plus one
   absolute path per line. Writer/reader/parser `SHClipSetFiles` / `SHClipLoadFiles` / `SHClipPath`
   and transfer verbs `SHFileCopy` / `SHFileMove` / `SHPasteDest` / `SHFileTrash` are declared at
   ⚠️ **`os/win32/include/shellapi.h:23-38`** — **NOT `os/fileops.h`**, which the scoping pass named
   (that file backs the 0093 trash store). fileman already uses all of it for cut/copy/paste.
   ⇒ **The "what happens on drop" half is DONE. Reuse it verbatim. Do NOT invent a second payload
   format and do NOT build a mime-negotiation layer.**
3. **The kernel already has every primitive a drag broker needs** — ⚠️ **`kernel.js` is at the REPO
   ROOT (9,041 lines), NOT `os/kernel.js`**:
   - the surface map with rects and stacking — `this._surfaces` at **`kernel.js:2040`**,
     `sid -> { x, y, w, h, dstW, dstH, minimized, …, grab }`. **`grab` ALREADY EXISTS.**
   - pointer hit-test and dispatch to the surface under the cursor — `_wmEventTo` at
     **`kernel.js:5291`**, carrying `WMEV.MOUSEMOTION` / `BUTTONDOWN` / `BUTTONUP`.
   - a cross-surface drag-capture concept already in use for title-bar drags — `_wmTitleDown` at
     **`kernel.js:2059`**, which already tracks the "mouseup happened off this surface" case
     (see the `wm.c:2474` comment).
   ⇒ **We are ADDING A SESSION to machinery that already hit-tests and already captures.** We are
   not building pointer routing from scratch.
4. **Drag UI precedent exists but is NOT transport.** `wm.c`'s desktop layer (`todos/0077`) already
   does press → slop → marquee → icon drag → snapped drop → persisted layout, and `compositor.js`
   already draws drag ghosts, cell outlines and a separate overlay layer for the snap preview. But
   0077 is **intra-process** — wm draws and owns the desktop layer itself. Reuse it as a **UI
   precedent** in 0430; it gives you nothing for transport.

## Plan

1. **`os/wm_proto.h`** — ⚠️ the file is **`os/wm_proto.h`**, NOT `os/win32/include/wm_proto.h`, and
   the symbols are **`WMP_EV_*` / `WMP_*` members of an `enum`**, NOT `EV_*` `#define`s. A grep for
   `#define EV_` returns nothing and reads exactly like "the protocol does not exist."
   Add commands `WMP_REQ_DRAG_START { sid, payload }` and `WMP_REQ_DRAG_ACCEPT { sid, accept }`
   (the `DragAcceptFiles` bit, stored on the surface record), and events `WMP_EV_DRAG_ENTER` /
   `DRAG_OVER` / `DRAG_LEAVE` / `DROP` / `DRAG_END`.
   🔴 **DERIVE THE OPCODES AT IMPLEMENTATION TIME — DO NOT TRUST THESE NUMBERS.** As measured at
   `73c703d9`: highest event is `WMP_EV_OVERVIEW_PICK = 0x94` ⇒ next free event **0x95**; highest
   command is `WMP_OVERVIEW = 0x38` ⇒ next free command **0x39** (`0x40`+ are replies `WMP_R_*`).
   ⚠️ **Opcode slots are contended and this has already bitten once** — see `kernel.js:929`:
   *"drafted these at 0x35/0x92 as the then-next-free slots"*. If another lane lands opcodes before
   you, renumber in **one** commit.
   The header says **"MUST MATCH kernel.js (the WMP block) and tests/kernel/test_wm_policy.js"** —
   honour that; all three move together.
2. **`kernel.js`** — on `DRAG_START`, enter drag mode on the **existing** pointer grab. On motion,
   hit-test the surface stack (existing code) and emit `ENTER`/`OVER`/`LEAVE` to the target plus a
   feedback event to the source. On mouseup, emit `EV_DROP { sid, x, y, payload }` to the target and
   `EV_DRAG_END { accepted }` to the source. **Honour the accepts-drops bit**: a non-accepting
   surface receives no drag events at all and the source is told *rejected*.
   Cover the ugly cases explicitly — target surface destroyed mid-drag; target unmapped/minimized
   mid-drag; drag released over no surface; a second `DRAG_START` while one is live; source dies
   mid-drag (the session must not leak).
3. **`compositor.js`** — drag cursor/ghost and drop-target highlight, on the **existing overlay-layer
   pattern** used by the 0077 snap preview.
4. **`tests/kernel/`** — a new test for the **session state machine**, covering every case in (2).

## Open design calls — SETTLE THESE IN YOUR DESIGN PASS, they were deliberately left open

- **(a)** Does the drag session live in `kernel.js` alone, or does `/bin/wm` get a policy say? wm owns
  the desktop layer, so there is a real argument either way.
- **(b)** Copy-vs-move semantics and the modifier-key convention.
- **(c)** Is the drag ghost kernel-composited, or drawn by the source surface?

Record the answers in this ticket's **Design** line before you write code.

## Acceptance

- `wm_proto.h`, the `kernel.js` WMP block and `tests/kernel/test_wm_policy.js` agree on the new
  opcodes (the header's own stated invariant).
- A kernel-suite test drives the full session state machine — enter, over, leave, drop, end,
  rejection by a non-accepting surface, and every teardown case in Plan (2).
- Full kernel suite green, full browser sweep green, with the **artifact tallied**:
  `recorded == total` is not enough — tally `results[].status`, and if `carried > 0` / `runs > 1` /
  a `filter` is set, report the **first full run's** numbers.
- `node tests/todos/run.js` 5/5.
- The stub comment at `os/win32/shell32.c:118` stops being true here but is **deleted in 0429**,
  where the stubs actually go away. Do not delete it in this ticket.
