# 0409 — os-boots vi leg waits on a needle its own command echo satisfies

- **Status**: open
- **Design**: —

## Goal

`tests/browser/os-boots.mjs`, leg **"vi edits a file through xterm (todos/0011)"**, waits
for a needle that the terminal's own **echo** of the typed command already contains. The
wait therefore returns before the command runs, and the assertion samples the output
buffer too early.

`tests/browser/os-boots.mjs:93-101`:

    await type('cat /tmp/b.txt && echo VI-CAT-OK');
    await waitOut('VI-CAT-OK');          // <- the ECHOED command line contains this string
    const viSeg = await page.evaluate(...);          // samples window.__osOut
    check('vi edits a file through xterm (todos/0011)',
          viSeg.includes('browser vi works\n'), ...);

`waitOut('VI-CAT-OK')` is satisfied by the echo of the command the previous line just
typed, not by the command's output. Nothing then waits for `cat` to actually emit the
file. On a fast, quiet box `cat` wins anyway and the leg passes. On a loaded box it does
not, and the leg **fails**.

This is the `todos/0287` vacuous-leg family (`L03`/`L04`/`L05`), but the **inverse**
failure mode. Those legs pass vacuously. This one is a race that the intended outcome
usually wins, so it reads as an intermittent failure rather than a silent pass.

## Evidence

Observed first-hand during the `todos/0386` gate, 2026-07-29:

- Full browser sweep (41 files in parallel, loaded box): **FAIL**. Captured segment was
  `"\x1b[?1049l~ # cat /tmp/b.txt && echo VI-CAT-OK\n"` — the alt-screen exit, the shell
  prompt, and the echoed command, with **no `browser vi works`**. The other 13 legs in
  the file passed, including `L04`'s boot-race leg.
- Solo re-runs on a verified-quiet box: **4/4 PASS** (1 by the `0386` lane, 3 by the
  coordinator), 5.7 s each, `ok vi edits a file through xterm (todos/0011)`.
- Not caused by the `0386` diff: that diff's only runtime-affecting paths are
  `vendor/netsurf/` (the baked `/usr/bin/netsurf`) and `os/image.json`. This leg runs
  `vi` inside the gucOS xterm. NetSurf is not on its path at all.

## Fix

Wait on something the command **produces**, not on something the terminal **echoes**.
The general rule, which is the point of the ticket:

> A terminal e2e wait must key on a marker that only the command's execution can emit.
> A needle contained in the typed command line is satisfied by the echo and asserts
> nothing.

Apply it to this leg, and **audit the other `waitOut`/`type` pairs in
`tests/browser/` for the same shape** — the defect class is mechanical and greppable, so
a one-leg fix that leaves siblings unfixed is not the deliverable.

The usual remedy is a sentinel the echo cannot contain: split the marker so the typed
form and the emitted form differ (for example `echo VI-CAT''-OK`, which the shell emits
as `VI-CAT-OK` but which never appears contiguously in the echoed line), or wait on the
next shell prompt after the command rather than on the marker.

## Acceptance

- The leg passes under the **loaded** condition that reproduces the failure — the full
  41-file browser sweep — not only solo. State N and the conditions.
- A deliberately broken `vi` write (so `/tmp/b.txt` lacks the text) makes the leg
  **FAIL**. A wait that cannot fail is the bug being fixed; prove this one can.
- The `tests/browser/` audit is reported with its numbers: how many `waitOut` sites were
  checked, how many had the echo-matched shape, and what happened to each.
- `todos/LIABILITIES.md` re-anchored or extended in the same commit if any anchored line
  moves.

## Notes

No image bump is owed: `tests/` only, per the rule table in `todos/CLAUDE.md`.
