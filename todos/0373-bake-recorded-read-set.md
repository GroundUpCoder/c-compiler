# 0373 — Freshness by RECORDED read-set: buildProject records {path,sha256} per read; 'fresh' = recorded hashes unchanged (retires the hand-maintained closure)

- **Status**: open
- **Priority**: P2
- **Difficulty**: heavy
- **Design**: this file + §5 of `logs/2026-07-28/review-24h-overview.md` on
  `origin/review-24h-overview` @ `93bf47b0` — **the review's ONE architectural
  recommendation.** Read §5 in full before scoping.
- **Provenance**: the 24 h architectural review (Fable), 2026-07-28. Filed by
  master cont-122; the review had named it but nobody had queued it, and an
  architectural finding that never enters `todos/` does not exist.

## Goal

> **Make bake/package freshness a recorded fact of the build, not a parallel
> reconstruction of it: have `buildProject` record its actual read-set
> (content-hashed) into a manifest next to each artifact, and define "fresh" as
> "recorded read-set hashes unchanged."**

## Why this one, and not the next scanner fix

`newestBakeInput` / `newestPkgInput` are the **largest remaining
hand-maintained mirror in the estate**, and a single 24-hour window spent
**four tickets** on that one subsystem being wrong or unverifiable:

- `0318` — `newestBakeInput` misses `sources`
- `0354` — the `deps`-only closure hole (fixed in **both** functions)
- `0363` — the twin `newestPkgInput` is **untested**, no red control
- `0349` — false attribution caused by embedded absolute build paths

The current design is structurally a §2 violation: **a scanner that must
re-enumerate, by hand-written rule, the input set the build already knows
exactly.** Every new manifest key (`srcRoots`, `-I`, the clang overlay tier,
the next one) is a future `0354`. Fixing the scanner again buys one ticket;
recording the read-set retires the class.

⭐ **The mechanism already exists in test-harness form.** The build's cc driver
and `seedEntries` funnel every read through `fsMod`, and `0354`'s test **already
spies on `fsMod` to re-derive the closure independently** —
`tests/host/test_bakeinput_sources.js:111-203`. This ticket moves that spy into
the bake itself.

## What it subsumes (do NOT close these blind — see below)

- **`0363`** — with a recorded read-set there is **no closure rule to test**,
  so `0363`'s red control is retired rather than owed.
- **most of `0349`** — input-content identity ignores an embedded build path
  instead of being confused by it.
- **prerequisite half of `0121`** (reproducible bakes): same recorded inputs ⇒
  expect the same blob, which turns the sealed-image hash into a real
  determinism check.

🔴 **`0363` and `0349` stay OPEN until this lands and is proven.** Close them
with `node todos/queue.js done <id>` only from evidence in this ticket's own
gate — not on the strength of this paragraph. ⚠️
`~/worktree/clang-simplified/0330-libc-revendor` holds the ONLY copy of the
mis-measured overlay, which is `0349`'s evidence: **do not delete that worktree
until `0349` lands.**

## Plan

1. Thread a read-set recorder through `buildProject` / `mkimage` / `mkpkg` at
   the existing `fsMod` seam: record `{path, sha256}` per read.
2. Define a manifest format; **publish it atomically with the artifact**
   (`mkimage`'s rename).
3. Freshness = content comparison against the recorded manifest.
4. Decide explicitly: keep mtime freshness as a cheap fast path, or drop it.
   Hashing the ~2k-file closure is tens of ms with caching, but it is real new
   work per staleness probe — **measure, don't assume.**
5. The known nondeterminism (`__TIME__` in quake makes fat bakes
   nondeterministic) must be **either fixed or explicitly excluded from the
   determinism claim**. It does not affect the *freshness* claim — keep the two
   claims separate in writing. (`__TIME__`/`__DATE__` in Quake is PARKED as its
   own item; excluding it here is legitimate, silently conflating it is not.)
6. ⚠️ **The in-browser bake path cannot stat/hash the repo.** The browser keeps
   its version-only gate unchanged — this changes nothing for OPFS clients.
   State that boundary in the code, not just here.

## Acceptance

- Every artifact carries a recorded, content-hashed read-set manifest,
  published atomically with the artifact.
- Freshness is computed from that manifest; **no hand-written closure rules
  remain** in `newestBakeInput` / `newestPkgInput` (or they are deleted).
- A **positive control**: plant an edit in a file that the *old* closure rules
  would have missed (the `0318` / `0354` shapes) and show the new gate goes
  red — *a scan whose "nothing found" is meaningful must carry a positive
  control.*
- Measured cost of the freshness probe before/after, with the fast-path
  decision justified by that number.
- The determinism claim and the freshness claim are stated separately, with
  `__TIME__` explicitly scoped out of the former.
- Gate: `host` + `todos` + `unit`, and — because this touches the bake —
  `kernel` + `sweep` with real NUMBERS. ⭐ A `compiler.js` edit selects no
  `run.py` category but `unit` (`0362`/`L50`), so if this touches
  `compiler.js`, run `micropython` / `micropython-upstream` by hand too.
- `todos/LIABILITIES.md` is machine-checked by the `todos` suite — re-anchor or
  retire any anchored line this change rewrites, in the same commit.
