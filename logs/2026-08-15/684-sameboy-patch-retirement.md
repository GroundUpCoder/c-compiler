# #684 — sameboy patch retirement: measure-first pays off twice

Ticket #684 said two rows of `vendor/sameboy/README.md`'s patch table were
false: the `gb.c` rtc-section VLA row ("offsetof doesn't fold" — fixed by
`bfe4edc5`) and the elvis row ("no GNU elvis operator" — #681 landed it at
`8999f38d`). Measured both through the real cc driver before editing, with
positive controls (a syntax error and a `({…})` statement expression, both
required to FAIL) so a broken harness could not read as a confirmed absence.

## Row 1: the claim was false but the PATCH still stands

Plain-member `offsetof` arithmetic folds fine (the exact SameBoy shape
compiled and ran: `size=8`), and so does `offsetof` of a zero-length-array
member. But restoring upstream's `uint8_t rtc_section[GB_SECTION_SIZE(rtc)]`
still failed: **`offsetof` through an anonymous union/struct member does not
fold to an integer constant expression.** `GB_SECTION(name, …)` expands to
`union { uint8_t name##_section_start; struct {…}; }` — the marker is an
anonymous-member path, so the array bound is still classified as a VLA.
Isolated probe pair: anonymous-member bound → "variable-length arrays are not
supported"; same struct with named members → folds.

So the patch stays, and the README row now states the *measured* reason
instead of the false general one. This is the ticket's own standard: remove
the row and build unpatched, or state the real remaining reason — never a
third thing. The anonymous-member fold gap is a real compiler feature-gap;
left for @master to file (lanes don't file tickets).

## Row 2: retired clean

All 5 `x ?: y → x ? x : y` sites (apu.c ×3, display.c, sgb.c) restored to
byte-exact upstream text. The rewrite's standing caveat ("operands
side-effect-free") dies with it — true `?:` evaluates the first operand once.

## Row 3 (extension, separate commit ae99b872): bswap

The same table also said `__builtin_bswap16/32/64` are "builtins not provided
by the compiler" — false since #680 (`30f12ece`). Per the @master comment's
standard (a false why in this table misleads the next porter identically),
corrected in this pass, as its own commit so it can be dropped if ruled out
of scope. Full retirement to upstream text is impossible, measured: upstream
guards a statement-expression `__builtin_bswap16` fallback behind
`#if __GNUC__ < 4 || …`, and this compiler predefines **no `__GNUC__`** — an
undefined identifier is 0 in `#if`, so the guard *fires* (probe: `guard=1`)
and the fallback body cannot parse. The patch shrinks from ~20 lines of
static inlines to deleting that 3-line fallback; BE16/BE32/BE64 call sites
now hit the real single-eval, const-folding intrinsics
(probe: `3412 78563412 8877665544332211`).

## Gotcha worth keeping

A probe of upstream-ish shapes is not a probe of upstream: the first rtc
probe used named members and folded, and only the real `GB_SECTION` expansion
exposed the anonymous-member gap. When measuring "does X compile now",
compile the *actual* vendored expansion, not a hand-simplified twin.
