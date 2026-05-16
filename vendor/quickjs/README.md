# QuickJS 2025-09-13

Unmodified upstream sources from https://bellard.org/quickjs/quickjs-2025-09-13-2.tar.xz

- **Version**: 2025-09-13 (release 2)
- **Author**: Fabrice Bellard and Charlie Gordon
- **License**: MIT (see `LICENSE`)
- **SHA256**: `996c6b5018fc955ad4d06426d0e9cb713685a00c825aa5c0418bd53f7df8b0b4`

Sources are vendored verbatim — no patches applied.

## Files

| File | LOC | Purpose |
|---|---:|---|
| `quickjs.c`       | 56 029 | The engine: parser, bytecode, VM, GC, builtins |
| `quickjs-libc.c`  |  4 342 | `std` and `os` modules — file I/O, processes, timers |
| `libregexp.c`     |  3 280 | RegExp compiler + VM |
| `libunicode.c`    |  2 123 | Unicode tables + case folding |
| `dtoa.c`          |  1 620 | Float ↔ string conversion |
| `cutils.c`        |    633 | Misc string/buffer helpers |
| `qjs.c`           |    551 | The `qjs` REPL entry point |
| `repl.js`         |     — | REPL JS implementation (bundled at runtime) |

`qjsc.c` (ahead-of-time bytecode compiler) and `run-test262.c`
(conformance harness) are intentionally excluded — neither is needed for
the interactive REPL.

## Build (not yet working)

```bash
node compiler.js -o /tmp/qjs.wasm vendor/quickjs/bin.json
node host.js /tmp/qjs.wasm
```

Expected first-light goal: `qjs >` prompt with `1+1` returning `2`.

## Build flags

`bin.json` sets:

| Flag | Purpose |
|---|---|
| `-D_GNU_SOURCE` | Match the upstream Makefile default |
| `-DEMSCRIPTEN` | Disables `CONFIG_ATOMICS` (no pthread/stdatomic) and `CONFIG_STACK_CHECK`. Bellard's "no host threads" knob. |
| `-DCONFIG_VERSION="..."` | Version string baked into the `qjs --help` banner |
