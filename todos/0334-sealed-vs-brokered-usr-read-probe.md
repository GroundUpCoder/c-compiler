# 0334 — sealed-vs-brokered `/usr`: an in-OS read probe that does not spawn per read

- **Status**: open — queued BEHIND `todos/0332`, must not preempt it
- **Context**: `logs/2026-07-27/bench2x2-python-profile.md` §5

## Goal

Answer whether reads from the sealed `/usr` differ measurably from brokered reads
(e.g. `/root`), using a probe that does **not** spawn a process per read.

## Why it is open rather than answered

The bench2x2 lane measured an in-OS `/usr`-vs-`/root` delta and then **retracted its own
figure, unprompted and correctly**: the harness ran `cat` once per iteration, so each
sample was dominated by ~44 ms of generic process-spawn overhead. The read itself is
**under 0.3%** of what was timed, and the observed delta was ~1.7σ — i.e. consistent
with noise. The retraction is sound; what it leaves behind is an **unanswered question**,
not a finding.

This ticket exists so that question is owned. Per the standing rule, a gap that does not
enter `todos/` does not exist — and this one had no owner.

## What a valid probe requires

- **No process spawn inside the measurement loop.** Open once, read many; or drive the
  reads from a single resident process and time in-guest.
- **A positive control.** Before believing "no difference", show the probe can detect a
  difference you have deliberately introduced. A null result from an instrument that
  could not have seen a signal is worth nothing — this workstream has already been
  burned by exactly that class.
- **Report as a distribution** (p50/p99/max), never a mean, matching the convention the
  bench2x2 harness already uses.

## Acceptance

- A probe committed under `tools/` that measures read cost with no per-read spawn.
- Its positive control demonstrated in the same log.
- A stated answer — including "no difference detectable at this resolution", which is a
  legitimate result provided the control passed.

## Priority rationale

P3. Nothing is blocked on it. It is filed to stop an explicitly-retracted measurement
from being silently re-inherited as either a finding or a closed question.
