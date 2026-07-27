# EMULATORS.md — the Game Boy emulator pair: what ships, what is default, and why `vendor/gameboy` keeps its name

Written 2026-07-28 at jku's instruction ("let's note the state of things and
sameboy should stay the default"). This is a **state-of-things note**, not a
project: it authorizes no rename, no package change, and no image bump.

Every claim below was verified against `os/image.json` on 2026-07-28 rather than
inherited from a brief.

---

## The two emulators both ship, deliberately

| vendor dir | what it is | how it ships |
|---|---|---|
| `vendor/gameboy` | **Peanut-GB** — small, portable, SDL frontend | baked binary `/usr/bin/gameboy`, reachable from its **own menu/desktop entry only** |
| `vendor/sameboy` | **SameBoy** — cycle-accurate, **Win32-veneer** frontend | baked binary `/usr/bin/sameboy` (`os/image.json:102`), menu entry at `:255` |

`gameboy-clang` (Peanut-GB built by the clang sibling) also ships, as a gucman
package (`packages/gameboy-clang.json`). **It stays** — see the reversal below.

## SameBoy is already the default handler — verified, nothing to implement

Both user-facing surfaces already route `.gb`/`.gbc` to SameBoy:

1. **File associations** — `/usr/share/openwith` (`os/image.json:358`) contains
   `gb → /bin/sameboy` and `gbc → /bin/sameboy`. This is what the desktop /
   fileman GUI double-click and `open(1)` consult.
2. **Seeded desktop launchers** — `/root/Desktop/{pokemon,mario,drmario}`
   (`os/image.json:699,703,707`) are each `#!/bin/sh` + `sameboy $HOME/roms/<rom>`.

⚠️ These live inside a `\n`-escaped JSON **string**, not as JSON keys, so
`grep '"gb"' os/image.json` finds nothing and looks like the mapping is absent.
Grep for `sameboy` instead.

⇒ **"SameBoy should stay the default" required no change. It was already true.**
Peanut-GB (`/usr/bin/gameboy`) is reachable only from its own menu/desktop entry.

---

## 🔴 Why `vendor/gameboy` was NOT renamed to `vendor/peanutgb` (jku, 2026-07-28)

A rename was proposed and **jku withdrew it**. His reason is correct and is the
part worth recording, because it is what stops the rename being re-proposed:

> **`vendor/gameboy/` is not only Peanut-GB — it is also the shared ROM store.**

`os/image.json:713-723` seeds `/root/roms/{PokemonBlue.gb,
SuperMarioDeluxe.gbc, DrMario.gb}` from `vendor/gameboy/roms/`, and **those ROMs
are consumed by SameBoy, not by Peanut-GB** (see the launchers above). So the
directory name is a *category* name, accurate for its ROM half. Renaming it to
`peanutgb` would have left `vendor/peanutgb/roms/` supplying SameBoy's ROMs —
**strictly worse than today**.

The original brief argued for the rename and was wrong on this point: it checked
the binary and the menu entries but never **what consumed the ROM directory**.

**Also withdrawn in the same reversal:** the proposal to delete `gameboy-clang`.
jku: *"we can have gameboy and gameboy-clang."* Both stay.

### If anyone does revisit the rename

`tests/run.js:231`'s planner regex is
`/^vendor\/(doom|quake|gameboy|sameboy|…)\//`. **Renaming the vendor directory
without editing that line silently unmaps the emulator from all testing** — the
`0333` failure class. Other carriers of the path: `os/image.json:714,718,722`
(ROM seeds) and `tests/bench/run.js:67`.

---

## `sameboy-clang` does not exist yet, and what blocks it

There is no clang-built SameBoy. It is blocked on the **Win32-veneer clang
capability** — `todos/0347`, a **jku ruling** (2026-07-28): *"I want win32 veneer
apps to be compilable with clang too."*

⚠️ The deliverable there is the **capability**, not `sameboy-clang`; the
SDL-frontend shortcut for SameBoy was explicitly **refused on the record**,
because building it against SDL would differ from the baked build in *compiler
and frontend*, destroying the A/B. `0347` is queued behind `0330`/`0340`.

SameBoy is worth that A/B specifically: it is the **only binary in the shipped
image measured to benefit from the v177 `br_table` lowering fix** — 6.0× on a
headless upper-bound harness (`GB_display_run`'s 568-case irreducible switch:
linear chain → `br_table`), image −3,904 B. That is one measured lowering
improvement in one app; there is **no in-OS or browser measurement** of it.

---

## Sources

- `~/git/meta/meta/notes/jku-REVERSAL-no-peanutgb-rename-keep-both.md` — the withdrawal
- `~/git/meta/meta/notes/jku-RULING-win32-veneer-clang-buildable.md` — the capability ruling
- `todos/0347` — the queued capability item
