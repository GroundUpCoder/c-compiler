# 0346 — SCOPING ONLY: price Tcl + Tk + a gucOS display backend for `tkinter`

- **Status**: open
- **Provenance**: **jku instruction** — `~/git/meta/meta/notes/jku-RULING-queue-stdlib-ports-bz2-lzma-curses-tkinter.md`
- **Type**: 🔴 **SCOPING / ESTIMATE. This ticket does NOT authorize an
  implementation.** Its deliverable is a written price and a recommendation.

## Why this is a scoping ticket and not a port

jku queued `bz2`, `lzma` and `curses` as ports. **`tkinter` is deliberately
not one of them** — it is queued to be *priced first*, for two reasons that
should survive into whatever this produces:

1. ⭐ **It is plausibly as large as the entire CPython port already in flight.**
   `tkinter` is not a module, it is a binding to **two** foreign runtimes: Tcl
   (a complete interpreter with its own event loop, VFS and threading model)
   and Tk (a complete widget toolkit), *plus* a display backend that does not
   exist. Committing to it as if it were "one more stdlib module" would be the
   single largest un-priced commitment on the board.
2. ⭐ **It is a second GUI road to where `pygame` already goes.** The pygame
   ladder (`M2`/`M3`, scoped in `todos/CPYTHON.md` §8) is already the funded
   route from Python to pixels on gucOS. Tk would be a *parallel* GUI stack
   with its own backend, its own event loop, and its own maintenance surface.
   **The recommendation must address whether we want two, not just whether Tk
   is buildable.**

## What is established

- `vendor/` contains **no `tcl` and no `tk`** (verified 2026-07-28).
- `todos/CPYTHON.md` §2 excludes `tkinter/`, `idlelib/`, `turtledemo/` and
  `turtle.py`. ⚠️ **They are currently mislabeled** — see the companion fix
  landing with this ticket: they sit under rule (a) *"depends on a C substrate
  that can **never** exist on gucOS"*, but the reason written in the cell is
  *"no port exists or is planned"*, which is a **roadmap** claim wearing a
  **platform** claim's label. `ctypes` really is permanent (gucOS has no
  `dlopen`); Tk is merely unbuilt. **A rule-(a) label is what stops anyone ever
  re-examining it** — and jku re-examining it is precisely what created this
  ticket.

## Deliverable

A written estimate, in `logs/<date>/`, covering **all three legs separately** —
an estimate that folds them together is not usable:

1. **Tcl** — interpreter, event loop, VFS/filesystem assumptions, threading,
   what must be stubbed for gucOS. Line counts and configure surface, measured.
2. **Tk** — widget toolkit, its font stack (⚠️ check whether it wants FreeType,
   and whether that overlaps the Win32-veneer FreeType leg in `0347`), and its
   image/canvas surface.
3. **The display backend** — Tk targets X11 / Win32 / Aqua. gucOS is none of
   these. **State which one is the least-dishonest target and what the shim
   costs.** ⭐ gucOS already has a Win32 veneer (`os/win32/`, ~12,091 lines) —
   whether Tk's Win32 backend can ride it is the single highest-leverage
   question in this ticket, and it interacts with `0347`.

Then a **recommendation with a number**: build, defer, or decline — and if
defer/decline, the reason must be structural, not "no demand", because
"nobody asked" is exactly the reasoning this project rejects.

## Acceptance

- All three legs priced **separately**, each with measured line counts /
  configure surface, not recalled figures.
- An explicit answer to *"do we want a second GUI stack alongside pygame?"*
- An explicit answer to *"can Tk's Win32 backend ride `os/win32/`?"*
- ⚠️ **No `vendor/tcl` or `vendor/tk` directory is created by this ticket.**
  If the recommendation is "build", that is a **new** ticket for jku to fund.

## Notes

- This is a read/measure ticket: **no image bump, no `vendor/` change.**
  It should close with a document, not a diff to the OS.
- `todos/LIABILITIES.md` is machine-checked by the `todos` suite. If your change
  rewrites a line anchored by a register entry, the gate goes RED — re-anchor or
  retire it in the same commit. If your work leaves a gap, file a ticket AND a
  register entry; a gap that does not enter `todos/` does not exist.
