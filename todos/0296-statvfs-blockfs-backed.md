# 0296 — BlockFS-backed statvfs (real free/used blocks) so df stops reporting fiction

- **Status**: open
- **Design**: this file. Source: unfunded-liability sweep 2026-07-27 (finding #9).

## Goal

Make `statvfs` report real filesystem geometry instead of a fixed nominal volume.

`compiler.js:23093-23095`:

```c
/* Nominal values only — this runtime exposes no real filesystem geometry to C
   (callers like df() see a fixed 4 GiB volume). A BlockFS-backed statvfs that
   reports real free/used blocks is a TODO (needs a host import). */
```

**Verified in place.** `grep -i statvfs` over all ticket bodies → **0**.

## Why it matters more than "cosmetic"

`df` in the shipped OS reports a **fixed 4 GiB with fabricated free space**. BlockFS **is**
ENOSPC-capable — and this estate has a history of ENOSPC surfacing as *phantom product
failures*. So the OS can genuinely fill up while `df` cheerfully reports room. The tool a user
(or a debugging agent) reaches for to diagnose a full disk is the one tool guaranteed to lie
about it.

## Plan

- Add the host import the comment names, exposing BlockFS's real block counts.
- Back `statvfs` with it: real `f_blocks` / `f_bfree` / `f_bavail` / `f_bsize`, and real inode
  fields if BlockFS can answer them (say so explicitly if it cannot, rather than leaving
  nominal values that read as real).
- Anything still nominal after this must be **commented as nominal and cited against a ticket**
  (`0286`'s register rule) — do not leave a partially-real `statvfs` that looks fully real.

## Acceptance

- `df` in the booted OS reports the actual volume size and actual free space.
- A test fills the volume and asserts free space **decreases** — the assertion today's
  implementation cannot pass.
- ENOSPC and `df`'s reported free space agree at the boundary.
- Planner-selected suites green (`node tests/run.js --diff`), reported with NUMBERS.
