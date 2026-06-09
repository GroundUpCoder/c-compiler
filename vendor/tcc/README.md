# TCC 0.9.27 — WIP port to compiler.js

Upstream sources from the Tiny C Compiler 0.9.27 release
(https://download.savannah.gnu.org/releases/tinycc/tcc-0.9.27.tar.bz2),
Fabrice Bellard et al., LGPL (see `COPYING`).

This is a **work in progress**, not a finished port. Status:

- **Builds:** `node compiler.js vendor/tcc/bin.json -o /tmp/tcc.wasm` produces a
  ~320 KB wasm with no errors.
- **Runs:** the wasm executes — TCC's own preprocessor runs — but it is **not yet a
  functioning compiler**. Running it currently fails while processing TCC's
  predefined macros:

  ```
  <define>: error: '##' cannot appear at either end of macro
  ```

  Under investigation. Likely a build-configuration mismatch (predefs / include
  setup) between this `bin.json` and how the native `./configure && make` build
  configures TCC — not yet confirmed to be a compiler.js codegen issue.

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

## Dependency on a compiler.js fix

Building this requires the parser fix in commit `a9dc1e5` ("propagate MEMORY alloc
class to tentative re-declarations"). Without it, TCC's `define_stack`
(declared in `tcc.h`, `&`-used in `tccpp.c`, re-declared in `tccgen.c`) triggers
"Cannot take address of REGISTER variable".

## TODO

- Resolve the predefined-macro `##` runtime error.
- Wire up runtime include/lib paths so the wasm tcc can actually compile a `.c`.
- Smoke test: compile a hello-world to an i386 ELF inside the wasm.
