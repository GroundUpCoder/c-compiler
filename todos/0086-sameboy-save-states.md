# 0086 — SameBoy save states (save_state.c) + core pickability

- **Status**: open
- **Design**: this file. Follow-up of `0075` (SameBoy port, done); sits at
  the back of the queue — quality-of-life, nothing depends on it.

## Goal

Two leftovers from the 0075 minimal-core decision:

1. **Save states.** The port kept the `GB_SECTION` struct sectioning fully
   intact (`--allow-zero-length-arrays`), and 0085 fixed the multi-char
   magics (`'SAME'`/`'S4ME'`, BESS `'CORE'`/`'BESS'`…), so vendoring
   `Core/save_state.c` should now be mostly mechanical: audit it for the
   same GNU-isms the rest of the core needed (statement exprs, elvis,
   VLAs — see `vendor/sameboy/README.md` patch table), add it to
   `bin.json`, wire frontend keys (e.g. F5 save / F7 load to
   `<rom>.s0`), and e2e the round-trip (state saved mid-checkerboard
   restores to the same frame). BESS gives cross-emulator state compat.

2. **Core pickability (optional).** `.gb`/`.gbc` associations point at
   `/bin/gameboy` (0072 decision — Peanut-GB stays default). Now that two
   cores exist, consider an `openwith` recipe (`open --set gbc
   /bin/sameboy`) documented in the READMEs, or a Start-menu "sameboy"
   launcher for the seeded ROMs like the gameboy Desktop scripts. Don't
   flip the default.

## Acceptance

- Save/load round-trip e2e green (extend `test_sameboy_e2e.js`).
- `/bin/gameboy` still the association default.
