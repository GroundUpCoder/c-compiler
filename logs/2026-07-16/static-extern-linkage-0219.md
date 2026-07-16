# 0219 — static→extern re-declaration linkage inheritance (G12)

Confirmed finding G12 from the 2026-07-16 read-only bug hunt: `static int
x = 4; extern int x;` failed to link ("Undefined symbol 'x'"). clang is the
oracle; every case below was pinned against it before the fix.

## The shape of the bug

C11 6.2.2p4: a declaration with `extern` (or, for functions via 6.2.2p5,
with no storage-class specifier) in a scope where a prior declaration of
the identifier is visible inherits the PRIOR declaration's linkage. So the
`extern` re-declaration after a file-scope `static` has INTERNAL linkage —
it names the same static object/function. This is the very common pattern
of a static definition in a .c file plus an `extern` re-declaration pulled
in later (e.g. via a header) in the same TU.

The failure wasn't really the linker's hard `isStatic` partition — it was
sema feeding it wrong linkage: every `extern` decl was routed into the
external partition (`unit.externVariables` / `declaredFunctions` /
`externLocals`) AND `varScope` was re-bound to the new node, so uses after
the re-declaration referenced a decl that `linkTranslationUnits` looked up
in the global extern scope, which never contains TU-internal definitions.
(The reverse order "worked" by accident: uses bind the later static, and
the per-TU tree-shake prunes the dead extern decl before linking.)

## The fix (sema only — no linker change)

The existing import-re-declaration precedent (SQLite's `extern int
isatty(int);` after the stdlib import) already had the right shape: keep
the prior binding, drop the redundant re-declaration. Four sites:

- **File-scope var**: `extern` after a file-scope static DVar → `continue`
  (binding stays the static decl; uses, `&x`, and the reference bags all
  hit the real definition — no forwarding node for the per-TU shake or
  `markAddressTaken` to lose). With an initializer it converts to internal
  linkage and joins `definedVariables`: one object either way. The
  redefinition diagnostic clang emits there is a PRE-EXISTING gap shared
  with `static int x = 4; static int x = 5;` (also silently accepted) —
  a future diagnostics item, not cemented here.
- **File-scope function decl**: `extern` / no-storage-class re-declaration
  of a static DFunc → drop, placed AFTER the attribute merge block so a
  re-decl's `__attribute__`s still back-propagate onto the definition.
- **Block-scope extern var**: when the visible prior binding IS the
  level-0 (file-scope) binding — an identity check, not a level check —
  re-bind the block entry to it instead of diverting to `externLocals`.
  Identity matters twice: an `extern` in an enclosing block re-bound the
  SAME file-scope node at its own level (so nested `extern int x;` blocks
  chain — the level check failed exactly there on the first try), and a
  static LOCAL is a different node (block statics have NO linkage per
  6.2.2p6, which p4 does NOT inherit — those stay on the old path).
- **Block-scope function decl**: same guard before the scope set.

Deliberately unchanged: `extern int z; static int z = 4;` (a 6.2.2p7
violation clang rejects; this compiler still silently accepts it and binds
the static — the hunt's G22 diagnostic item, order verified untouched),
and `static int x; int x;` (no `extern`, same future-diagnostic family).

## Tests

- `tests/unit/conformance/link_static_extern_redecl` — file-scope var
  (incl. tentative chains `static int t; extern int t;`, a
  later-initialized-definition chain, `&x` through the re-declaration),
  function form + the 6.2.2p5 no-storage-class form, plain external
  redecl guard. Failed pre-fix (3 link errors), clang-pinned
  `4 4 5 8 7 9 6`.
- `tests/unit/conformance/link_static_extern_block` — block-scope extern
  var in sibling + nested blocks (mutation visible through all bindings),
  block-scope function re-declaration. Failed pre-fix, clang-pinned `14 7`.
- `tests/unit/conformance/diag_link_static_extern_two_tu` — internal
  linkage stays per-TU: `static int w` in one TU + used `extern int w;`
  in another must still FAIL to link (green before AND after — the guard
  that the fix didn't over-reach across TUs; clang: ld undefined symbol).
- `tests/unit/core/extern_local_shadow` — the pre-existing golden ENCODED
  the bug: it expected the block-scope `extern int x;` under a visible
  file-scope static to reach helper.c's external x (`10 20 10 77 55 77`).
  clang prints `10 10 10 10 55 55` (the block extern binds the internal
  x; helper.c's x is a separate object). Golden replaced with the
  clang-verified output, comments rewritten. (The "goldens may encode
  bugs" class — this one from the suite's early days.)

## Gate

- `node tests/run.js unit ast` green (738 passed, 0 failed, 8 xfailed —
  unchanged, no xpass — 3 skipped; conformance rides the unit suite).
- SameBoy interlock, strongest form: the emitted wasm is BYTE-IDENTICAL
  (`cmp` clean, 237095 B) between the pre-change compiler (HEAD build) and
  the fixed one over the full 15-file SameBoy core build, and framebuffer
  checksums equal clang's at N=200/600/1000 (70866000 / bd26bb7b /
  42d967fd).
- **No mkimage/kernel/browser sweep run — decision per the gating
  policy**: sema-front-end-only change whose new paths only trigger on
  code that previously FAILED to link (or, block-scope, mislinked in a
  way no vendor code exercises — they all build under clang/gcc upstream,
  which enforce 6.2.2p4), and the interlock is byte-identical, so the
  fast gate + interlock is the sufficient gate for this layer (the
  0217/0218 precedent).
