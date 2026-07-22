# 0228 — read-only string literals: dedup-off-by-default + provable-write diagnostic

**Branch**: `readonly-literals-0228` · **Todo**: `todos/0228` (design note in the todo).

## The UB being closed

String literals were **deduplicated AND writable**. Two same-spelling literals
shared one linear-memory object, and nothing stopped a UB write through a
`char *` into that object. So `char *a="x"; char *b="x"; a[0]='Y';` silently
mutated `b` too — no trap, no diagnostic, just wrong strings later. wasm linear
memory has no page protection, so clang/gcc's ".rodata write → fault" safety net
doesn't exist here; the corruption is invisible.

## Decision (from the Fable decision thread — not re-litigated)

Three parts, all shipped:

1. **Dedup OFF by default.** `getStringAddress` now keys storage by the *lexical
   EString AST node* (object identity), not by content — so each literal
   occurrence gets its own bytes, and a UB write stays **local** to the one
   literal written instead of corrupting every same-spelling use. Keying by node
   (not "fresh per call") keeps the SAME occurrence at one address across the
   const-eval and codegen passes. The node is threaded through all four call
   sites (const-eval policy, `emitStringToFrameSlot`, the EString codegen leaf,
   the global-initializer leaf).
2. **Opt-in merge flag.** `--dedup-literals` (alias `-fmerge-constants`;
   `--no-dedup-literals`/`-fno-merge-constants` force off) restores content-keyed
   merging for size-sensitive builds. Wired in the CLI, the `compilerOptions`
   default block, and `tests/run-unit.js`'s arg handler — a real first-class
   option, not a stub.
3. **Compile-time diagnostic.** A *statically provable* store through a literal —
   `"x"[i]=`, `*"x"=`, `*("x"+k)=`, `0["x"]=`, compound-assign, `++/--`, through
   decays / casts / pointer-arith / all-literal ternaries — is now a hard error
   `assignment to read-only string literal` (and `cannot {increment,decrement}
   read-only string literal`). Implemented as `exprWritesStringLiteral` /
   `exprRootsAtStringLiteral`, called from the existing assignment and inc/dec
   lvalue checks in sema (right beside the 0227 const-write check). Zero runtime
   cost; nothing correct ever hits it. A write through a *variable* that merely
   holds a literal value is not provable and stays un-diagnosed — that's exactly
   the case dedup-off localizes.

**Rejected** (per the thread): copy-on-first-use (needs page protection we
lack); diagnostic-only with dedup left on (leaves the cross-corruption in place).

## Size delta measured (justifies keeping the flag)

Full Lua 5.5 interpreter (`vendor/lua`, 33 TUs, ~323 KB wasm):

| build | data (string) section | total .wasm |
|-------|-----------------------:|------------:|
| `--dedup-literals` (old behavior) | 15 294 B | 323 202 B |
| **default (dedup off)** | **17 945 B** | **325 854 B** |
| **delta** | **+2 651 B (+17.3% of the data segment)** | **+2 652 B (+0.82% of module)** |

~17% more *string* bytes, <1% of the module. Small enough that
correctness-by-default is right; large enough that a size-sensitive build has a
real reason to opt back in — which is why the flag stays a wired option.

## SameBoy interlock: does NOT break (and why the kickoff expected it to)

The kickoff flagged "SameBoy byte-identity WILL break by design." That turned out
**not** to be the case, and the distinction matters: `tests/bench/baselines.json`
is a **framebuffer-checksum** interlock (runtime output hashes at frame
200/600/1000), and `tests/bench/run.js` only fails on a checksum mismatch or
nondeterminism — the emitted wasm **byte count is printed, never asserted**. A
correct program produces the same framebuffer no matter where its literals sit,
so a checksum interlock is layout-invariant and stays green. There is **no
wasm-byte / wasm-sha golden anywhere in the estate** that keys on literal layout,
so nothing needed rebaselining on that axis.

What *did* need rebaselining were three **unit tests that encoded the dedup-ON
assumption** (this is the real "layout/dedup-dependent golden" class):

- `unit/core/comprehensive` — literally tests `same1 == same2` expecting `1`
  ("string deduplication", per its own comment).
- `unit/stdlib/libc_conformance_edges` — computes `endptr - "123"` against a
  *fresh* `"123"` literal; only 0 when the two literals are merged.
- `unit/printf` — prints a raw `%p` address, which shifts with the data layout.

Each got a `config.json` `"compilerArgs": ["--dedup-literals"]`. That restores
their goldens **byte-identically** (dedup-on = the old layout), preserves each
test's actual intent (dedup identity / strtol endptr / printf formatting), and
incidentally exercises the flag end-to-end in the corpus — strictly better than
deleting the coverage or baking fragile layout-dependent values into goldens.

SameBoy correctness under dedup-off was still positively verified:
`test_sameboy_e2e.js` (kernel) and `os-sameboy.mjs` (browser) both pass, so the
emulator compiles and renders correctly with the new default.

## Gates (all green, in-turn)

- **Unit suite**: 771 passed, 0 failed, 3 skipped (after the 3 dedup-assuming
  goldens got `--dedup-literals`).
- **ast suite**: all green, incl. new `tests/ast/test_string_literal_dedup.js`
  (20 checks: default-no-alias, dedup-aliases, 9 reject shapes, 3 accept shapes).
- **csmith differential**: 105 passed, 0 failed (100 pinned + 5 live seeds vs
  clang-native).
- **gucOS image bake**: `mkimage --packages=all` → v144 sealed, 88.2 MiB; the
  whole system + vendor closure (doom/quake/sqlite/lua/sameboy/winmine/busybox/…)
  compiled cleanly with dedup-off — **no false-positive diagnostic anywhere in
  the real corpus**.
- **kernel e2es**: `test_sameboy_e2e` / `test_os_boot` / `test_os_apps_e2e` /
  `test_repl_pty_e2e` — 4 passed, 0 failed.
- **browser legs**: `os-sameboy` / `os-boots` / `os-doom` / `os-shell` — 4
  passed, 0 failed.

## RED→GREEN evidence (the diagnostic)

`"hello"[0]='J'` on **origin/main**: compiles clean (exit 0, emits a wasm — the
silent UB). On **this branch**: `error: assignment to read-only string literal`.
Pinned permanently by `tests/unit/conformance/diag_write_string_literal/`
(exitcode-1 diag test) and the `reject-*` cases in the ast test.

## Follow-up

Deploy is **@master's** to serialize — rides image **v146** (after the in-flight
v145 scrollback lane); this branch does NOT bump `os/image.json` and did NOT
deploy.
