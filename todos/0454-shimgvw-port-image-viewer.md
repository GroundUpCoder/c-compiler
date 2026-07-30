# 0454 — shimgvw port: ReactOS image viewer as THE gucOS image viewer

- **Status**: open
- **Design**: `~/git/meta/gucos/notes/image-viewer-followup-gdiplus-cpp.md` §2
  ("Beyond GDI+, the shimgvw port itself needs") and the first-round report
  `image-viewer-scoping-email.md`. Those are the authority for *why*; this
  ticket is the authority for *what*.
- **Provenance**: filed 2026-07-30 by @master (cont-220) on jku's ruling
  (email reply to the follow-up scoping report). He **approved the ReactOS
  path**: gdiplus-mini + a `shimgvw` port **IS** the gucOS image viewer, and
  the roll-our-own viewer app is **SKIPPED**. jku approved the *sequence* and
  did not assign a P-level, so this sits at P1 immediately behind 0453, above
  the P3 C++ band.

## Goal

`shimgvw`, the ReactOS image viewer, running on gucOS as **the** image viewer:
open a PNG/GIF/JPEG/BMP from the shell and view it, with the viewer's own
toolbar, zoom, rotate, slideshow and save-as.

## Scope — measured against `main` at filing time

### 🔴 The vendoring precedent is REAL, and it has a REGISTRATION STEP the scoping note omits

**Verified present** — the three existing ReactOS ports and how they are wired:
- `vendor/notepad/bin.json`, `vendor/winmine/bin.json`, `vendor/calc/bin.json`
  all exist. That is the pattern to copy (`vendor/<app>/` + a `bin.json`).
- 🔴 **Each one is also REGISTERED as an entry in `os/win32/ports.json`'s
  `targets[]` array** (`name`, `project`, `expect`, `notes`), and
  `os/win32/PORTS.md` is **generated** from it by `node tools/win32ports.js`.
  `PORTS.md` says *"Do not edit by hand — regenerate after changing os/win32 or
  a vendored port, and keep it committed (`--check` verifies freshness)."*

⇒ **A port that is not added to `ports.json` is not checked by anything.** The
port-status table would still print a clean pass while your app is invisible to
it. **Adding the `ports.json` entry and regenerating `PORTS.md` in the same
commit is an acceptance arm below, not an optional tidy.**

### The veneer gaps — each measured, with a positive control

- 🔴 **comctl32 has NO TOOLBAR control.** Measured: `ToolbarWindow32` /
  `WC_TOOLBAR` / `TB_ADDBUTTON` = **0** hits in `os/win32/comctl32.c`, while
  the controls `msctls_statusbar`/`STATUSCLASSNAME`/`SB_SETTEXT` = **6** hits
  and `SysListView32`/`WC_LISTVIEW` = **4**. The non-zero controls prove the
  instrument can see controls, so **the toolbar gap is real** — this is bounded
  new `comctl32.c` work and it is the largest single unknown in this ticket.
- ✅ **Registry is already real** — `RegOpenKeyExW` 2, `RegQueryValueExW` 1,
  `RegSetValueExW` 1, `RegCloseKey` 6 in `advapi32.c`. Settings persistence
  should just work; **do not re-implement it.**
- ✅ **`SetTimer` exists** (3 hits in `user32.c`) — use it for the slideshow.
- ❌ **`SHCreateThread` = 0 hits** in `shell32.c`. The upstream slideshow uses a
  worker window via `SHCreateThread`; **replace that with `SetTimer`** rather
  than implementing `SHCreateThread`.
- ❌ **`SHFileOperationW` = 0 hits.** Along with `SHAddToRecentDocs` and
  `SHBindToParent` (context-menu forwarding), these must be **stubbed
  fail-loud** or thinly implemented — never a silent success.
- ✅ `shlwapi` `Path*` helpers are trivial C if any are missing.
- **There is no ReactOS checkout in this repo** — you must fetch
  `dll/win32/shimgvw`. Record the upstream revision you vendored.

### The C++ file
`loader.cpp` is **283 lines** and is the only C++ in the viewer. **Rewrite it in
C** — this ticket must not introduce a C++ toolchain dependency (that is the
separate P3 ladder, 0455/0456/0457).

## Licensing

ReactOS `shimgvw` is **GPL-2.0+**, the same license as the already-vendored
`notepad`/`winmine`/`calc`. **Keep the upstream `LICENSE`** and follow whatever
those three do for attribution — copy the precedent, do not invent a new one.

## Plan

1. Vendor `dll/win32/shimgvw` under `vendor/shimgvw/` with a `bin.json`,
   following `vendor/notepad/`.
2. **Register** it in `os/win32/ports.json` `targets[]` and **regenerate**
   `PORTS.md` with `node tools/win32ports.js` — same commit.
3. Rewrite `loader.cpp` (283 lines) in C.
4. Implement the **comctl32 TOOLBAR** control in `os/win32/comctl32.c`.
5. Slideshow: `SHCreateThread`/worker window → **`SetTimer`**.
6. Stub `SHFileOperationW` / `SHAddToRecentDocs` / `SHBindToParent` fail-loud.
7. Wire the shell associations (below).
8. Seed the app the way `notepad`/`winmine`/`calc` are seeded (`/bin/...`).

## Openwith associations — a decision you must RECORD

**`png` / `gif` / `jpg` / `jpeg` → the viewer.** **`bmp` stays associated with
`paint`**, because paint is for *editing* and bmp is its native format.

🔴 **This split is a judgement call the scoping pass deferred to implementation
time. Whichever way you land it, write the decision and its reasoning into the
ticket's `## Result`** — do not leave it recoverable only from a diff.

⚠️ **Do not confuse this with the existing `paint` port.** `os/win32/paint.c` +
`paint.json` are an **in-house** Paint accessory (ports.json calls it *"the 0107
Paint accessory (gdi32 canvas, comdlg32 BMP I/O)"*), **not** ReactOS mspaint.
Ticket 0457 is the ReactOS C++ mspaint and is a different thing entirely.

## Acceptance

🔴 **Every arm is required. An arm you skipped and did not mention is
indistinguishable from an arm that passed.**

1. **`ports.json` + `PORTS.md`.** `shimgvw` is an entry in
   `os/win32/ports.json`'s `targets[]`, `PORTS.md` is **regenerated** in the
   same commit, and `node tools/win32ports.js --check` passes. **State the
   port-status line for `shimgvw` and its missing-symbol count.**
2. **The viewer opens all four formats end-to-end** — PNG, GIF, JPEG, BMP —
   through 0453's shim, asserted in a test rather than only by eye.
3. **The TOOLBAR control is proven** by a test that exercises it, not merely by
   the viewer appearing to render. State what the test asserts.
4. **Every stub fails loud.** Demonstrate that `SHFileOperationW` (and the other
   stubs) cannot be mistaken for success — show the failure surfacing.
5. **The association decision is RECORDED** in `## Result` with its reasoning,
   including the `bmp` → paint call.
6. **A registered test, with the new total stated.** If you add a test file, say
   so and give the count before and after; if you add a whole suite, confirm you
   registered it in `SUITES`, `RUN_ORDER` **and** `ALL_SUITES`. The old total is
   a passing-looking number that means your test did not run.
7. **The C rewrite is complete** — no C++ translation unit enters the build from
   this ticket.
8. **Build-to-the-goal:** the viewer is the real ReactOS viewer, not a reduced
   demo that happens to display one format. "Only PNG is wired so far" is not an
   acceptable close state.
