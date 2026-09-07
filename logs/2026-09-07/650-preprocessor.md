# #650 — serial fixes from the September project audit

User requested macro-expanded `__LINE__` first, then the other identified
issues, with serial execution and final manual end-to-end validation.
The implementation branch starts at `95223c91`; these changes serve the
gamedev epic because generated source locations and header-driven macros
are part of compiling and diagnosing C games inside gucOS.

## Presumed locations before expansion

Contract: [C11 N1570](https://www.open-std.org/jtc1/sc22/wg14/www/docs/n1570.pdf),
6.10.4 and 6.10.8.1. `#line` determines the presumed source location used by
predefined location macros, including those reached through other macros.

At the starting commit, `processTokens` adjusted directly encountered
`__LINE__`/`__FILE__` before expansion but adjusted expanded tokens only in
`emitToken`. By then a builtin had already become a literal containing the
physical location. The audit's smallest program printed `700 4` instead of
Clang's `700 700`.

Keep raw tokens physical for directive bookkeeping and relative includes.
Convert source tokens at the boundary into macro expansion, including
conditional/include operands and newly consumed arguments in trailing-call
rescans. Expanded tokens then go straight to emission without a second
adjustment. No second coordinate field or mutable shared expansion context
is necessary; included files retain their own line-control state.

The regression (committed RED as `c1276a06`) covers object/function/nested
macros, token pasting into `__LINE__`, trailing-call rescans, multiline
arguments, `#if`/`#elif`, included-file restoration, and negative offset
resets. Its literal stdout is generated and checked with native Clang.
A JS assertion additionally checks token metadata, because a correct runtime
number cannot detect source-map/diagnostic locations being adjusted twice.

Validation after the change: compiler units **843 pass, 0 fail, 3 skip**;
AST tests **140 pass, 0 fail**; existing source-map line-number verifier
passes. This is per-change evidence, **not an aggregate gate**. #650 remains
open for its other two subissues and full validation.

## Empty variadic operands and paste boundaries

RED commit e016ec8e captures the reported dangling paste and related C23
6.10.4.1 examples: left/right/chained empty operands, a macro-expanding-to-empty
argument, nested pastes retaining placemarkers, empty VA_OPT contents, and
stringized VA_OPT. Native Clang's actual output supplies the golden file.

An empty VA_OPT now supplies a placemarker. Its contents undergo parameter
substitution and internal pasting before they join the outer replacement; only
the completed outer list loses placemarkers. Stringization shares the existing
helper and removes placemarkers. Substituted parameters retain the leading
spacing of their occurrence, so a later stringization preserves token separation.

Validation: all 844 unit tests passed (3 skipped), including the new native-output
comparison, in build/status-fixes/650-vaopt-unit.log. This remains focused
validation; the aggregate gate is still pending. Redefinition diagnostics remain
the last subissue of #650.
