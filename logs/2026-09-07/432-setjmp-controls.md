# #432 — complete the standard setjmp controlling-expression contexts

The old matcher recognized direct/not/zero-equality if/while conditions and
switch values, but rejected nonzero comparisons and do/for controls. The new
standard matcher admits the six relational/equality operators with an integer
constant expression on either side, preserving implicit arithmetic conversions.
If comparisons reuse the existing armed-temp technique that switch used.

Loops require a distinction between an ordinary condition evaluation (re-arm,
return0) and a caught longjmp (resume that condition with the supplied value).
The implementation keeps ONE original body in ONE protected region, using the
existing goto and EH lowering. Scoped break/continue redirection preserves
nested switch versus loop ownership. For initialization happens once, continue
runs the increment, and a caught jump skips both initialization and increment.
An armed bit makes an exception from the first do body or the for initializer
propagate to an older environment instead of claiming an environment that has
not yet been saved. The protected remainder retains the environment for jumps
after the loop, following the existing setjmp lowering's lexical-tail model.
No duplicate bodies, labels, automatic-variable identities or custom runtime
exception protocol are introduced.

REDedb4d284: three new Clang-verified conformance fixtures rejected on the old
tree (432-red-control:11 existing pass,3 new fail). The initial comma-separated
unit filter selected0 cases and is not red evidence. Tests cover all six
comparisons, integer promotions, sizeof/enum/arithmetic constants, zero-to-one
longjmp coercion, first break/continue, nested loop/switch control, for-scoped
volatile initialization, increment longjmp, and jumps after loops. Native
Clang -std=c11 -O0 binaries were executed to write the expected.stdout files.

Focused14/14 pass. Whole-unit initial846P1F3S failed only on the newly changed
supported-context diagnostic golden, now updated; subsequent847P0F3S passes.
AST category6/6 passes. The forbidden bare setjmp assignment remains rejected.
The conformance residue and L76 are retired with this implementation.

Projects finished29P0F1S in246.9s (432-unit-projects); the dispatcher finished
with unit and projects both pass. The campaign still owes the fresh full gate and final manual browser/headless use;
these focused checks are not a shipping claim. No merge/deploy occurred.
