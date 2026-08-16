# #709 — honest opt-in null-use traps

Null dereference is C undefined behavior, so the quiet default is not a
contract violation; it is nevertheless a severe gamedev debugging cost when
a missing SDL texture becomes invisible rendering instead of a crash. The
implementation therefore adds a custom, default-off
`--trap-null-dereference` mode rather than borrowing the materially different
UBSan option family.

Checks live at semantic pointer-use seams, before member offsets and subscript
scaling. A temporary preserves single evaluation and existing order. `&*p`,
pointer formation/arithmetic, GC references, and unevaluated operands remain
outside the contract. Each source site calls a compiler-owned `noinline`
`unreachable` thunk whose always-emitted name is the diagnostic marker. This
accepts the current module architecture's per-thunk function/table/element and
name cost; #709 does not rewrite table identity rules for a debug option.

A low dead page was rejected: Wasm cannot protect it, so it would only move
corruption while shifting every static/heap address and charging 64 KiB per
process. The existing crash path supplies SIGSEGV-style status 139 in both
boot and browser hosts once instrumentation deliberately produces a trap.

## Measured cost at implementation tip

The one-site probe measured 176 bytes default, 261 enabled, and 378 enabled
with `-g`. Enabled added one function, one table slot/element entry, 16 code
section bytes, and a 60-byte name section (118-byte names plus a 57-byte
source map under `-g`).

`vendor/doom/bin.json` measured 518,156 bytes default, 1,441,863 enabled, and
1,506,468 enabled with `-g`. The enabled build carried 7,241 distinct named
dynamic sites; function count grew 485 -> 7,746, table minimum 1,746 ->
10,036, element entries 623 -> 7,884, code section 333,519 -> 475,955 bytes,
and the name section was 759,087 bytes (787,248 with `-g`, plus a 36,440-byte
source map). These large diagnostics costs are reported facts, not hidden by
a threshold or a direct-only table rewrite.

A 50,000,000-iteration non-null volatile-pointer loop on this host (Node
25.8.2, seven runs, first tier-up run retained but median reported) measured
11.298 ms default versus 11.407 ms enabled, about +0.97%. This is a narrow
steady-state probe, not a general performance promise.
