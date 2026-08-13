# #544 — re-vendor the clang-simplified libc pin (unblocks P0 #548)

Lane: `lane/544-libc-pin` (this repo) + `lane/544-libc-pin` in
`~/git/clang-simplified` (cross-repo pair; the sibling commit cites the
c-compiler commit it vendored from). Base `e704f078`.

## Premise verification first (the kickoff demanded it; PRINCIPLES.md re-derive rule)

The claim that this re-vendor is the fix path for #548 was relayed, not
re-derived. Re-derived all of it from current source before touching anything:

- The pin (`wasm/libc/_provenance.json`) was c-compiler `c683322` (Jul 28,
  extracted dirty). Its `__SDL.c:99` declares
  `__import void __sdl_audio_callback_unsupported(void)`; current c-compiler
  retains only a comment (host.js:7127) — af9fa850 (#491) removed the live
  binding.
- Real wasm parses (`WebAssembly.Module.imports`): of the 11 out-image
  payloads exactly doom-clang.wasm and gameboy-clang.wasm imported the retired
  symbol; the other nine were clean (sdl_demo SDL-heavy but clean — the
  positive control).
- Headless repro on the shipped tree: `doom-clang` under
  `boot.js --overlay=clang-apps` → `pid 4 crashed: LinkError ... Import #16
  "c" "__sdl_audio_callback_unsupported"`, reported `SEGV`, `DC-EXIT=139`,
  empty app log — the exact #548 signature.
- The #544 cpython claims verified too: the pin defined NONE of
  gmtime_r/tzset/clock_getres/truncate/fma/explicit_bzero (the one `truncate`
  grep hit was a comment; instrument positive-controlled) and DID have wcstol,
  matching the `-Dwcstol=__ccprobe_wcstol` rename.

**Premise verdict: HOLDS, both directions.** One re-vendor addresses both.

## What the re-vendor surfaced (beyond the ticket's list)

1. **Three libc-ext families superseded, not one.** compiler.js grew
   random/srandom/initstate/setstate (`__stdlib.c`), the full wcstol family
   (`__wchar.c`), and strptime (`__time.c`). The sibling's
   `libc-ext/__random.c`, `__wcsto.c`, `__strptime.c` became duplicate
   definitions → deleted, with their `libc.tus` lines and all three
   `HEADER_APPEND` entries (table now empty; mechanism kept). The README now
   records the supersession rule: an extension there is a maintained claim
   that upstream lacks the family.
2. **`__posix.c` is a new load-bearing TU** (todos/0382: open()/umask, *at
   family, truncate, getentropy, *conf — `__require_source`'d by fcntl.h /
   sys/stat.h / unistd.h) → added to `libc.tus`.
3. **compiler.js carried a raw newline inside asctime_r's format string**
   (the `\n` at compiler.js:34190 was unescaped inside the template literal;
   asctime one screen up uses `\\n`). compiler.js's own lexer tolerates it and
   produced the correct byte, so it was invisible upstream; clang refuses.
   Fixed upstream (one char, cooked output byte-identical) rather than
   patched at vendoring time — the extractor must not paper over upstream
   non-conformance.
4. **`HAVE_TIMEGM` turned on** in `vendor/cpython/gen/pyconfig.h`: the libc
   provides timegm now (0325 Group B), and timemodule.c's static fallback both
   collides under clang (static-after-extern) and is wrong for
   tm_year < 1970. Both toolchains now use the real one.

## Instrument trap worth recording

The extracted `__string.c` (strsignal's table) reads as binary to BSD
grep/file — a plain grep for `explicit_bzero` returned nothing and nearly
produced a false "upstream lacks it" verdict. `grep -a`. Same class as the
#623 os-common.js note.

## Verification

- musl libc-test battery (sibling `run-libc-test.sh`, needs
  `WASM_CLANG=simple1/out/clang` — the script's default `out/clang` path is
  stale): **34/34 PASS**, including wcstol, random, strptime, clock_gettime
  now served by upstream TUs.
- Full `mk-overlay.mjs` rebuild (CC_ROOT = this lane's worktree): 17
  payloads; all 11 apps parse with **zero** retired imports.
- In-OS: doom-clang boots to Doom Generic init; gameboy-clang runs its
  built-in test ROM; both formerly LinkError/139.
- Shipped-payload leg: `mkpkg --defs=... --no-baseline --clang` (91
  packages; **the bare form builds 80 and silently omits the whole -clang
  set** — verified by name), then serve dist/packages + in-OS
  `gucman install cpython-clang` → `cpython-clang -c "import sys, json,
  datetime; ..."` → `3.13.5 {"six-times-seven": 42} 1969-07-20`, exit 0.
- `node compiler.js -a link vendor/cpython/bin.json`: exactly 2 errors, both
  the #122 PyArg_ParseTupleAndKeywords pair (reference reading preserved).
- Sibling `check-libc-vendor.sh` (CC_ROOT = worktree): committed == regen.

## Gotchas for the next lane

- `python` in a fat bake dispatches to **micropython** (its cmdalt claim is
  folded and precedes any gucman-appended claim), and MicroPython's terse
  `module not found` / `no such attribute` errors do NOT name the module —
  a `python -c "import datetime"` failure there is micropython being
  micropython, not a cpython regression. Address the binary by name.
- Gated (`native-sibling`) packages are absent from the fat fold **by
  construction** (`foldPackages` → `avail` excludes them); install-time via
  gucman is their only path into an image.
- The overlay's `out-image/` provenance was stamped from the pre-commit
  dirty tree; a post-merge `mk-overlay.mjs` re-publish will stamp it clean
  (the 0340 precedent — "re-extract from the merged commit before this is
  published for real").
