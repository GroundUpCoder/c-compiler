# 24h architectural review — images 177→182 (ab94f903..db4bbc43, 63 main-line commits)

Read-only review of the last ~24h of work as a cohesive whole. All claims
verified against trees/diffs at head `db4bbc43` in a throwaway worktree, not
against commit messages or ticket text. Spot-check depth: 0356, 0354/0349/0363,
0328, 0340/af2059d2, 0348, 0341, 0353/0358/205f9c25, 0333/0339.

## 1. The cohesive picture

The window has one product spine — CPython 3.13.5 lands as a real gucman
package (`0340`, image 181) with the `cmdalt` dispatcher (`0338`, image 179)
making `python` a switchable verb — and that spine is exactly what stress-tested
the estate's verification substrate hard enough to expose it lying in half a
dozen places: a bake-freshness closure that missed `sources` (`0354`), a deploy
stamp that said `-dirty` falsely (`0348`), a change-count that measured the
build directory (`0349`), an id allocator scoped to one branch (`0358`), 35
tickets whose Status line nothing checked (`0353`), and a run record that
couldn't tell a half run from a full one (`0339`). Roughly half the 63 commits
are the substrate being caught and converted from hand-maintained assertion to
machine-checked record, and the response pattern is consistent: fix + red
control where possible, and where not, the residual enrolled as a live ticket +
register entry in the same commit (`0360`/L47, `0362`/L50, `0363`/L51). Core
runtime churn is small and deliberate for a 928k-line window (compiler.js +244
lines, host.js +22, kernel.js +16; the bulk is the vendored CPython tree), and
the two rebake-forcing codegen fixes (`0328`, `0356`) are both real bugs fixed
at (mostly) the right level of generality with measured blast radius. Net: the
codebase is **healthier** at 182 than at 177 — with one new P0-class compiler
finding this review surfaced (§3, 0356's false "already correct" claim) and one
recurring doc-drift instance at head (§4).

## 2. The pattern verdict: real, and it has one root cause

Not pareidolia. Every instance in the "substrate was lying" cluster is the same
defect: **a derived record asserted as fact, with no mechanism forcing it to be
re-derived from its primary source.**

| derived record | primary source | drift found |
|---|---|---|
| `newestBakeInput` closure (deps-only) | the files the build actually reads | 0354 |
| comguc `-dirty` stamp via `.gitignore` | actual tree cleanliness | 0348 (symlinks) |
| overlay "5 of 10 changed" | actual libc delta | 0349 (embedded abs path) |
| next ticket/liability id | the id space across ALL refs | 0358 (0354 + L44 each issued twice) |
| ticket `Status:` line | the file's directory (done/ vs open) | 0353 (35 drifted) |
| suite `summary.json` | the scope the run actually had | 0339 (half run read as full) |
| RULES rationale "every wasm binary" | the suite list the rule actually gates | 0362 (open P0) |
| CLAUDE.md "Image version is **v179**" | `os/image.json` `version` | live at head (§4) |

The 24h's answer was to install checkers, and — important nuance from the
205f9c25 incident — **detection is now systemic, but prevention is still
invocation-dependent.** The all-refs allocator (`todos/idspace.js`, reads trees
not diffs, ~0.45s over every ref) merged at 08:13:32; at 08:13:43, eleven
seconds later, the 0356 lane consumed `0360`/`L47` a second time — not because
the allocator failed, but because the lane's ids were hand-carried from a
pre-allocator kickoff and it never ran `next-id` (its manual survey also
silently read nothing: the unquoted `$ref:todos/...` tripped zsh's `:t`
modifier — recorded in 205f9c25's own message). The collision was self-caught
and renumbered pre-merge in 4 minutes, which is the system working; but the
lesson is that a checker a lane must *choose* to run does not stop the class —
only a checker on the choke point (commit/merge/check) does. `queue.js check`
catching a landed duplicate, the pre-commit hook, and the 0341 tree guard sit
on choke points; `next-id` does not.

The structural change that stops the class (rather than instance-fixing it):
**no hand-maintained mirror of machine-derivable state.** Either the record is
generated from the primary source at check time, or it carries a same-commit
checker that fails loud on divergence — the liability-register enrolment rule,
generalized from gap comments to every derived record. §5 applies this to the
biggest remaining offender.

## 3. Did the fixes hold their own standard?

Mostly yes — and where they didn't, the failure is a *claim*, not code.

- **0328 (`0fd2fe7f`) — exemplary.** Red control committed (the new
  `tests/ast/test_inline_hint_propagation.js` fails 11× on the pre-fix
  compiler); blast radius **measured, not asserted** (21/22 vendor projects
  byte-identical; only netsurf moves, +9402 B / +0.18%; SameBoy checksum
  interlock re-verified); the `isInline`-vs-`inlineHint` field split is
  reasoned against C11 6.7.4p7 with both directions pinned. This is the
  standard, held.
- **0354 (`30c08852`) — standard met, asymmetry honestly enrolled.**
  `projectExternalDirs` (os/os-common.js:1415-1435) genuinely follows
  `sources`/`includes`/`srcRoots`/`-I` at directory granularity (rationale in
  the code: file granularity leaves the false green "one header away");
  `tests/host/test_bakeinput_sources.js` is a real dual-leg red control
  (recorded 5/7 red on pre-fix, 7/7 green at head, includes a negative control
  and an independent re-derivation sharing no code with os-common). The mkpkg
  twin `newestPkgInput` got the same fix but **no test** — enrolled correctly:
  ticket 0363 + register L51 + in-code `UNTESTED:` anchor
  (tools/mkpkg.js:238-242), all in one commit (`b9642c70`). Shipping a fix
  while properly enrolling its own verification gap is the system as designed.
- **0356 (`970aedf1`) — the fix is right; a claim around it is false, and
  that's this review's biggest finding.** The `promoteExprType` change
  (compiler.js:4978-5004: `bw > 32` keeps the declared type; signedness from
  `!uq.isUnsigned()` instead of an identity list that omitted `long long`)
  matches C11 6.3.1.1p2 and was independently verified clang-identical for
  binary ops, comparisons, switch, and ternary; the conformance test
  (`tests/unit/conformance/parse_bitfield_wide_promote/`) encodes the property
  (not the MicroPython proxy) and its red-on-parent was independently
  reproduced — every expected line wrong on `970aedf1^`. **But the commit
  message and dev log (`logs/2026-07-28/0356-bitfield-wide-promote.md`) claim
  "Unary, ternary and vararg operands were already correct" — and for unary
  that is false.** `buildUnary` computes result types from the *unpromoted*
  declared type (compiler.js:5399), so for `struct { unsigned u20:20; }`,
  clang promotes to `int` and prints `-t.u20 < 0` → 1, `(unsigned long
  long)~t.u20` → `fffffffffff00000`; head prints 0 and `fff00000`. That is a
  standard-C miscompile (width ≤ 32, no extension involved), pre-existing (the
  parent gives the same wrong answers — 0356 regressed nothing), **unfunded**
  (no ticket, no register entry), and now papered over by a written
  "known-and-handled" claim — the exact hazard `todos/LIABILITIES.md` names as
  worse than a false gap comment, in its inverted form. P0 by the repo's own
  policy. Nomination #1.
- **af2059d2 — the proxy→property re-encode is strictly stronger.** The
  original 0340 leg asserted `grep -c python == 0` ("no python name") — a
  proxy, true on 0340's pre-0338 base, false by design on the merged tree. The
  re-encoded leg (tests/kernel/test_python_clang_e2e.js:246-253) pins four
  facts: no implementation, **exactly one** python verb (so a missing
  dispatcher now also fails — the old form would have passed), exit 127, and
  stderr naming `gucman install python-clang`. Caught by the master's gate on
  the merged tree; neither lane could have seen it. This is the merge
  discipline earning its cost.
- **0340's `__readdir` EOF-errno P0 — correct, guard slightly fragile.** The
  brokered path was un-wrapped so EOF returns -1 with errno untouched
  (host.js:4252-4281); the standalone path was already right — the classic
  "two implementations of one contract, one wrong" (see nomination #2). There
  IS a dedicated C probe asserting `errno_at_eof == 0`
  (test_python_clang_e2e.js:176-199, :270-271) — but the libc contract's only
  guard rides one large e2e file; filter that file out and the guard goes with
  it.
- **0348 — the positive control doesn't travel.** The fix is one character
  (`.gitignore:6`, `node_modules/` → `node_modules`); the ticket's acceptance
  required and got a real positive control (touch a tracked file → build must
  report DIRTY, "proved at cont-111") — but it was one-shot manual against the
  external embedder's build, and nothing durable in this repo would catch a
  future false-dirty. Defensible (the probe lives in the other repo; scope was
  deliberately one line), but it's the letter of "every noise-fix owes a
  positive control" without the durable form.
- **0341 tree guard — solid.** `tests/lib/tree-guard.js` guards 8 JS entry
  points (each inner runner self-guards, which matters because tests/run.js
  spawns children with `cwd: ROOT`, erasing the evidence); exit 4 deliberately
  distinct from the heavy lock's 3; the guard's own failure path is tested
  (tests/host/test_tree_guard.js, 151 lines, both `.git` shapes). Bypasses
  (tools/, os/boot.js, tests/run.py, direct test-file invocation, the
  loud-not-silent env hatch) are documented in-source and funded (L45 /
  todos/0357).
- **Test-first letter bent twice.** 0354 and 0356 both land test+fix in one
  commit with the red run asserted in the message rather than committed
  failing first. For 0356 the red was independently re-verified, so the
  substance held; the letter of "add the failing test, commit it, then fix"
  did not. Worth restating to lanes, not worth more than that.
- **Measurement culture is self-correcting:** `9bf8ff93` goes back into an
  already-merged measurement log to flag two of its own claims as retired
  (double-counted sameboy; superseded interpretation) — top-of-file and
  inline. That's the standard applied retroactively to evidence, which is
  rarer and more valuable than applying it to code.

## 4. Cross-cutting inconsistencies at head

1. **CLAUDE.md:966 says "Image version is **v179**"; os/image.json:2 says
   `182`.** Three bumps (180/181/182) landed without touching the doc's
   claim — and the line's history is the pattern in miniature: it sat at
   "v140" from image 140 through 178 (~39 bumps stale), was refreshed to v179
   by `c1d16320`, and drifted again within hours. This is exactly the class
   ticket 0359 files (CLAUDE.md's win32 seed claim vs image.json) but is NOT
   covered by 0359's text. The line is a hand-maintained mirror of
   machine-readable state; it should be deleted (point at image.json) or
   checked (queue.js/liabilities-style) — not maintained by hope.
2. **0356's written record vs shipped behavior** — the false "unary already
   correct" claim (§3). A doc line that reads as verification and isn't.
3. **The gate that green-lit 0356 could not see what 0356 fixed.** Open P0
   `0362` (queue rank 1, honestly filed by the 0356 lane itself with L50):
   tests/run.js's compiler.js rule gates `unit`/`kernel`/`blockfs`/`host` —
   no run.py category — while its rationale string claims "every wasm binary."
   So a diff-scoped gate on a compiler change reports a green that
   structurally excludes the interpreter corpora where 0356's three red tests
   lived. The rationale string is itself an unchecked derived record (§2's
   table, last row but one).
4. **Two codegen fixes, three bumps, no version skew.** The merge discipline
   ("the lane leaves image.json alone; master assigns the version at merge" —
   ab592575 vs dc96bbb9, 7a70ca4e, db4bbc43) worked across five concurrent
   lanes; the only nit is db4bbc43's message slightly over-attributing the 182
   bump to 0354, which changes no baked bytes (0356 alone forces it).
5. **Minor, filed here for completeness:** the suite-runner carry logic
   filters carried results against `selectedSet` only, not the current file
   set (tests/lib/suite-runner.js:262-263), so a deleted/renamed file's stale
   record can still count toward `recorded` — `recorded == total` does not
   strictly guarantee "every current file has a record." Requires an
   offsetting rename against a stale summary; unlikely, but the invariant as
   documented is not the invariant as coded. Also, `queue.js check`'s Status
   validation pins the two observed drift classes only (done/-says-open;
   open-says-done-round) — done/-says-"in progress" and open-says-"done" both
   still pass.

## 5. The ONE architectural recommendation

**Make bake/package freshness a recorded fact of the build, not a parallel
reconstruction of it: have `buildProject` record its actual read-set
(content-hashed) into a manifest next to each artifact, and define "fresh" as
"recorded read-set hashes unchanged."**

Why this one: `newestBakeInput`/`newestPkgInput` are the largest remaining
hand-maintained mirror in the estate, and this window alone spent four tickets
on that one subsystem being wrong or unverifiable (0354's deps-only closure,
0363's untested twin, 0349's false attribution, plus 0318's earlier
newestBakeInput-misses-sources finding). The current design is structurally a
§2 violation: a scanner that must re-enumerate, by hand-written rule, the input
set the build already knows exactly — every new manifest key (`srcRoots`,
`-I`, the clang overlay tier, the next one) is a future 0354. The build's cc
driver and seedEntries already funnel every read through fsMod — the 0354 test's
Leg B *already spies on fsMod* to re-derive the closure independently
(tests/host/test_bakeinput_sources.js:111-203), which is this recommendation
running in test-harness form. Move it into the bake: record `{path,
sha256}` per read at bake time, publish the manifest atomically with the
artifact (mkimage's rename), and freshness becomes a content comparison with
**no closure rules to maintain and no red control to owe** — a regression is
impossible rather than untested. It also subsumes 0349 (input-content identity
ignores the embedded build path instead of being confused by it) and is the
prerequisite half of open 0121 (reproducible bakes): same recorded inputs ⇒
expect same blob, which turns the sealed-image hash into a real determinism
check.

Cost, honestly: a read-set recorder threaded through `buildProject`/mkimage/
mkpkg (medium — the fsMod seam exists); a manifest format + atomic publish;
mtime-freshness kept as a cheap fast path or dropped (hashing the ~2k-file
closure is tens of ms with caching, but it's real new work per staleness
probe); the known nondeterminism (`__TIME__` in quake makes fat bakes
nondeterministic) must be either fixed or explicitly excluded from the
determinism claim (it does not affect the freshness claim); and the in-browser
bake path can't stat/hash the repo, so the browser keeps its version-only gate
unchanged — this changes nothing for OPFS clients. Rough size: one medium
ticket, and it retires 0363 and most of 0349 instead of testing them.

## 6. Ranked deep-dive nominations

Three. The rest of the window survived spot-checking well enough that
nominating more would be padding.

1. **Bit-field promotion outside `promoteExprType` — the 0356 residual**
   (`970aedf1`, compiler.js:5399). Why: a verified standard-C miscompile in
   the shipped compiler (`-t.u20 < 0` → 0, should be 1; `~t.u20` stays
   unsigned; clang-diffed at head AND parent), currently unfunded and masked
   by a false "already correct" claim in the commit message and dev log —
   worst-of-both per the register's own doctrine. Blast radius: every vendor
   corpus; unary-on-bitfield is common C. The question for the thread:
   **enumerate every type-computation site that consumes a bit-field's
   declared type without integer promotion (unary minus/not/complement, casts,
   `sizeof` intermediates, va_arg, compound assignment's implicit RMW) and pin
   each against clang, test-first; file the P0 and correct the 0356 dev log in
   the same commit.**
2. **The dual-implementation libc: standalone vs brokered env divergence**
   (`ab592575`, host.js:528 vs host.js:4252-4281). Why: the `__readdir`
   EOF-errno P0 was found *by luck* (CPython happens to check errno after
   readdir); the standalone twin was already correct, meaning the two envs
   implement one libc contract independently and can diverge silently — and
   the only regression guard for this instance rides a single filterable e2e.
   The question: **systematically diff the standalone and brokered env
   surfaces (every import implemented in both paths) for contract divergence —
   errno discipline, short-read/EOF conventions, flag handling — and decide
   whether libc contracts deserve their own conformance seats instead of
   riding app e2es.**
3. **The suite-runner's merged-record invariant** (`c97a81d7`,
   tests/lib/suite-runner.js:262-263, :329). Why: `recorded == total` is now
   the estate's definition of "the whole suite ran" — load-bearing for every
   gate — and the carry path can count a ghost record for a
   deleted/renamed file, so the coded invariant is weaker than the documented
   one; carried FAILs also don't fail the current exit by design, which is
   defensible but deserves an explicit written contract. Small, but it guards
   everything else. The question: **state the exact invariant `recorded ==
   total` is meant to certify, make the carry filter intersect the CURRENT
   file set, and add the red control for the ghost-file case.**

Not nominated, with reasons: `0338`/cmdalt survived its first contract stress
(af2059d2) with the strictly-stronger re-encode and has dedicated e2e legs;
`0358`'s incident was reconstructed here in full and its residuals are already
funded (0360/L47) with a follow-up branch in flight; `0362` is already open at
queue rank 1 — a review thread would duplicate scheduled work (the design-level
half, checking rationale strings against the mapping, folds into §5's
principle); `0328` is the standard held and needs nothing.
