# 0457 — mspaint-clang: the ATL consumer as an optional *-clang gucman package

- **Status**: open
- **Priority**: P3 — **jku's explicit call** (see 0455's Provenance; same ruling).
- **Design**: `todos/CLANG-CPP-EPIC.md`, `todos/CPP-LADDER-PROPOSAL.md`, and
  `~/git/meta/gucos/notes/image-viewer-followup-gdiplus-cpp.md` §3.
- **Provenance**: filed 2026-07-30 by @master (cont-220) on jku's ruling —
  *"The lower tier stuff (ie C++ etc) let's queue it as active but put them as
  P3."* **Queued ACTIVE at P3.** This is the top of the Tier-4 C++ ladder:
  0347 → 0455 (ATL-free rung) → 0456 (ATL) → **0457**.

## Goal

Vendor ReactOS **mspaint** as an optional **`*-clang`** gucman package — the real
**ATL consumer** that justifies 0456's ATL leg, and the app that exercises the
full C++-on-veneer path end to end.

## Blocked by 0456

Hard dep: **0456** (the ATL leg). mspaint is an ATL app; without ATL there is
nothing to build against.

## ⚠️ THIS IS NOT THE EXISTING `paint` PORT — DO NOT COLLIDE WITH IT

The tree **already has a Paint accessory**, and it is a different thing:
- `os/win32/paint.c` + `os/win32/paint.json`, registered in
  `os/win32/ports.json` as target **`paint`**, described there as *"control
  target — the 0107 Paint accessory (gdi32 canvas, comdlg32 BMP I/O); must stay
  fully covered"*, and currently **`links`, 0 missing** in `PORTS.md`.

⇒ That is an **in-house C** accessory, **not** ReactOS mspaint. This ticket adds
a **separate** ReactOS C++ app.
🔴 **`paint` is a declared CONTROL TARGET that must stay fully covered — do not
rename it, repoint it, or regress it.** Pick a distinct target name
(e.g. `mspaint-clang`) and a distinct package name, and confirm in your report
that the existing `paint` target still links with 0 missing symbols.

## The packaging convention is already established — follow it, do not invent

Measured: **9** optional `*-clang` packages exist today — `box2d-clang`,
`cpython-clang`, `doom-clang`, `etl-clang`, `gameboy-clang`, `glm-clang`,
`imgui-clang`, `ninja-clang`, `tinyrenderer-clang`. The base image stays
clang-free and these ship via the clang-apps overlay. **Copy that pattern.**

⚠️ **The clang-apps overlay has a known non-git half.** The overlay is a *built*
artifact and this fleet has twice been bitten by a consumer reading
`out-image/overlay.json`, which is **gitignored** — a rename that was correct in
git left the built payload publishing a stale key. **Before you report done,
state what the overlay publishes for this package and whether a rebuild is owed
at merge time.** No git-level check will tell the coordinator this.

## Plan

1. Vendor ReactOS mspaint; record the upstream revision and license (the
   existing ReactOS ports — `notepad`, `winmine`, `calc` — are GPL-2.0+; follow
   their attribution precedent).
2. Build it with clang against the veneer using 0456's ATL + `WITH_EXCEPTIONS`.
3. Ship as an optional `mspaint-clang` gucman package via the clang-apps
   overlay; base image unchanged.
4. Register a **new, distinct** target in `os/win32/ports.json` and regenerate
   `PORTS.md` with `node tools/win32ports.js` in the same commit.

## Acceptance

1. **mspaint builds and runs** on the veneer via clang, using ATL from 0456.
   It is usable — draw, save, open — not merely a window that opens.
2. **The existing `paint` target is untouched and still links with 0 missing.**
   Quote its `PORTS.md` line. This is a declared control target.
3. **Registered** under a distinct name in `os/win32/ports.json`, `PORTS.md`
   regenerated in the same commit, `node tools/win32ports.js --check` passes.
   Give the new target's status line and missing-symbol count.
4. **Optional package only** — the base image remains clang-free. Confirm the
   base image is byte-unchanged, and **state the overlay/`out-image` situation**
   per the warning above.
5. **A registered test, with the new total stated** (before and after).
6. **State plainly that the ATL path is exercised end-to-end**, since that is
   what this rung proves and it is the ladder's top.
7. **Build-to-the-goal:** ship the real mspaint. A reduced build with features
   disabled to get green is not an acceptable close state — if something genuinely
   cannot work, say so explicitly rather than quietly omitting it.
