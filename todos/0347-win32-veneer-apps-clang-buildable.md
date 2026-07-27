# 0347 — CAPABILITY: Win32-veneer apps must be buildable by the clang sibling

- **Status**: open
- **Provenance**: 🔴 **jku RULING (2026-07-28)** —
  `~/git/meta/meta/notes/jku-RULING-win32-veneer-clang-buildable.md` (`601ac4e`)
- **Blocked by**: `0330` (sibling libc re-vendor) — soft prerequisite, see below;
  and sequenced behind `0340`
- **Priority**: **not P0.** A capability investment, not a defect. Queued.

## His words

> "For sameboy I definitely want 1. I want win32 veneer apps to be compilable
> with clang too. Should be queued so we get around it eventually"

## 🔴 THE DELIVERABLE IS THE CAPABILITY, NOT `sameboy-clang`

Two routes were offered for `sameboy-clang`: (1) teach the clang sibling to
build against our Win32 veneer — an honest A/B where **only the compiler
differs**; (2) build it against SDL — cheap, but differs in compiler **and**
frontend. **jku took (1) and then generalized it**: the deliverable is
*"win32-veneer apps are clang-buildable"* as a **capability**, with
`sameboy-clang` merely its first user.

⚠️ **Do not let this narrow back to "just get `sameboy-clang` out".** The
general capability IS the ask, and **the SDL shortcut is explicitly REFUSED on
the record.** This is `meta/CLAUDE.md`'s core principle stated by jku himself —
build the clean general case, not the minimum that makes one demo pass.

## The payoff set — 5 first users, not one artifact (verified)

Everything that deps on `os/win32/lib.json`:

- `vendor/sameboy/bin.json` ← the one he named; also the **only shipped binary
  measured to benefit from the v177 `br_table` fix (6.0×)**, which is what makes
  its A/B worth having
- `vendor/notepad/bin.json`
- `vendor/winmine/bin.json`
- `vendor/calc/bin.json`
- `os/gpubox.json`

## Scope, measured (do not re-derive; DO re-verify before executing)

**The veneer is ~12,091 lines** across `os/win32/lib.json`'s source list:
`user32.c` **5,900**; `gdi32.c` 1,599; `kernel32.c` 1,459; `comdlg32.c` 717;
`crt16.c` 653; `menucore.c` 578; plus `advapi32.c`, `comctl32.c`,
`gdi32w.c` 134, `shell32.c` 134, `winmm.c` 119.

### 🔴 THE HIDDEN DEPENDENCY — FreeType

`os/win32/lib.json` declares `deps: ["menucore.json",
"../../vendor/freetype/lib.json"]`. The sibling's `wasm/vendor/` holds box2d,
bullet, etl, glm, imgui, json, nes, ninja, stockfish, tinyrenderer — **no
freetype**. So *"make win32 clang-buildable"* silently contains *"make FreeType
clang-buildable"* (the veneer uses it for text).

⇒ **ANY ESTIMATE THAT OMITS FREETYPE IS WRONG. Scope it as its own leg.**

### ✅ NOT a green field — there is an existing seam

The sibling already models "library surface beyond base libc" as `.tus` sets:
`wasm/libc.tus`, `wasm/libc-sdl.tus`, `wasm/libc-webgpu.tus`, with `--sdl`
selecting one. A `libc-win32.tus` (or equivalent) follows the established
pattern. ⇒ **Do NOT invent a mechanism — read `--sdl`'s plumbing first and
extend the precedent.**

## Sequencing

- **`0330` is a soft prerequisite**: it re-vendors the sibling's libc
  extraction, and win32 sits on top of that libc. Doing win32 first would build
  against the stale extraction. (`0330` has landed on its branch as of
  2026-07-28; it must be **merged** before this starts, not merely pushed.)
- Behind `0340` — jku is actively watching the CPython chain and this must not
  displace it.

## Coherence with the `gameboy` thread (read this before writing a plan)

The earlier ask to remove `gameboy-clang` and rename `gameboy` → `peanutgb` was
**WITHDRAWN by jku** (`notes/jku-REVERSAL-no-peanutgb-rename-keep-both.md`) —
`gameboy` and `gameboy-clang` both stay. So the framing is **not** "the emulator
clang-twin moves"; it is: `gameboy-clang` (Peanut-GB via SDL) continues to ship,
and `sameboy-clang` is an **additional** twin — and the one worth measuring,
because SameBoy is the binary the v177 win actually landed on.

## Acceptance

- A **Win32-veneer app other than `sameboy`** also builds under the clang
  sibling — that is what makes this a capability rather than one port. Name it
  in the close-out with its build output.
- FreeType's clang-buildability closed as its own reported leg, with numbers.
- The mechanism extends the existing `.tus` seam; if it does not, the close-out
  must say why the precedent was insufficient.
- `sameboy-clang` builds and runs a ROM — the first user, demonstrated.

## Notes

- `todos/LIABILITIES.md` is machine-checked by the `todos` suite. If your change
  rewrites a line anchored by a register entry, the gate goes RED — re-anchor or
  retire it in the same commit. If your work leaves a gap, file a ticket AND a
  register entry; a gap that does not enter `todos/` does not exist.
- Touching `vendor/` or the veneer forces an image rebake ⇒ **full gate + an
  `os/image.json` bump, which the master assigns.** Executors never touch
  `os/image.json`.
