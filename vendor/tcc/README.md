# TCC 0.9.27 — WIP port to compiler.js

Upstream sources from the Tiny C Compiler 0.9.27 release
(https://download.savannah.gnu.org/releases/tinycc/tcc-0.9.27.tar.bz2),
Fabrice Bellard et al., LGPL (see `COPYING`).

Status: **functional.** TCC compiled to wasm by compiler.js runs and compiles C:

- **Builds:** `node compiler.js vendor/tcc/bin.json -o /tmp/tcc.wasm` → ~320 KB wasm.
- **Runs:** `node host.js /tmp/tcc.wasm -v` → `tcc version 0.9.27 (i386 Linux)`.
- **Compiles:** `node host.js /tmp/tcc.wasm -c hello.c -o hello.o` produces a valid
  `ELF 32-bit LSB relocatable, Intel 80386` object file. A C compiler running
  inside wasm, itself built by this repo's C compiler.

Two compiler.js codegen bugs surfaced by this port were found, reduced, tested,
and fixed (see "Dependency on compiler.js fixes" below) — finding such bugs is a
primary reason for the port.

## Build configuration

`bin.json` builds the i386 target only via `ONE_SOURCE` (`tcc.c` `#include`s the
rest). `config.h` is the configure-generated file with its machine-specific
`CONFIG_TCCDIR` neutralized (it is overridden by `bin.json`'s `-DCONFIG_TCCDIR`).

## Patches to upstream

One patch, guarded so the native build is unaffected:

- **`tcctools.c`** — `execvp` is stubbed under `#ifdef TCC_WASM_BUILD`. compiler.js
  has no `execvp` (the wasm host has no process model); TCC only calls it from the
  multi-target dispatcher `tcc_tool_cross`, which a directly-invoked cross-compiler
  never reaches, so a failing stub is sufficient to compile and link.

## Dependency on compiler.js fixes

This port found three compiler.js bugs; all fixed with regression tests:

1. **`a9dc1e5`** — "propagate MEMORY alloc class to tentative re-declarations".
   Without it, TCC's `define_stack` (declared in `tcc.h`, `&`-used in `tccpp.c`,
   re-declared in `tccgen.c`) triggered "Cannot take address of REGISTER
   variable" at *build* time. Test: `tests/unit/core/addr_taken_redeclared_global`.
2. **`ad647cb`** — "keep a labeled statement's body attached to its label".
   `if (3 == spc) bad_twosharp: tcc_error(...)` in `parse_define` was misparsed so
   the `tcc_error` ran unconditionally, breaking TCC's macro predefs at *runtime*
   (`'##' cannot appear at either end of macro`). Test:
   `tests/unit/core/if_labeled_body`.
3. **`689d51a`** — "goto-normalizer: don't hoist labels past trailing statements
   in intermediate blocks". `parse_number`'s `float_frac_parse:` label sits in
   nested ifs with buffer-finalization statements trailing in an intermediate
   block; the hoist silently skipped them, so every float constant and every
   braced initializer failed to compile under wasm-tcc. Test:
   `tests/unit/core/goto_hoist_intermediate_tail`.

## Tests

`python3 tests/run.py --types=tcc` builds tcc twice — to wasm via compiler.js
and natively via clang (`build/tcc-native`) — compiles the inputs under
`tests/tcc/*/input.c` with both, and requires byte-identical i386 ELF output.
The native build is the oracle, so no binary goldens are checked in.

## TODO

- Wire up the full runtime include/lib paths (`-c` works; richer programs need
  TCC's bundled headers under a known prefix).
- Try building larger programs and running the produced objects.
