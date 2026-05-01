# Misc TODO

## Test categories to add

- **doom** — Doom OPL music module tests. Requires vendoring Doom and Nuked-OPL3 sources.
  Compile+run tests that check for "FAIL" in stdout rather than using expected output files.

- **torture** — GCC torture test subset. Needs its own compile-failure policy (skip, not fail)
  since most tests use GCC extensions the compiler doesn't support. The old repo had a
  separate `run-torture.py` that was never integrated into the main harness.

- **third-party** — External C compliance test suites (c-testsuite, UCB math subset).
  Each has its own runner and discovery logic. Need to decide how to integrate or wrap them.

## Vendor projects to add

- ~~**doom** — DOOM (doomgeneric port) + Nuked-OPL3. Large integration test.~~
- ~~**zlib** / **zlib-compat** — Compression library.~~
- ~~**freetype** — TrueType font rendering.~~
- ~~**gameboy** — Gameboy emulator.~~
- **tinyemu** — RISC-V system emulator (boots Linux).
