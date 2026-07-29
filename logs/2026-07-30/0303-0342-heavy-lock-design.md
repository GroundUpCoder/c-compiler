# 0303 + 0342 — heavy-lock coverage design pass

A design-only lane. The diff touches `todos/` and `logs/` and nothing else.
Deliverable: one `## Design` in each ticket, the L65 register entry, this log.

## Why a design pass

The two tickets agree on the disease and contradict each other on the cure.
0303 puts the lock in `os/boot.js` and prefers block-and-wait for a bare
boot. 0342 puts the lock in `tests/kernel/lib/drive.js` and demands exit 3
with the holder named. An implementation lane with one ticket would satisfy
one horn and silently contradict the other open P1. This pass resolves both
axes and records the ruling in both bodies.

## The seam — derived, not enumerated

The rule: the seam is where the boot process starts, because the boot
process spends the RAM. The survey method is a grep for call sites that put
`os/boot.js` into an argv. The method is in 0342 §Design so a reader can
re-derive it.

Result: eight entry paths reach a `node os/boot.js` boot. `drive.js` covers
one of them. Five kernel e2e files (`test_os_boot`, `test_os_apps_e2e`,
`test_vi_e2e`, `test_jobctl_tty_e2e`, `test_curl_e2e`) spawn the boot
themselves, `tools/bench2x2/inos-startup.js` spawns it, and the manual
shell invocation is the 0303 observation. So 0342's "choke point every
heavy test funnels through" does not exist, and its own escape clause
applies: the lock joins in `os/boot.js` startup.

The browser flavor has its own funnel: all 42 `os-*.mjs` files plus three
tools reach a Chromium boot through `tests/browser/lib/os-harness.mjs`.
The minimum seam set is therefore two. One path stays uncoverable — a
human browser tab against a dev `serve.js` — and is recorded as an
exclusion rather than silently dropped.

## The policy — one rule, because a split is not implementable

0303's block-and-wait split assumed the code can tell an interactive
reproduce from a runner. It cannot: agents and humans both pipe stdin.
So the design keeps one rule — fail fast, exit 3, name the holder — and
adds `--wait-lock[=SECS]` as the explicit opt-in wait. A default silent
wait would also violate the 0171 discipline: a stall inside a bounded tool
call is the quiet-symptom class the estate keeps paying for.

## Re-entrancy — verified marker, refusal-biased failure modes

`acquireHeavyLock` exports its pid to children via `CC_HEAVY_LOCK_PID`.
A join is re-entrant only when the marker pid is alive AND equals the lock
file's holder. Re-entrant joins take no ownership, so fan-out needs no
count and cannot deadlock. Every failure mode of the marker (severed env,
dead runner) falls through to a loud exit 3 — never to silent stacking.
The nested case is a test leg, not an assumption; the TMPDIR redirection
trick gives the control a private lock scope and a stand-in holder (the
test's own pid) with no second 4 GB boot.

## Rulings

- **Subsumption**: 0342 subsumes 0303 (precedent: 0373/0363). After the
  pass, 0303 holds no work 0342 does not do. Coordinator closes 0303 at
  the design merge; implementation lands under 0342 alone.
- **Light-suite line**: permission, not gap. No light suite spawns a
  multi-GB process tree; no RAM incident on record names one. The ruling
  cannot rot because the guard now follows the boot, not the suite list.
  No ticket filed; the "GAP, not permission" handoff prose dies.
- **0293 stays separate**: same insertion point in boot.js, but it is the
  per-image-pair coherence flock — a different lock for a different
  failure mode.

## Register

L65 anchors the runners-only coverage claim in `tests/lib/heavy-lock.js`
and cites 0342 (not 0303, which will close as subsumed — a `done/` cite
fails `liabilities.js check`). The landing commit retires or re-anchors it.
