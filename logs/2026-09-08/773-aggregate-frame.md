# #773 — aggregate return frame slots, takeover and review correction

Base: `277b14fb`. Original implementation: `70b79094`, `377a147b`,
`c9d40e0f` on `lane/773-aggregate`. This continues the work of external Fable
thread `01a07bf3-1204-7e73-9848-dccdceed4ecc` after the user's takeover request.
Independent reviewer: external Codex thread `01a07c40-5174-7433-bfa8-14573e2f46c1`.

Epic justification: aggregate-return helpers are ordinary game/toolchain code;
removing the inliner refusal benefits C and supplies the foundation requested
for Objective-C method aggregates (#775). Small-aggregate multi-value ABI work
(#774) remains separate.

## Implementation and author counter-pass

Aggregate returns now use statically assigned caller frame slots instead of
expression-time global stack-pointer bumps. Direct and indirect calls pass the
slot as their hidden return pointer. Variadic aggregate calls copy their result
out of the argument block into the slot before releasing that block. The WAST
inliner can consequently splice aggregate-returning callees normally.

The variadic SP-equality guard remains intentionally: the repo's caller-frees
alloca contract requires retaining an argument block if argument evaluation
left an alloca allocation below it. Removing aggregate bumps eliminates the
old deferredDelta adjustment, not that independent alloca requirement.

Accepted the reviewer's frame-inflation finding. At `c9d40e0f`, two exclusive
conditional arms with 35 one-KiB aggregate calls each were summed into one
frame. A permanent host regression reproduced a memory-out-of-bounds trap in
both default and no-inline modes before the fix (red-first commit `b631f9f1`).
The allocation walk now visits the condition, forks the slot cursor for the
arms, and joins at their maximum. This retains the condition and surrounding
expression's live prefix, allows different arm sizes to share max-sized slots,
and reserves enough space for subsequent calls. GNU omitted-middle conditional
thenExpr aliases the condition and is deliberately not walked a second time,
matching code emission. No stack-size increase or test threshold relaxation.

Corrected stale descriptions in the inliner design, the varargs struct test,
and host registry. The generic expression-nested-statement safety comment no
longer implies that the source parser supports GNU statement expressions:
an attempted additional probe was refused by that parser and was not retained.

## Targeted validation

Executed `node tests/host/test_aggregate_frame.js`: eight checks pass, including
both sides of the overflow reproducer in both inline modes, nested arms,
different aggregate sizes, live condition/sibling temporaries, GNU elvis, and
direct/indirect variadic aggregate results. The latter fixture also compiled
and ran with native clang, yielding `1 50`, `1 1`, `10`. Clang warns that the
saved temporary pointer expires at the end of the full expression; it is only
read by the called checker within that same full expression.

Executed the complete `node tests/ast/test_wast_inline.js`: exit 0 (transcript
`build/773/inline-takeover.log`).

The previous Fable gate at the old tip was stopped with SIGTERM before edits;
its partial artifacts and log remain, and are not green evidence. The mapper's
`--diff 277b14fb --dry-run` selects 25 suites, omitting `netsurf-patch`. A fresh
exact-source diff gate and independent re-review are still required. No new
browser/e2e test was introduced, so the new-e2e flake gate is not triggered.
