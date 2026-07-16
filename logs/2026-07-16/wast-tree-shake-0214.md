# WAST Stage 3c: tree-shake + single-use inline-and-delete + inline hints (todos/0214)

0201 shipped the whole-body inliner deliberately conservative and
deliberately non-deleting ("indices baked into call immediates + element
section") — +9.5% wasm bytes, flat speed. This stage recovers the size,
and the design work was almost entirely about ONE constraint discovered
up front.

## The constraint that shaped everything: table slots are ABI

The element section is an identity map — `table[i+1] = func i`, every
function. That means a C function pointer IS `funcIdx+1`, baked as a
plain i32 constant into code and, crucially, into DATA SEGMENTS (vtables,
callback tables, sqlite's dispatch arrays). Those constants are
unfindable post-hoc: you cannot renumber the TABLE index space, ever.

So the remap design splits the two index spaces:

- **Function index space** compacts (deleting def i shifts everything
  above it): rewritten at every index-bearing site — WCall immediates
  (the only WAST node class that carries one; WCallIndirect carries
  type/table, WRefOp/WGCOp imms are types), the export section, the name
  section (funcNames + localNames). No start section exists; sourcemap
  entries are recorded at serialize time, after the pass.
- **Table index space** does not: survivors keep their ORIGINAL slot,
  the element section goes from one identity run to skip-the-holes runs
  (`wmod.tableLayout`), the table keeps its pre-shake size. Deleted
  functions leave null slots — provably unreachable because any function
  whose table index ever ESCAPED as a value is address-taken, and
  address-taken functions are roots. Codegen records the escape at its
  three sites (emitAddressOf, function-designator-as-value, the
  constEval address policy that bakes static initializers) via
  `_funcAddrEscape`; speculative constEval over-records, which only
  keeps functions — the safe direction.

Roots = function exports + address-taken. Reachability BFS over WCall,
one sweep (transitively-dead chains need no fixpoint). A live WCall
mapping to a deleted target throws — never emit a wrong index.

## The WRaw scare (and why the fix is an invariant, not an abort)

First cut aborted the shake if any function contained WRaw — and every
real module tripped it, because libc's `fabs`/`sqrt`/reinterpret helpers
are `__wasm()` one-liners. Auditing all 63 stdlib uses (plus the two in
tests, plus vendor: zero) showed raw bytes are only flat math opcodes.
The hazard was never real WRaw content; it was the ESCAPE HATCH's
theoretical ability to encode `call N`. So the fix is a declared,
enforced invariant instead: __wasm op groups refuse function-index-
bearing opcodes (call/return_call/ref.func) at their head, WRaw is
documented reference-free, and the shake treats it as ordinary. (A raw
`op 0x10` call was already unwritable in practice — function indices
were never source-knowable.) The only remaining abort is a funcDef with
no wast tree at all (raw byte BODY — doesn't occur in the pipeline).

## What the shake actually collects

Not just 0201's stranded bodies. The per-TU AST shake keeps every
extern-linkage function ("might be called from another TU"), and default
builds don't run gcSections — so codegen was carrying the whole unused
libc surface into every module. The WAST shake is the first
whole-program liveness view:

- hello-world-with-fp-table: 219 defs -> 31, 44.6 KB -> 7.3 KB.
- SameBoy (the honest A/B, pristine main @4c5495a vs this change, same
  machine/run): 296707 -> 237095 B wasm (**-20.1%**), 127064 -> 97486
  instrs (-23.3%), code section 250202 -> 191562 B. That's -12.6% below
  even the PRE-0201 baseline (271376 B) — the +9.5% is gone with room
  to spare.
- ms/frame 6.367 -> 6.346 (flat, inside noise; the 5.5x clang gap stays
  the documented deferred item).
- **Checksums byte-identical**: 70866000 / bd26bb7b / 42d967fd at
  200/600/1000 frames, matching baselines.json AND the clang leg.

## Single-use inline-and-delete

A callee whose only reference in the module is one WCall site — and
which the shake CAN delete (not exported, not address-taken) — inlines
regardless of the size budgets: the body moves rather than duplicates.
Site counts are maintained live (a splice adds the clone's calls to
their targets' counts; a consumed site decrements), so "the last
remaining site of a twice-called callee" correctly bypasses too, and a
callee whose call-count INCREASES via splicing correctly loses the
bypass. Rooted callees get no bypass — inlining them duplicates.

## Inline hints — the attributes were parsed and thrown away

`parseGCCAttributes` collected `noinline`/`always_inline` into a flag
Set that nothing read (only `aligned` was consumed). Now: flags thread
through `parseDeclSpecifiers`/post-declarator into `DFunc.fnAttrs`
(prototype->definition merge at the prev-decl sites, per-TU like gcc),
codegen stamps `fnMeta.noinline/alwaysInline/inlineHint`, and the WAST
policy consults them: noinline = hard refusal (even single-use; also
honored by the AST-level tryInline — a pinned tiny accessor stays a
call), always_inline = size-budget bypass (localCap is an ENGINE limit
and soundness refusals are ABI facts — never bypassed), plain `inline`
= hintCalleeCap (256 vs 64). Minimal `[[gnu::noinline]]`-style C23
attribute support landed in the decl-specifier position only (the
placement real code uses); unknown [[attributes]] skip per C23 6.7.12.1.

## Differential coverage is now a committed knob

`node tests/run-unit.js --wast-inline=off|on|max` (workerData -> mutate
WAST.inlineDefaults/shakeDefaults per worker). off = both passes dead,
max = calleeCap/hintCalleeCap 2048 + callerGrowth 16000. All three green
over the 734-test corpus — deletion/remap is differentially covered on
every future run, not just in 0201's one-off validation.

## Estate fallout (all by-design, goldens updated)

- `tests/disw/compiler`: golden pinned the old module shape (dead `add`
  kept); regenerated — the disassembly now also demonstrates the shake.
- `tests/sourcemap/line_numbers`: its probe functions were single-use
  -> deleted. Marked them `__attribute__((noinline))` — preserves the
  test's per-function-attribution intent AND dogfoods the new attribute.
- `tests/ast/test_wast_passes.js`: hand-built one-function module was
  rootless -> shaken to nothing; the lone function is now exported.
- test_wast_inline.js budget-refusal cases root their callees (the
  bypass has its own pinned cases: 15 new tests across hints /
  single-use / shake mechanics / remap / e2e incl. a
  fp-through-deleted-neighbour execution check and an inlined-vs-
  original always_inline self-check through a volatile fn pointer).

## Gates

unit 723+8xfail (off/on/max identical), ast 3/3 files, run.py categories
(extra/ext/projects/zlib/lua/freetype/libpng/cairo/micropython/sqlite/
disw/sourcemap/tcc/libc/fuzz/fakegit) green, blockfs green, host green,
kernel 73/73 with a fresh v100 bake (18.6 MiB, sealed), browser sweep
27/27, SameBoy interlock sum OK both directions.

One sweep run had os-wm.mjs fail once (passed on retry and on the full
re-sweep); chasing it with `--repeat 3 --under-load` reproduces 100% —
**on pristine main too**, identical signature (the 0102 sysmenu
chord-swallow pixel probe reads black). Pre-existing, filed as P0
todos/0215, not a 0214 regression.

## Deferred / notes

- One inline->shake round, no fixpoint: a callee that becomes single-use
  only because its OTHER caller died is a missed win, not a bug.
- The AST-level INLINER honors noinline only; always_inline/hint have no
  AST-level meaning (its rule is structural: single-return-expression).
- hintCalleeCap=256 chosen conservatively; the big-callee 5.4x unlock
  (0201) stays deferred and is unaffected by this stage.
