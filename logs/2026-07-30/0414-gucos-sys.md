# 0414 — gucos-sys: the ONE Rust binding to the "c" ABI (Lane A2)

The sibling repository `~/git/gucos-rust` now holds `crates/gucos-sys`: the
single Rust declaration of the gucOS `"c"` import set (86 imports, one
family per file, one attributed extern block per file, safe wrappers over
private raw blocks), a `#[global_allocator]` that delegates to libc
`malloc`/`free`/`realloc`, the malloc-backed `alloca` export, and a panic
handler that reports on stderr and exits 101. The 0413 static-arena
`alloca` is deleted. `crates/alloc-demo` is the acceptance program;
`crates/hello-gucos` now reaches the host only through gucos-sys.

## The load-bearing discovery: `__import` does not authorize undefinedness

The plan said "link the vendored C libc for the bodies Rust needs". The
first real link refuted the obvious mechanism. The vendored libc marks a
host import `__import` = `__attribute__((import_module("c")))`. wasm-ld
records the module, but the attribute does NOT permit the symbol to stay
undefined — only an explicit `import_name` attribute or an allow flag
does. rustc's `#[link(wasm_import_module = "c")]` sets both, which is why
0413 linked clean. A C object's `write` reference therefore fails a
`--allow-undefined`-free link even though it is a legitimate "c" import.
This is exactly why cc2wasm links with blanket `--allow-undefined`.

The resolution keeps the ticket's loud-failure rule intact:
`--allow-undefined-file` over a list derived mechanically from the libc's
own `__import` declarations (187 names). A listed symbol becomes a module
`"c"` import (the object's import_module attribute still names the
module); an UNLISTED undefined symbol still fails at link time with its
name. Verified both directions with minimal objects before adopting it.

## The runtime objects

`build.sh` compiles `__malloc __stdlib __string __stdio __errno` from
`clang-simplified/wasm/libc` with cc2wasm's exact CFLAGS and links the .o
files into every program via `-C link-arg`. `__stdio` is in the set only
because `__malloc.c`'s corruption reports call `puts`. rust-lld links
clang-emitted wasm objects without complaint; `--gc-sections` keeps unused
libc bodies (and their host imports) out — both shipped fixtures import
only `write` and `__exit`. `--export-if-defined=__errno_set` re-exports
the errno channel so the host can report errors; Rust reads the same C
`errno` global (one errno for both languages).

Duplicate-symbol worry that did not materialize: Rust's compiler_builtins
memcpy/memset vs `__string.o` — no collision surfaced in any link.

## Notes for later lanes

- A bare `cargo build` of a program crate fails with
  `undefined symbol: malloc`. Correct: build.sh is the one build entry
  (the runtime objects and the allow-list come from it).
- The kernel test gained legs: alloc fixture (sha-pinned, in-OS spawn),
  the interop line (`interop strdups=32 len_ok=true vec_intact=true` —
  interleaved Rust/C allocation on the one heap), the absent-import
  negative (fails AT LOAD, message names `__gucos_absent_import` and
  `"c"`), and the single-declaration guard (scans the sibling: no
  wasm_import_module outside gucos-sys/src, no name declared twice).
- In-OS, a process's fd-2 writes surface on boot.js's STDERR, not in the
  tty stdout capture — the panic-message assertion checks both streams.
- Families deliberately not declared in Rust (math, printf/scanf/strtod
  glue, setjmp/longjmp, SDL/WebGPU veneers, emscripten shims, ss helpers,
  legacy aliases mkdir/__tcgetattr/__tcsetattr) are recorded with reasons
  in the gucos-sys lib.rs header.

Cross-refs: todos/done/0414, todos/RUST.md §2–3, todos/done/0413,
tests/kernel/test_rust_e2e.js, gucos-rust @ the SHA in the ticket Result.
