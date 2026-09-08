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

## Second counter-pass: byte layout, not ordinal maxima

The independent re-review at `12923199` found that ordinal pooling still sums
incompatible layouts: [large, small] versus [small, large] becomes two large
slots. Accepted and reproduced in a second red-first commit `95891857`, with
40,000-byte results returned from static callee storage (so the callee does not
itself require another large stack frame). Both inline modes trapped. The
reviewer separately verified its reproducer succeeds at `277b14fb` in both modes.
The gate at `12923199` was stopped before further source edits; its partial
artifacts remain under `build/773/takeover-gate` and are not completion evidence.

The final allocator uses an aligned BYTE cursor per path and a high-water size
for one shared frame arena. Each call has its own relative byte offset. Branch
joins take max(cursor), statements start at zero, and the arena base aligns to
the maximum required alignment. This also avoids opposite-sized slot inflation
across independent statements. The full expression's live prefix is never reset
at a conditional join. The generic walk retains its conservative lifetime rule.

All 12 host checks now pass, including opposite-sized branches and independent
statements, plus 64-byte aligned results after a small live prefix and before a
live sibling. Both inline modes verify addresses and values. No stack limit was
changed. A new exact-tip review and fresh gate must adjudicate this revision.

## Third counter-pass: full-expression boundaries in for clauses

My own follow-up probe found that a35036df still summed separate for condition
and increment expressions (80,000-byte main frame for two 40,000-byte results).
The CLI warned about the frame and execution trapped. Added a permanent red-first
host test in `12f2ebe2`, including an aggregate call in the initializer too.

The walk now resets the cursor for separate SFor clauses and SDecl initializers,
as well as the existing statement boundaries, unless already nested beneath an
expression. This is deliberately not a blanket rule for all statement children:
SThrow arguments must remain live together. Examined all current statement AST
shapes to establish that distinction. All 14 host checks pass in the fixed tree.
The a35036df gate was interrupted before edits and its log/artifacts preserved;
review must settle before another broad gate begins.

## Completed review and fresh regression gate

Final code/test tip: `48eeee5dcabe8bd73570a3a3a584ae5cc0685afb`.
The independent Codex reviewer cleared the complete `277b14fb..48eeee5d` range,
including its own opposite-size, throw-argument lifetime, and large declarator
initializer probes in both inline modes. After the user's Astra-only instruction,
I explicitly pinned that external reviewer thread to `gpt-6-astra`, re-read its
metadata to verify the model, and obtained a fresh exact-tip reconfirmation:
no blocking findings, all 14 aggregate checks pass, clean worktree. This does not
relabel the original Fable implementation or earlier unpinned review turns.

The first complete-gate attempt stopped without a completion summary; it is not
a pass. The final run used a detached persistent shell runner, preserving the
start record and exit status independently of chat tool sessions:

```
node tests/run.js --diff 277b14fb --out=build/773/verified-gate
```

Run `20260908-024919-37535`: **exit 0**, elapsed **3,666,969 ms (61.1 min)**.
Its own fresh dispatcher summary has a null filter, 25 selected suites and all
seven execution rows literally `pass`. Nineteen Python categories share one row.
This is the required **diff gate**, not the ship tier: `netsurf-patch` is omitted.
No deployment is part of #773 completion.

| Execution row | Verified result |
|---|---|
| todos | pass |
| unit | 848 pass, 0 fail, 3 skip |
| host | pass, including all 14 aggregate checks |
| BlockFS | 15/15 pass |
| Python batch | 903 pass, 0 fail, 112 skip; skip baseline checked, zero violations |
| kernel | 199/199 pass |
| browser sweep | 69/69 pass |

The kernel, browser and BlockFS manifests are fresh, done, unfiltered, and have
executed = selected = recorded = total, zero resumed/carried, and exclusively
pass member results. The source commit and clean worktree were checked after
completion. Compiler SHA-256:
`8f5a052e8a2ecdc1f45748495e9747838f2a59b52ace4cd646b404b77cd84eef`.

Evidence: `build/773/verified-gate/summary.json`, `verified-gate.log`,
`verified-gate.exit`, `verified-gate-start.json`, and `validation-final.json`
(the latter records scope and hashes of compiler, log and child manifests).
Interrupted runs remain separately recorded and are not included in these counts.
The closing documentation commit changes no code or tests; it requires a final
exact-tip documentation review before push, not another unchanged-source gate.
