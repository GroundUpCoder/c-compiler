# 0292 — optional bake assets: dependent launchers inherit optionality; decide + gate cross-machine bake identity

- **Status**: open
- **Design**: this file. Source: unfunded-liability sweep 2026-07-27 (finding #3).

## Goal

Two related defects around `entry.optional` in `os/os-common.js:291-294` +
`os/image.json:698-724`.

```
 *   entry.optional — (with entry.bin) a missing asset logs a skip instead of
 *                   failing the boot: for assets that are deliberately NOT
 *                   in the repo (the gameboy ROMs are gitignored), so other
 *                   checkouts still boot — minus that file
```

### (a) Dependent launchers do not inherit optionality

Three ROM entries are `optional`; their three Desktop launchers are **not**:

```json
"/root/Desktop/pokemon":    { "content": "#!/bin/sh\nsameboy $HOME/roms/PokemonBlue.gb\n" },
"/root/Desktop/drmario":    { "content": "#!/bin/sh\nsameboy $HOME/roms/DrMario.gb\n" },
"/root/roms/PokemonBlue.gb":{ "bin": "vendor/gameboy/roms/PokemonBlue.gb", "optional": true },
```

The ROMs exist on the dev machine (`vendor/gameboy/roms/`) and are gitignored. **On any other
checkout the launchers are seeded anyway and point at files that do not exist** → three dead
Desktop icons, no diagnostic.

### (b) `optional` makes the bake machine-dependent

More seriously: **the same tree bakes a different blob on different machines.** That is silently
at odds with the content-hash deploy scheme (see `0285`, `todos/0249`) — and
`tests/serve/test_image_determinism.js` runs its two bakes on the **same** machine, so it
structurally **cannot see this axis at all**. A determinism test that cannot fail on the
variable in question is not coverage.

## Why nothing scheduled it

#77 ("gucman — ROM-launchers packaging") would *incidentally* fix the dead launchers, but it is
**blocked on copyright + `desktop[]` planting vocab** and does not cover the general property.
#21 / `todos/0121` ("reproducible image bakes") is about wall-clock mtimes — a different axis.
So the gap sat between two tickets, each of which looked like it covered it.

## Plan

- **(a)** Minimum: make a launcher whose `bin` target is `optional` **inherit** that
  optionality, so a skipped asset skips its launcher too. No more dead icons on any checkout
  but one.
- **(b)** **Decide explicitly** whether cross-machine bake identity is a property the
  content-hash deploy requires. Record the decision here either way. If yes, it needs a gate
  that today's same-machine determinism test cannot provide (e.g. bake with the optional assets
  absent and compare, which simulates the other-checkout case on one machine).

## Acceptance

- A checkout without the gitignored ROMs seeds **no** dead ROM launchers.
- The cross-machine bake-identity decision is written down, with a gate if the answer is yes.
- Planner-selected suites green (`node tests/run.js --diff`), reported with NUMBERS.
