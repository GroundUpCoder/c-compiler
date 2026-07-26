# 0293 — Headless single-instance guard for boot.js (the 0045 noted-only follow-up)

- **Status**: open
- **Design**: this file. Source: unfunded-liability sweep 2026-07-27 (finding #6) —
  described by the sweep as *"the purest form of the pattern"* it exists to find.

## Goal

Give `os/boot.js` the single-instance guard the browser side already has.

`CLAUDE.md:365-366`:

```
`boot.js` is the headless twin … deliberately unguarded (a
flock-style guard is a noted-only follow-up in the 0045 item).
```

`todos/done/0045:7-8`: *"Headless flock-guard stays a noted-only follow-up; the 'seats v2'
sketch below stands unscheduled."*

**Verified at `847dc057`:** `os/boot.js` takes **no lock**. The browser side is fully guarded
(Web Lock → `boot-locked` guard screen). The **test estate is safe by isolation, not by design**:
`tests/kernel/lib/drive.js:51` mints a fresh `mkdtemp` image per boot, so concurrent kernel e2es
never share a store — which is exactly why no test can ever catch this.

**Real exposure:** a human running two `node os/boot.js` against the default
`os-system.img` / `os-root.img` pair — e.g. a manual boot while a lane runs. By BlockFS's own
multi-instance-coherence rules the failure mode is **silent cross-file corruption**.

## Why nothing scheduled it

The phrase **"noted-only follow-up" inside a CLOSED item** is the whole pattern in one line: it
reads as a decision that was made and recorded, so nobody re-reads it. `grep -i flock` over all
91 ticket bodies → **0 hits**.

## Plan

- A flock-style guard in `os/boot.js` on the image pair (the browser's Web Lock behaviour is the
  reference for semantics: refuse and say so clearly, don't silently proceed).
- Fail with a message naming the held path and the holding PID if determinable — a guard whose
  refusal is cryptic just relocates the confusion.
- Update `CLAUDE.md:365-366` so it no longer describes the guard as an open follow-up.

## Acceptance

- A second `node os/boot.js` against the same image pair is **refused**, with a clear message.
- A test covers the refusal. Note it must **not** rely on `drive.js`'s per-boot `mkdtemp`
  isolation, since that isolation is precisely what hides the bug — the test has to point two
  boots at one store deliberately.
- `CLAUDE.md` no longer calls this an unscheduled follow-up.
- Planner-selected suites green (`node tests/run.js --diff`), reported with NUMBERS.
