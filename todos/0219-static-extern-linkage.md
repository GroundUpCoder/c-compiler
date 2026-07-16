# 0219 — static→extern re-declaration linkage inheritance (G12)

- **Status**: open
- **Design**: CLAUDE.md "Conformance tests"; found in the 2026-07-16
  read-only bug hunt (finding G12, confirmed against clang)

## Goal

`static int x = 4; extern int x;` fails to link ("Undefined symbol 'x'").
C11 6.2.2p4: a declaration with `extern` (or, for functions via 6.2.2p5,
with no storage-class specifier) after a visible prior declaration with
internal or external linkage inherits the PRIOR declaration's linkage — the
re-declaration names the SAME internal-linkage object/function, not a new
external one. This breaks the very common pattern of a static definition in
a .c file plus an `extern` re-declaration (e.g. pulled in via a header)
later in the same TU. The function version (`static int f(void){...}
extern int f(void);`) and the block-scope version (`extern int x;` inside a
function, re-declaring a visible file-scope static) fail the same way.

Cause: sema routes every `extern` declaration into the external link
partition (`unit.externVariables` / `declaredFunctions` / `externLocals`)
and rebinds `varScope` to the new node, so uses reference a decl that
`linkTranslationUnits` then looks up in the global extern scope — which
never contains the TU-internal (static) definition.

## Plan

Sema-side linkage inheritance at the re-declaration sites (the existing
import-re-declaration precedent: keep the prior binding, drop the redundant
decl — never a linker special case):

- File-scope var: `extern` after a prior file-scope `static` DVar → the
  re-declaration is a no-op (binding stays the static decl); with an
  initializer it converts to internal linkage and lands in
  `definedVariables` so the linker reports the duplicate definition
  (clang: redefinition error).
- File-scope function decl: `extern`/no-storage-class re-declaration of a
  static DFunc → drop after the existing attribute back-propagation, keep
  the static binding.
- Block-scope `extern` var: when the visible prior binding is the
  file-scope (scope level 0) static, re-bind the block entry to it instead
  of diverting to `externLocals`.
- Block-scope function decl: same guard before the scope set.

Deliberately unchanged: the reverse order (`extern int z; static int
z = 4;` — a 6.2.2p7 violation clang rejects; this compiler currently
accepts it, the hunt's G22 diagnostic item), and `static int x; int x;`
(no `extern` → 6.2.2p5 external → p7 violation, likewise a future
diagnostic). Internal linkage stays per-TU: another TU's `extern int w;`
must NOT resolve to this TU's static `w`.

## Acceptance

- Conformance `link_static_extern_redecl` (file-scope var incl. tentative
  + later-initialized-definition chains and address-of through the
  re-declaration; function version incl. the no-storage-class p5 form;
  plain external redecl guard) and `link_static_extern_block` (block-scope
  extern var in nested blocks + block-scope function re-declaration) —
  clang-pinned outputs.
- Conformance `diag_link_static_extern_two_tu`: `static int w` in one TU +
  `extern int w;` used in another still FAILS to link (internal linkage is
  per-TU).
- `node tests/run.js unit ast` green, xfail counts unchanged; SameBoy
  framebuffer checksum interlock byte-identical (front-end-only change —
  cheap insurance, no bake/kernel/sweep).
