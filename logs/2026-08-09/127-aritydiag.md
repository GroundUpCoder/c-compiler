# #127 — over-arity call misnamed "unprototyped" when the chain carries a prototype

Continuation of the lane that died on a session cap at `187821d7` (its commit
message said so honestly: tests INCOMPLETE). The `compiler.js` work was sound
and is kept unchanged: a `chainProtoType` stamp (`_noteChainPrototype`, the
`_noteInlineHint` pattern — invoked above the 6.2.2p4 re-declaration
`continue`s, K&R spellings skipped via the pre-existing `_isKnR` flag) plus a
wording split at the codegen definition-arity check — precise sema-style
wording when the chain carried a prototype, the honest "unprototyped" wording
only when none did.

What this pass added: the six missing `expected.*` files. Every golden was
captured through a byte-identical replica of `tests/run-unit.js`'s compile
stage (same options, same ROOT-relative paths), never hand-typed.

**Harness semantics finding, worth stating loudly:** a unit-test dir with NO
`expected.*` file is *not* skipped — `collectTests` picks up any dir with `.c`
files, and missing expectations just mean defaults (compiler exit 0, run exit
0). Since all six programs are rejected by the compiler, the inherited branch
state was six hard REDs, not a silent fake pass. Honest, but incomplete — any
unit run would have flagged it.

Red control (against unmodified `main`'s compiler, same capture rig):

- `arity_redecl_static_static`, `arity_redecl_static_extern`,
  `arity_redecl_too_few` — **RED on main** (old wording: `call to unprototyped
  function 'f' …, but the definition takes N`), green on the branch. These
  three are the fix.
- `arity_redecl_extern_nodef`, `arity_redecl_proto_control`,
  `arity_unprototyped_wording` — pass on both **by design**: the ticket's own
  table shows the no-definition sema path was already precise, and the
  negative control must keep the "unprototyped" wording when no declaration in
  the chain is a prototype.
- `arity_redecl_composite_codegen` — runs and matches `10\n10\n` (parameter
  conversion across the chain identical with and without the unprototyped
  first declaration).

Blast radius checked: the only other tests mentioning "unprototyped" are
`diag_unprototyped_argcount` (pins exit code only — its message flips to the
precise wording, which is the intended direction) and
`cg_unprototyped_fnptr_call` (function-pointer path, untouched).

Not gated yet — gate clearance is held by the coordinator while a P0 review is
in flight (heavy-lock policy).
