# QuickJS 2025-09-13

Upstream sources from https://bellard.org/quickjs/quickjs-2025-09-13-2.tar.xz

- **Version**: 2025-09-13 (release 2)
- **Author**: Fabrice Bellard and Charlie Gordon
- **License**: MIT (see `LICENSE`)
- **SHA256**: `996c6b5018fc955ad4d06426d0e9cb713685a00c825aa5c0418bd53f7df8b0b4`

## Status

**Engine library compiles end-to-end** to a ~696 KB wasm with no source
changes beyond two `#include <alloca.h>` lines. The REPL (qjs.c +
quickjs-libc.c) is not yet wired up.

| File | LOC | Status |
|---|---:|---|
| `cutils.c`        |    633 | ✅ |
| `dtoa.c`          |  1 620 | ✅ |
| `libregexp.c`     |  3 280 | ✅ (patched: added `<alloca.h>`) |
| `libunicode.c`    |  2 123 | ✅ |
| `quickjs.c`       | 56 029 | ✅ (patched: added `<alloca.h>`) |
| `quickjs-libc.c`  |  4 342 | ⏳ needs pthread/dlfcn/sys-wait stub headers |
| `qjs.c`           |    551 | ⏳ depends on quickjs-libc.h |

## Build (engine library)

```bash
node compiler.js -o /tmp/qjs-engine.wasm vendor/quickjs/bin.json
```

This produces a wasm library. The intended consumer is a `qjs` REPL
build that adds `qjs.c` + a wired-up `quickjs-libc.c` (see "Next" below).

## Build flags

| Flag | Purpose |
|---|---|
| `-D_GNU_SOURCE` | Match the upstream Makefile default |
| `-DEMSCRIPTEN` | Bellard's "no host threads" knob — disables `CONFIG_ATOMICS` (no pthread/stdatomic), `CONFIG_STACK_CHECK`, and routes `malloc_usable_size` to `return 0` |
| `-DCONFIG_VERSION="..."` | Version string baked into `qjs --help` |
| `--allow-zero-length-arrays` | Compiler flag: enables the GCC legacy zero-length-array extension. QuickJS's `JSString` uses `union { uint8_t str8[0]; uint16_t str16[0]; } u;` as a type-alias for the trailing overallocated buffer |

## Patches applied to upstream

Minimal, listed verbatim:

- **`quickjs.c`** — add `#include <alloca.h>` (after `<assert.h>`).
  QuickJS calls `alloca()` directly, relying on glibc's `<stdlib.h>` to
  pull it in transitively. Our `<stdlib.h>` doesn't; explicit include
  is portable and aligns with `<alloca.h>`'s own purpose.
- **`libregexp.c`** — same `#include <alloca.h>` fix.

## Compiler / stdlib gaps closed along the way

- **`parser`: enum tag names live in their own namespace** — `typedef enum
  X X;` no longer prevents a later `enum X { ... }` definition. Surfaced
  by `quickjs.c:231` / `:1044`. Tag/typedef namespaces are distinct per
  C99 §6.2.3; the parser was treating any prior typedef of the same name
  as a reason to refuse the IDENT as a tag.
- **`parser`: `--allow-zero-length-arrays` flag** — gates the legacy GCC
  extension (multiple `arr[0]` per struct, allowed in unions, not
  necessarily last). C99-strict behavior is still the default.

## Files

| File | Purpose |
|---|---|
| `quickjs.c` (~56 KLOC) | The engine: parser, bytecode, VM, GC, builtins |
| `quickjs-libc.c` (~4.3 KLOC) | `std` and `os` modules — file I/O, processes, timers |
| `libregexp.c` (~3.3 KLOC) | RegExp compiler + VM |
| `libunicode.c` (~2.1 KLOC) | Unicode tables + case folding |
| `dtoa.c` (~1.6 KLOC) | Float ↔ string conversion |
| `cutils.c` (~633 LOC) | Misc string/buffer helpers |
| `qjs.c` (~551 LOC) | The `qjs` REPL entry point |
| `repl.js` | REPL JS implementation (bundled at runtime) |

`qjsc.c` (ahead-of-time bytecode compiler) and `run-test262.c`
(conformance harness) are intentionally excluded — neither is needed
for the interactive REPL.

## Next

Getting to the `qjs >` REPL requires bringing in `quickjs-libc.c` and
`qjs.c`. Open work:

1. Patch out or guard the unconditional `#define USE_WORKER` in
   `quickjs-libc.c:69` — gates `<pthread.h>` and `<stdatomic.h>` includes.
2. Either patch the unconditional `<dlfcn.h>`, `<termios.h>`,
   `<sys/ioctl.h>`, `<sys/wait.h>` includes, or provide stub headers.
3. `qjs.c` uses `malloc_usable_size` without an `EMSCRIPTEN` branch —
   add the branch (one-line upstream patch) or add the symbol to our
   stdlib.
