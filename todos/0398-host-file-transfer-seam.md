# 0398 — host<->gucOS file transfer seam — egress/download + file-flavored clipboard interop (DESIGN)

- **Status**: open
- **Design**: 🔴 **DESIGN PASS REQUIRED FIRST** (Fable). Do not start implementing from this
  ticket — it states the problem and the verified ground truth, not the solution.

## Goal

Close the **host↔gucOS file transfer** gap in both directions, as **one seam**, not two
bolt-on features.

jku asked for two things that look separate and are not:

1. **Copy/paste entire files between the host and the gucOS desktop.**
2. **Right-click a file → download it** (get a file *out* of gucOS to the host).

They share a substrate: moving **file bytes** across the page boundary, in both directions,
inside a user activation. ⭐ **Design them together as a general transfer seam — the same seam
should also serve "Save As" / export generally.** Building two independent special-cases for
one underlying capability is exactly the shortcut this repo rejects.

## Verified ground truth — probed off the tree at `main` `3bc880da`, do NOT re-derive

**Already built. Do not re-file, do not rebuild:**

- `todos/0092` (**done**) — `os/fileops.h`: a clipboard **file list** riding the same one
  kernel slot as format `FO_CLIP_FMT=2` (a `"cut\n"`/`"copy\n"` header plus one absolute path
  per line — the `CF_HDROP` idea kept textual). `wm.c` has desktop-icon Cut/Copy
  (`CM_CUT`/`CM_COPY`) and desktop Paste (`CM_PASTE`, grayed via `fo_clip_has()`), with
  recursive `fo_copy`, `EXDEV`-fallback `fo_move`, symlinks copied as links, and the Win95
  `"Copy of X"` / `"Copy (2) of X"` clash uniquifier. Cut pastes once (slot cleared).
  `os/win32/shell32.c` shares the same header, so fileman and the desktop are behaviorally
  identical.
- `todos/0067` (**done**) — desktop drag-and-drop **ingress**: `os/os.html` `dragover`/`drop`
  → `postHostFiles()` → BlockFS write. **Host → gucOS file ingress already works** (via drag,
  not via clipboard).
- `todos/0090` (**done**) — the text clipboard bridge; `todos/0091` (**done**) — the icon
  context menu (Open / Cut / Copy / Delete), on the menucore chain since `0259`.

**The two actual gaps, both confirmed by probe:**

- 🔴 **The host↔gucOS clipboard bridge is TEXT ONLY.** `SDL_SetClipboardText` is a C string
  and the ticket-#79 seam moves only `{type:'clipboard', text}`. So Cmd-C a file in Finder →
  paste on the gucOS desktop does **not** work, and gucOS-copy → paste into Finder does not
  either. **In-OS** file copy/paste is fine (`0092`); it is the **cross-boundary** hop that is
  missing.
- 🔴 **There is NO egress seam at all.** `git grep 'createObjectURL|showSaveFilePicker|download'`
  over `os/os.html` + `os/kernel-worker.js` returns **nothing** (`download` appears in the tree
  only inside `curl` and `gucman`, unrelated). `0067` built ingress; **egress was never
  built.** There is currently no way to get a file out of gucOS to the host by any route.

## What the design pass must actually resolve

These are the hard parts. The pass is expected to *decide* them, with reasons, not survey them:

1. **The paths-vs-bytes impedance mismatch.** `FO_CLIP_FMT=2` carries **absolute gucOS
   paths**, which are meaningless to the host. The browser clipboard, conversely, cannot carry
   paths at all — the async Clipboard API carries **Blobs/`File` objects**, behind a permission
   prompt, a secure context, and a live user activation. So the file-flavored clipboard bridge
   is not a serialization change; it is a **materialization** question in both directions
   (when do bytes get read? how large is too large? what happens to a directory, which has no
   Blob analogue? what about the recursive-copy and symlink-as-link semantics `fileops.h`
   already guarantees in-OS?).
2. **What the egress RPC looks like.** A new kernel RPC carrying bytes, versus the page
   performing its own BlockFS read. Which, and why. This crosses `wm.c` → kernel → page.
3. **User activation.** Both the Clipboard API and a synthesized download anchor require one.
   Trace how the existing deferred-`CLIP_GET` refresh already solves the analogous problem for
   text and decide whether that pattern generalizes or needs replacing.
4. **Whether `download` and `Save As` and clipboard-file-copy are one mechanism with three
   entry points.** ⭐ The strong prior is yes — design accordingly unless there is a concrete
   reason they must differ.
5. **Directories.** `fo_copy` is recursive in-OS. Decide honestly what crossing the boundary
   means for a folder (zip? refuse with a real error? multi-file?) rather than leaving it
   undefined.

## Plan

1. 🔴 **Fable design pass first** → writes the design into this ticket (or a sibling design
   note referenced from here), naming the seam, the RPC(s), the wire format, the activation
   strategy, and the directory answer.
2. Implementation follows the design. **jku has pre-authorized Fable for the implementation
   too** where the design says the seam is subtle — spawn the build on Fable rather than
   downgrading it.
3. Sequence the two entry points off the shared seam once it exists (egress/download is the
   simpler consumer and is the natural first proof).

## Acceptance

Set by the design pass. Non-negotiable floors regardless of what it decides:

- **Both directions demonstrated end-to-end**, not just the easy one.
- The existing in-OS `0092` semantics (recursive copy, cut-pastes-once, the `"Copy of X"`
  uniquifier, symlinks-as-links) **must not regress** — they are shared code.
- Kernel suite + browser sweep green **with numbers**; `node todos/queue.js check` passes.
- 🔴 An **image bump** is owed if `wm.c`, `os/os.html`, `os/kernel-worker.js`, or any packaged
  binary changes — which this certainly will.

## Notes

- ⭐ **Build to the goal, not to the demo.** No "no current customer" / "nothing uses it yet" /
  "all current callers happen to be text" scoping. Design the **general** seam at the right
  level of generality; a per-feature special case is the outcome to avoid. If some part is
  genuinely high-complexity *and* genuinely off-goal, say so explicitly and surface it — do
  not silently cut it.
- `todos/LIABILITIES.md` is machine-checked by the todos suite — re-anchor or retire an
  anchored line in the same commit. **A gap that does not enter `todos/` does not exist.**
- Filed at jku's request (via the meta-meta router), 2026-07-28: *"for the trickier ones use
  fable pass first and also even fable implementation as needed."* This is the tricky one.
- Sibling: `0397` (pbcopy/pbpaste) is the easy half of the same request and is **independent**
  of this ticket — it needs no design pass and must not be blocked behind this one.
