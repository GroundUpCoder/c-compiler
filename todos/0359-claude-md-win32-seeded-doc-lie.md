# 0359 — CLAUDE.md says the win32 corpus is NOT seeded, but calc and notepad are (os/image.json)

- **Status**: open
- **Design**: —

## Goal

## Plan

## Acceptance

## The gap

`CLAUDE.md` states the win32 corpus is **NOT seeded** into the shipped image.
`os/image.json` seeds **`calc`** (`:229`) and **`notepad`** (`:235`).

Spotted by the `0318` lane while auditing vendor-dir gates; it was outside that
ticket's scope and was never filed, which is the exact failure mode
`todos/LIABILITIES.md` exists to prevent — a true-sounding doc line that nobody
re-checks.

## Why it matters more than a typo

This estate has been bitten twice by "what the docs say ships" diverging from
"what ships": the fat-fixture-vs-minimal-deploy split (tests used a 111 MB
all-packages fixture while prod shipped a 23 MB image, so "preinstalled" passed
every test and was absent from prod), and the seeded-vs-package confusion around
micropython. A doc that misstates the seed set feeds directly into that class of
error when someone scopes work off it.

## Done

- Reconcile the sentence with `os/image.json`. **Derive the seed list from the
  file, do not hand-edit a new claim** — the whole defect is a hand-written
  claim about a machine-readable fact.
- Check whether any other `CLAUDE.md` / `todos/WIN32.md` statement about what is
  seeded has the same drift; fix them in the same commit.
- Prefer a check that keeps them in sync over a corrected sentence, if one is
  cheap. A corrected sentence rots again on the next seed change; that is how
  this one got here.
