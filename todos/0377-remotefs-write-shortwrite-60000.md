# 0377 — Brokered write() short-writes at 60,000 B — the exact mirror of the 0140 read bug, still open on the write side

- **Status**: open
- **Difficulty**: medium
- **Design**: `logs/2026-07-28/review-libc-env-divergence.md` on
  `origin/review-libc-divergence` @ `ecfc0f40` — row **D4**, finding **F3**.
- **Provenance**: the libc env-divergence deep dive (Fable), 2026-07-28.

## Why this one is worth its own ticket

⭐ **The estate has already paid for this exact bug once, on the read side.**
`0140` — the mGBA derail — was a kernel **short-read**: an unlooped ROM read
silently returned fewer bytes than asked. The fix went in on the read path.
**The write path was never given the same treatment.**

So today: any unlooped `write()` larger than **60,000 B** works under Env N
(Node passthrough) and Env B (in-process), and **silently truncates in-OS**
(brokered). Same shape, same silence, same class of program affected — and the
divergence means it is invisible to every test that does not run brokered.

🔴 **A bug whose twin has already cost the estate a derail is not a "minor
divergence."** The reason it looks minor is that the read half was fixed, which
is precisely why nobody is looking at the write half.

## The two honest options (the review named both; pick one, do not blend)

1. **Loop-fill regular-file writes in `RemoteFS.write`** — symmetry with the
   read fix. Almost certainly the right answer, since it restores the invariant
   callers already assume.
2. **Document the short-write as the contract** — and then **prove the stdio
   layer loops**, everywhere it matters. If you take this path, the proof is the
   deliverable, not the documentation.

## Acceptance

- Test-first: a red test writing >60,000 B through the brokered path and
  checking the returned count and the resulting file bytes.
- Whichever option is chosen, the test goes green **and** the same case is
  exercised in all three environments so the divergence cannot silently return.
- ⭐ A **regression guard tying this to `0140`**: the two are one class, and the
  next person should not have to rediscover that.
- `blockfs` + `kernel` green with NUMBERS.
- `todos/LIABILITIES.md` is machine-checked by the `todos` suite — re-anchor or
  retire any anchored line this change rewrites, in the same commit.
