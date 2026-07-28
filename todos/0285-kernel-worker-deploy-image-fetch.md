# 0285 — kernel-worker deploy image fetch: cover the manifest.image branch, make the failure LOUD, retire the zombie bake fallback

- **Status**: open
- **Design**: this file. Source: unfunded-liability sweep 2026-07-27 (its
  highest-blast-radius finding), merged with the long-standing "boot-robustness /
  zombie bake fallback" item that had ridden coordinator notes without ever being filed.
- **Ruling absorbed (triage decider D4, 2026-07-28; master cont-125 annotated)**: an archived
  thread claimed two boot-resilience items were **unfiled**. That premise is **stale** — both
  are already here (the fixed-name fallback is Plan bullet 2 verbatim; the loud-fail
  bake-fallback kill is the title, Plan bullet 1, and Acceptance criterion 3), and both are
  anchored in the liability register as **L01/L02 pointing at 0285**. 🔴 **File nothing new for
  them.** Only two framing nuances were genuinely missing, and they are folded into the Plan
  below: the **HTTP status** in the loud log, and the fixed-name rung's real purpose (closing
  the **deploy-propagation window**, prior art `done/0141`).

## Goal

Close the one branch on the production boot path that no test takes and whose failure is
swallowed.

`os/kernel-worker.js:438-443`:

```js
// manifest.image (todos/0249): a DEPLOY may publish the blob under a
// content-hashed name (os-system.<sha>.img, immutable cache headers)
// and names it here via its transformed image.json. The repo manifest
// carries no `image` field, so every dev/test path (serve.js overlay
// swaps, boot.js, the fixtures) keeps fetching the fixed name.
var r = await fetch(manifest.image || 'os-system.img');
…
} catch (e) { /* no prebaked blob served — fall through to the bake */ }
```

Two defects in the same few lines:

1. **The `manifest.image` branch is taken by no dev/test path.** `grep -rn "manifest\.image"`
   over `os/ tools/ tests/ serve.js` returns exactly that one line; no test builds a manifest
   carrying `image`. This is the **first fetch on the production boot path**, and it is the one
   branch nothing exercises.
2. **The failure is silent.** A 404 or a wrong hash lands in an **empty catch** and falls
   through to `bakeSystemImage` — an in-worker compile of the whole system. On a static deploy
   that is far slower at best and fails at worst, and the user-visible symptom is a mysteriously
   slow or failed boot with **no diagnostic naming the real cause**.

The comment above is *accurate*, which is precisely why nobody looked again: it reads as known
and handled. #58 / `todos/0249` covers **producing** the hashed name;
`tests/serve/test_image_determinism.js` covers the **precondition** (two bakes byte-identical).
Nothing covers **consuming** it.

## Plan

- **Make the catch loud.** Emit a `boot-log` line naming the failed URL, **the HTTP status**,
  and the reason before any fallback. A silent fallback on the production boot path's first
  fetch is the "quiet symptom" anti-pattern `CLAUDE.md`'s test-sync discipline section forbids.
  ⭐ The status is the half that makes the log *actionable*: a 404 (not yet propagated) and a
  200-with-wrong-hash (stale edge) are different failures with different responses, and a URL
  alone cannot tell them apart.
- **Retire the zombie fallback.** On a `manifest.image` miss, fetch the fixed name
  `os-system.img`; if that is also absent, fail loudly rather than falling through to an
  in-worker bake that can never be the right answer on a static deploy. Keep the bake path only
  where it is genuinely reachable (dev), and say so in the code.
  ⭐ **Why the fixed-name rung is not merely "one more try before failing":** it is what closes
  the **deploy-propagation window**. During propagation an edge can still be serving the
  previous hashed name; falling back to the fixed name lets the boot reach a *correct* image
  rather than a *baked* one, and the existing version gate is what keeps that from silently
  booting something stale. Nearest prior art: `done/0141`. Scope the rung as a propagation
  bridge, not as a politeness step before the hard fail.
- **Cover the branch:** a test that boots with a manifest carrying `image`, plus a test
  asserting the failure path *logs* and does not silently bake.

## Sequencing

**Gate this honestly only after `0287`.** `0287`'s boot-race legs (`os-boots.mjs:115`,
`os-vt.mjs:38`) are vacuous whenever "ready" wins the race, so a green boot suite today is not
yet evidence that a boot change is safe. Fixing those legs first is what makes this item's gate
mean anything. Advisory ordering (soft), not a hard block.

## Acceptance

- A test drives the `manifest.image` branch (manifest carrying `image`) and passes.
- A fetch failure on that branch produces a `boot-log` line naming the failed URL — **asserted
  by a test**, not merely observed by hand.
- No code path silently falls from a failed deploy-image fetch into an in-worker full bake.
- Planner-selected suites green (`node tests/run.js --diff`), reported with NUMBERS beside each.
