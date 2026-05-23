# Node.js version compatibility

**Minimum to run compiled WASM locally:** Node.js **24** with `--experimental-wasm-jspi`, or Node.js **25+** unflagged.

The compiler emits modules that use two relatively recent WebAssembly features:

- **WASM GC** (struct/array reference types) — used by codegen for value-type handling.
- **JSPI** (JavaScript Promise Integration, specifically `WebAssembly.Suspending`) — used by `host.js` to bridge synchronous-looking C I/O over async host calls.

V8's support for these features matured at different points, so older Node versions fail at different stages.

## Compatibility matrix

Smoke test: compile `vendor/hello/main.c` to `.wasm`, run via `host.js`. Full unit suite is `tests/run-unit.js` (530 tests).

| Node | hello.c (default) | hello.c (with flags) | Unit tests |
|---|---|---|---|
| 18.20.8 | ❌ no WASM GC | not achievable | — |
| 19.9.0  | ❌ no WASM GC | not achievable | — |
| 20.20.2 | ❌ no WASM GC | ❌ `--experimental-wasm-gc` doesn't accept the subtype form the compiler emits | — |
| 21.7.3  | ❌ no WASM GC | ❌ same as 20 | — |
| 22.22.3 | ❌ no `WebAssembly.Suspending` | ❌ flag exists, constructor doesn't | — |
| 23.11.1 | ❌ no `WebAssembly.Suspending` | ✅ `--experimental-wasm-jspi` | 499 / 528 pass (29 fail) |
| 24.16.0 | ❌ no `WebAssembly.Suspending` | ✅ `--experimental-wasm-jspi` | 528 / 528 pass |
| 25.8.2  | ✅ works | n/a | 528 / 528 pass |

Node 23 failures are entirely in WASM exception handling and `setjmp`/`longjmp` (`unit/exception/*`, `unit/stdlib/setjmp*`, `unit/wasm/refextern`). V8 in Node 23 ships an older revision of the exception-handling proposal than what the compiler currently emits.

## Compiling on old Node, running elsewhere

The compiler's codegen is deterministic and does not depend on Node version — every version produces byte-identical `.wasm` output for the same input. What gates older versions is the **end-of-compile validation step** in `compiler.js`, which calls `WebAssembly.validate()` on the emitted bytes as a backstop sanity check (see the `generateCode` epilogue). On Node 18–22 that validator doesn't recognize the GC type forms the compiler emits, so the build aborts even though the bytes themselves are correct.

If validation is bypassed via `--no-wasm-validate`, Node 18 produces a `hello.wasm` byte-for-byte identical to Node 25's, and that file runs fine when handed to Node 25's `host.js`. So an old Node can cross-compile, it just can't execute the result locally.

## Flags

- `--no-wasm-validate` — skip the codegen-time `WebAssembly.validate()` backstop. Lets Node 18–21 (which can't parse the GC type forms the compiler emits) finish a build. Implies `--no-version-check`, because if you're skipping validation you've already opted into knowing what you're doing.
- `--no-version-check` — suppress the startup warning about the current Node version. Doesn't change any compilation behavior, just quiets the message.

The startup warning is emitted whenever `WebAssembly.Suspending` is missing from the current runtime — that single feature gates everything host.js does. Two warning variants:

- Node < 22 (no WASM GC at all): tells you to expect a validator abort and points at `--no-wasm-validate` for cross-compile.
- Node 22–24 without JSPI: tells you compile will succeed but `host.js` won't be able to run the output here.

Node 24 invoked with `--experimental-wasm-jspi`, and Node 25+ unflagged, are silent — `WebAssembly.Suspending` is present in both cases.
