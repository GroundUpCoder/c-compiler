# The five light P1 findings of #502 Pass A round 2 — #707 #710 #711 #708 (+#712 held)

Lane `lane/502-light`, worktree off `main @ c13e6743`. All four implemented
tickets are findings the #502 round-2 dogfood agent measured while writing an
asteroids game in C+SDL3 inside gucOS; clearing them (plus #712) unblocks #713
(round 3). One `os/image.json` bump (269 → 270) covers the whole batch:
#707/#710 edit baked content, #708/#711 edit `compiler.js`, a bake input the
in-browser OPFS gate can only see through the version.

## #707 — Sint8/Sint64 (commit 855cacf0)

The ticket (measured at 71ad436e) asked for three typedefs; at c13e6743 only
two were missing — `Sint16` had already landed with #607's gamepad work.
Re-derivation from current source caught that before the edit. The warned-of
absence pin did not exist: nothing in `tests/` names `Sint8`/`Sint64`
(positive control: `Sint16` DOES hit the #607 tests, so the scan finds present
symbols), and mksdlindex's ABSENT list never claimed the family. The only
recorded absence was the generated Types section of `sdl-api-index.md`, which
regenerates. The new `test_sdl_api_index.js` leg pins presence, widths AND
signedness at compile time (`_Static_assert`) — a wrong width would corrupt
PCM silently, far from the typedef.

## #710 — cc refuses unknown options (commit 2b26fc48)

The judgement call the ticket left open — warn-and-continue vs hard error, and
whether `-lm` gets an allowlist — resolved to: hard error, no allowlist.
Accepting `-lm` because math happens to be builtin is exactly how the dogfood
agent formed the false belief that `-l` linking exists; the refusal carries a
one-line hint naming the honest path (`__require_source`, toolchain.md)
instead. What made this more than a one-line change: the silent ignore was a
DOCUMENTED contract — `toolchain.md` shipped it as a Warning, `GCODE.md`
taught it to the gcode agent, and `test_gcode_orientation.js` pinned it
behaviorally ("silently ignores -Wall/-O2… exit 0"). All three flipped in the
same commit as the behavior — the #710 analog of "an absence assertion is a
maintained claim". The host CLI (`node compiler.js`) keeps its own ignore
behavior: the ticket names the in-OS surface, and the CLI's flag surface is a
different contract with different consumers (deliberately not expanded here).

## #711 — destroyed-renderer honesty (commit da9d36bd)

Took the ticket's "invalidate on destroy plus one guard" suggestion: a
`__SDL_REN_MAGIC` tag (the `__SDL_TEX_MAGIC` precedent, same documented
best-effort-against-freed-memory caveat) plus one `__sdl_renderer_live()`
used at every entry point taking `SDL_Renderer*` — all ~25, not just the
eight the probe measured (CORE PRINCIPLE: the general case, not the demo's).
The window-liveness conjunct (`__sdl_window_live(r->window)`) makes the
mode-3 case (window destroyed, renderer dangling) fail identically without a
second mechanism. Two things surfaced while writing it:

- the OLD code double-frees on the new test's inputs (destroy-then-use pins
  it) — the magic gate kills a latent double-free, not just the dishonest
  success;
- `SDL_DestroyRenderer` after `SDL_DestroyWindow` is the ordinary teardown
  order, so the destroy path gates on the magic ONLY — a full liveness gate
  there would have turned every well-formed teardown into an error.

Rejected: per-entry-point checks against the window's renderer slot (nine
bespoke guards, no double-free protection, no uniform story for getters).

## #708 — name the unknown type (commit 640bfe9b)

The ticket's mechanism claim ("the identifier was consumed and discarded by
the loop") is not what current source does: the specifier loop breaks on the
unresolved identifier WITHOUT consuming it, so `this.peek()` at the error
site already IS the identifier. The whole fix is a two-token lookahead at the
existing error site: IDENT followed by a declarator opener (IDENT or `*`) →
`unknown type name 'X'`; anything else keeps the implicit-int wording, and
the bare block-scope statement shape keeps its expression-path "Undeclared
identifier". Deliberately NOT done: a column in the diagnostic. The estate's
diagnostic format is `file:line` everywhere (`fatalError`/`Loc`); changing it
is a format migration, not a light ticket rider. Wording pins: swept — none
existed; the conformance `diag_*` convention (exit-code-only) is exactly why,
so the new message assertions live in a host member
(`test_unknown_type_diag.js`) driven through `createCcDriver`, the surface
the finding was measured on.

## #712 — HELD (no commit)

The ticket's fork — enforce the exit-69 blocking-loop refusal in `boot.js`
too, or scope the `sdl-gucos.md` claim to the browser host — is a policy
call reserved for @master. Mechanism re-verified at c13e6743: the guard
exists only in the browser flavor (`host.js:8397/8442/8484`); the headless
present path has none. Recommendation posted to the lane thread: enforce
uniformly (the check is a policy on program shape, not a faked GPU
semantic, and boot.js is where iteration happens) — CONDITIONAL on first
measuring which existing headless tests/tools present GPU-tier from a
blocking main; if that set is more than trivial, the conversions exceed
"light" and the honest fallback is doc-scoping now + a `--strict-present`
opt-in, with (b) refiled at its true weight.

## Verification discipline

Every ticket's test ran RED against the pre-fix tree (stash/pop) before its
commit — including the #710 leg, whose old form was itself a pin of the
behavior being removed. Full unit suite green at #708 (837/840, 3
pre-existing skips). The landing gate (`tests/run.js --diff origin/main`)
runs after this log's commit; #708/#711 touch `compiler.js`, so it selects
the full 25-suite estate.
