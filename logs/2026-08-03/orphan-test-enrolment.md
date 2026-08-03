# Tests that belong to no suite — #167 and #431, and the two nobody had filed

Tickets: **#167** (`test_punes_e2e.js` absent from the kernel registry) and
**#431** (`tests/browser/lib/test-harness.js` in no suite at all). #431's own
body calls itself *"the same class as #167"*, which is why they were worked as
one lane.

## The defect, stated once

A suite whose membership is a **list a human maintains** can hold a file that
is named, located and shaped exactly like a member and still execute nowhere.
Every counter agrees, because the list defines the denominator. `recorded ==
total` is computed with the same key it is meant to verify.

The second-order damage is worse than one skipped test. The diff planner maps
`^vendor/(jq|mgba|punes)/ → kernel`, so a punes change *selected* the kernel
suite, the kernel suite ran green, and the gate reported coverage it did not
have. A rule pointing at a suite that does not contain the test reads exactly
like a rule that does.

## What was actually wrong — four files, not two

The tickets named two. Censusing **every list-driven suite** rather than only
the two named directories found two more:

| file | suite that should own it | why nothing ran it |
|---|---|---|
| `tests/kernel/test_punes_e2e.js` | kernel | not a registry row; on the #314 allowlist since d8701a1e |
| `tests/browser/lib/test-harness.js` | browser sweep | lived outside the sweep's `os-*.mjs` discovery glob |
| `tests/host/test_console_capability.js` | host | host's list is hardcoded and had **no** `assertMemberRegistry` call |
| `tests/spawn/test_spawn_host.js` | host | in no list, and `tests/spawn/` had no RULES row → UNMAPPED |

The third is the one that matters most as evidence: `test_console_capability.js`
landed **red→green** at `e2579556` (0248/CD27) carrying its own RED control, and
then sat in no suite for weeks. The #314 guard exists precisely to catch that —
it was simply never wired into this suite, even though its own header says
"callers with hardcoded lists invoke this".

## The fixes, and why each took the shape it did

**Kernel — a registry row.** `test_punes_e2e.js` with `timeoutMs: 900000`. The
shape sibling is `test_mgba_e2e.js` (`IMG`, suite default 600 s), but punes
drives *three* boots whose own `driveBoot` deadlines already sum to 660 s, past
that default; 900 s matches `test_heavylock_e2e.js`'s four-boot row. The
`EXCLUDED` allowlist entry came out in the same commit — the guard fails on an
entry whose file has become a declared member, so an exclusion cannot outlive
its reason. `LIABILITIES` L68, which described this exact hole, went with it.

**Browser — rename into the glob, not a second list.** The sweep's list is
*discovered* (`os-*.mjs`), and its header says so deliberately: "no second list
to keep in sync". Adding an explicit extra-member array would have re-created
the very failure being fixed. So the file moved to
`tests/browser/os-harness-unit.mjs` and is discovered like every other member.
It is the one sweep member that launches no browser (~0.2 s).

**Host — enrol both, and wire up the guard.** Two rows plus the #314
`assertMemberRegistry` call the suite never had, one per directory the list
draws from (`tests/host`, `tests/serve`, `tests/spawn`), placed *before*
`ensurePrebakedImage()` on the tree-guard precedent: a launch we are about to
refuse must not first write a 111 MB blob into the tree.

## What the enrolment surfaced

**Nothing red.** All four files pass. That is worth stating plainly rather than
burying, because #167 predicted a red on punes and was right to: a test that
has not run since 2026-07-18 passing first try is a claim, not a relief. The
reason it survives is that the things it asserts (the built-in NROM ROM, the
512×480 geometry, the `.nes` association, the 0213 D-pad guard) are all
load-bearing for *other* seeded-app tests that did keep running, so the ground
under it never moved.

`test-harness.js` is the exception that proves the rule: it **had** gone red on
`main` — `osUrl` grew a `hostkeys=off` default and the expectation was never
updated — and the #97 lane fixed that expectation by hand as a courtesy. So the
red this enrolment would have caught was already spent. The enrolment gap was
untouched, and that gap is what #431 was actually about.

## The review caught the same bug inside the fix

The host guard shipped for about an hour with its guarded directories written
down beside the registry it guards — `['serve', 'spawn'].forEach(...)`. Codex
flagged it and it was right: `tests/` has 20+ sibling directories, so an
ordinary future row like `../unit/test_x.js` would have *run* while tests/unit
went unguarded, and the next `test_*.js` added beside it would have been
orphaned in silence. That is this ticket pair's own defect one level up — a
guard that only guards the directories somebody remembered to list.

The partitions are now DERIVED from the rows: each row is classified as
`test_x.js` or `../<dir>/test_x.js`, the distinct directories that appear
become the guarded set, and a row matching no partition refuses the run naming
it. Adding a row in a new directory either starts guarding that directory or
fails loudly; it cannot silently do neither. Control: a throwaway
`../blockfs/test_zz_sibling_control.js` row now makes the suite exit 2 naming
tests/blockfs's undeclared files — the hardcoded version would have run it and
said nothing.

The lesson worth keeping is not "hardcoding is bad" — it is that **a guard
whose scope is declared separately from the thing it guards will drift away
from it**, and drift in a guard is invisible by construction.

## Residual — deliberately reported, not acted on

- **The browser tier has no membership guard at all.** Discovery makes an
  orphaned *declared* member impossible, but a file that simply does not match
  `os-*.mjs` is invisible with *no* complaint: un-enrolling
  `os-harness-unit.mjs` (moving it back under `lib/`) drops the sweep from 50
  members to 49 and exits **0**. The kernel/host equivalent exits 2 naming the
  file. Closing this needs a rule for which of `tests/browser/`'s ~60
  non-`os-*` `.mjs` files are tests and which are the manual spikes and build
  scripts the README documents — a classification, i.e. a design call.
- **`tests/browser/test-blockfs.mjs`** is a real Playwright test (compile with
  `--block-fs`, load in Chromium, verify output) in no suite. Not enrolled here:
  it is not an OS acceptance file, so naming it `os-*.mjs` would misfile it in
  the sweep tier, and enrolling an unverified file into a multi-hour gate is a
  red waiting to happen. It wants its own decision.
