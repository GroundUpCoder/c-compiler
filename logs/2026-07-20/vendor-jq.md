# Vendor jq 1.7.1 as a gucOS package (with bundled Oniguruma)

**Branch:** `vendor-jq` · **Status:** built, in-OS verified, `projects` gate green,
awaiting coordinator review/merge + deploy (jq is a package → ships via
`image.json` bump + `--packages=all` deploy).

## What

Ported **jq 1.7.1** (jqlang/jq, MIT) to compiler.js as a first-class gucOS
package, mirroring the existing `vendor/lua` + `vendor/sqlite` + `packages/*.json`
pattern:

- `vendor/jq/` — sources + `bin.json` + README (patch table).
- `packages/jq.json` — the gucman package manifest (`bin: {jq: jq}`; jq is a CLI
  filter, so no `menu`/`openwith`, exactly like `sqlite3.json`/`lua.json`).
- The software-center catalog entry is automatic: `/bin/software` reads the
  gucman `index.json`, which `tools/mkpkg.js` builds from `packages/*.json`.

## Oniguruma decision — BUNDLED

The task's build-to-goal directive was "bundle regex if oniguruma vendors
cleanly, else drop it and document loudly." It vendors cleanly: Oniguruma 6.9.9
is ISO C, and the only thing autoconf normally supplies is a `config.h` of fixed
target facts (hand-written as `oniguruma/config.h` — wasm32 ILP32, LE). A
standalone `onig_new`+`onig_search` harness compiled and matched on the first
try, so it's bundled. jq regex (`test`/`match`/`sub`/`gsub`/`scan`/`split(re)`,
named captures, Unicode `\w`/`\p{}`, flags) works fully. Only the core engine +
ASCII/UTF-8/Unicode encodings are compiled (jq is UTF-8-only); other encodings
and the POSIX/GNU wrappers are omitted. `unicode_*_data.c` are `#include`d by
`unicode.c`, so present-but-not-listed as sources.

## Validation — behavioural parity with clang jq

The wasm binary passes jq's **entire official test corpus** with the *same*
score as the reference clang build (run via jq's own `--run-tests`):

| suite | wasm | clang |
|---|---|---|
| jq.test | 435/447 | 435/447 |
| man.test | 222/224 | 222/224 |
| onig.test | 40/40 | 40/40 |
| manonig.test | 17/17 | 17/17 |
| base64.test | 7/7 | 7/7 |
| optional.test | 3/3 | 3/3 |

(Non-passing entries are the module/`import`/`modulemeta` filesystem-fixture
tests, which fail identically under clang jq off the module search path.)

In-OS via `node os/boot.js --packages=all`: `jq --version` → `jq-1.7.1`;
`{"a":[1,2,3]} | .a[1]` → `2`; `test("^a.c$")` → `true`. `node tests/run.js
projects` (globs `vendor/*/bin.json`, so jq is auto-covered): 27 passed, 0
failed.

## Port gotchas (full patch table in vendor/jq/README.md)

1. **`__GNUC__`-only attribute macros.** `JV_PRINTF_LIKE`/`JV_VPRINTF_LIKE` are
   defined only under `__GNUC__` with no `#else` — upstream is unbuildable on a
   non-GNU compiler. Added the empty `#else` branch.
2. **Variadic arg-count dispatch didn't re-scan.** jq's `JV_ARRAY`/`JV_OBJECT`/
   `BLOCK` use the `IDX(__VA_ARGS__, NAME_N, ..., dummy)(__VA_ARGS__)` idiom.
   This PP produces the selected `JV_ARRAY_2` token but does **not** re-invoke it
   when both the selector and the `(...)` come from the *same* replacement list
   (confirmed with a 5-line repro; the split-macro form works fine). Fix: wrap
   the dispatch in a one-arg `EXPAND(x) x` pass to force the rescan. **This is a
   latent compiler.js PP limitation** worth a proper fix later — noted, not
   chased here (the header wrap is clean and localized).
3. **GNU statement-expression `MIN`/`MAX`** (`({...})` + `__typeof__`) →
   portable ternary (jq's only use passes side-effect-free args).
4. **`const int` array bound** in jv_file.c is a VLA in C → `enum`.
5. **Zero-size `malloc`/`calloc` returns NULL** in this libc (C-legal); jq treats
   NULL as fatal OOM, assuming glibc's non-NULL-for-zero (a bytecode block with
   zero subfunctions calls `jv_mem_calloc(0, …)`). Normalized zero-size to 1 byte
   in jq's guarded allocators. **This bites every port that assumes glibc
   malloc(0) semantics** — worth remembering.
6. **libc gaps:** no `timegm`/`gmtime_r`/`strptime` → self-contained
   `jq_gucos_shims.c`; no pthreads → single-threaded `pthread.h` shim (TSD →
   per-process globals; jq's real threads are `HAVE_PTHREAD`-gated off).
7. **`-DUSE_DECNUM` was the key flag.** Without it jq silently degrades every
   number to `double` (test #117's `9E999999999` literal-preservation abort was
   the tell). With it (decNumber compiled in), arbitrary-precision number
   literals round-trip exactly, matching upstream.
8. **Math builtins are `HAVE_<FN>`-gated** — each unset one registers as
   "not defined" and its filter emits nothing ("Insufficient results"). Defined
   `-DHAVE_*` for all 44 libm functions this repo provides; the 4 missing (`fma`,
   `remainder`, `scalbln`, `lgamma_r`, Bessel) stay unsupported.

Derived files (`lexer.c`/`parser.c` from the release tarball; `builtin.inc`/
`config_opts.inc` generated per jq's Makefile recipes) are committed so no
flex/bison/autoconf step is needed.
