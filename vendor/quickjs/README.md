# QuickJS 2025-09-13

Upstream sources from https://bellard.org/quickjs/quickjs-2025-09-13-2.tar.xz

- **Version**: 2025-09-13 (release 2)
- **Author**: Fabrice Bellard and Charlie Gordon
- **License**: MIT (see `LICENSE`)
- **SHA256**: `996c6b5018fc955ad4d06426d0e9cb713685a00c825aa5c0418bd53f7df8b0b4`

## Status

**The full QuickJS engine + libc + REPL entry point compiles and runs
on our compiler.** 737 KB wasm. Direct eval works:

```
$ node host.js /tmp/qjs.wasm -e 'console.log(1 + 1)'
2
$ node host.js /tmp/qjs.wasm -e '
  const fib = n => n < 2 ? n : fib(n-1) + fib(n-2);
  console.log("fib(15) =", fib(15));
  console.log("regex:", /\bhello\s+(\w+)/.exec("hello world!")[1]);
  console.log("json:", JSON.stringify({a: [1,2], b: "x"}));
'
fib(15) = 610
regex: world
json: {"a":[1,2],"b":"x"}
```

Recursion, arrow functions, `Array.map`, regex with capture groups,
JSON, ES6 classes — all working.

The **interactive REPL** (`node host.js /tmp/qjs.wasm` with no `-e`)
needs the precompiled `qjsc_repl[]` bytecode produced by the AOT
compiler `qjsc.c`. We ship an empty `repl_stub.c` so things link; a
follow-up will build `qjsc.c` separately and use it to generate the
real REPL bytecode from `repl.js`.

| File | LOC | Status |
|---|---:|---|
| `cutils.c`        |    633 | ✅ |
| `dtoa.c`          |  1 620 | ✅ |
| `libregexp.c`     |  3 280 | ✅ (patched: added `<alloca.h>`) |
| `libunicode.c`    |  2 123 | ✅ |
| `quickjs.c`       | 56 029 | ✅ (patched: added `<alloca.h>`) |
| `quickjs-libc.c`  |  4 342 | ✅ (patched: `USE_WORKER` disabled) |
| `qjs.c`           |    551 | ✅ |
| `repl_stub.c`     |     12 | ✅ (our shim — placeholder for `qjsc -e repl.js` output) |

## Build

```bash
node compiler.js -o /tmp/qjs.wasm vendor/quickjs/bin.json
node host.js /tmp/qjs.wasm -e '1+1'
```

## Build flags

| Flag | Purpose |
|---|---|
| `-D_GNU_SOURCE` | Match the upstream Makefile default |
| `-DEMSCRIPTEN` | Bellard's "no host threads" knob — disables `CONFIG_ATOMICS` (no pthread/stdatomic), `CONFIG_STACK_CHECK`, and routes `malloc_usable_size` to `return 0` |
| `-DCONFIG_VERSION="..."` | Version string baked into `qjs --help` |
| `--allow-zero-length-arrays` | Compiler flag: enables the GCC legacy zero-length-array extension. QuickJS's `JSString` uses `union { uint8_t str8[0]; uint16_t str16[0]; } u;` as a type-alias for the trailing overallocated buffer |

## Patches applied to upstream

Minimal:

- **`quickjs.c`** — add `#include <alloca.h>` (after `<assert.h>`).
  QuickJS calls `alloca()` directly, relying on glibc's `<stdlib.h>` to
  pull it in transitively.
- **`libregexp.c`** — same `#include <alloca.h>` fix.
- **`quickjs-libc.c`** — comment out `#define USE_WORKER` at line 68.
  `os.Worker` would need real OS threads (the wasm-threads proposal +
  JS-side worker spawning); not in scope.

## Local files (not upstream)

- **`repl_stub.c`** — provides empty `qjsc_repl[]` and `qjsc_repl_size`
  so `qjs.c` links. The interactive REPL won't work until we generate
  the real bytecode by running `qjsc` over `repl.js`. Direct eval
  (`qjs -e '...'`) bypasses the bytecode load and works fully.

## Compiler / stdlib gaps closed along the way

- **`parser`: enum tag names live in their own namespace** — `typedef enum
  X X;` no longer prevents a later `enum X { ... }` definition. Surfaced
  by `quickjs.c:231` / `:1044`. Tag/typedef namespaces are distinct per
  C99 §6.2.3.
- **`parser`: `--allow-zero-length-arrays` flag** — gates the legacy GCC
  extension (multiple `arr[0]` per struct, allowed in unions, not
  necessarily last). C99-strict behavior is still the default.
- **Stub headers added**: `<dlfcn.h>` (always-fails `dlopen`/`dlsym`),
  `<sys/wait.h>` (always-fails `waitpid`).
- **`<sys/time.h>`** now transitively includes `<sys/select.h>`
  (matching glibc's behavior under `_GNU_SOURCE`).
- **`<sys/stat.h>`** gained `st_rdev`, POSIX 2008 nanosecond fields
  (`st_atim` / `st_mtim` / `st_ctim`), and `S_ISUID` / `S_ISGID` / `S_ISVTX`.
- **`<signal.h>`** gained `sighandler_t` / `sig_t` typedefs and the
  full POSIX signal-number set (`SIGHUP`, `SIGPIPE`, `SIGCHLD`, etc.).
- **`<unistd.h>`** gained `extern char **environ;` and stub bodies for
  `fork`, `execve`, `_exit`, `sysconf`, `setuid`, `setgid`, `kill`
  (all fail at runtime — POSIX process management isn't reachable in
  our wasm host).
- **`<stdio.h>`** gained `fdopen` / `fileno` declarations + bodies.

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
| `repl_stub.c` | Empty `qjsc_repl[]` stub — replace once `qjsc` is buildable |

`qjsc.c` (ahead-of-time bytecode compiler) and `run-test262.c`
(conformance harness) are intentionally excluded.

## Next

To get the interactive REPL working:

1. Build `qjsc.c` separately (similar header gaps to overcome — it's a
   small tool, shouldn't need much).
2. Run `qjsc -c -m -o repl.c repl.js` to produce the real bytecode.
3. Drop `repl_stub.c` from `bin.json` and add the generated `repl.c`.
