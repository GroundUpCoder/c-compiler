# 0291 — CD34 tail: fold wm.c load_entries onto listdir.h — its deferral milestone (0250/0259) is already closed

- **Status**: open
- **Design**: this file. Source: unfunded-liability sweep 2026-07-27 (finding #5) —
  **a deferral whose funding milestone has already shipped.**

## Goal

Fold the third drifted copy of the directory-listing walk onto the shared header, which is what
`os/listdir.h:1-5,37-39` says should happen once the menu redesign lands. It landed.

```c
/* listdir.h — the shared directory-listing walk (code-debt CD34) for
 * comdlg32.c's file dialog and fileman.c's pane. NOT (yet) all three
 * drifted copies: wm.c's load_entries is the tracked 3rd member,
 * deliberately deferred to the menu redesign (recipe in
 * todos/done/0250) — don't cite this header as covering it.
```

**Verified at `847dc057`:** `todos/done/0250` **and** `todos/done/0259` (the menucore reseat /
menu redesign, #64) are **both closed**. `os/wm.c:1462` still defines its own `load_entries()`,
used at `:1497`, `:1500` and `:2341` — the Start menu, the baked-menu union, and the Desktop
icon grid. The redesign this was deferred *to* came and went; the fold never happened.

## Why it stayed invisible

The deferral pointer is the **only** record, and it points at an item now in `todos/done/` — so
it reads as *"handled by 0250"* to anyone who does not check that `0250` is done. Nothing in the
ticket DB mentions `listdir`, CD34, or `load_entries`. This finding is one of the two that
motivated `0286` (a register whose entries must cite a **live** ticket).

## Plan

Either:

- **(a)** Fold `wm.c`'s `load_entries()` onto `listdir.h`, so all three call sites share one
  dotfile/symlink/cap policy — the actual intent; **or**
- **(b)** If the fold is genuinely not wanted, **edit the comment** to say the redesign passed
  without folding it, and why.

**(a) is preferred.** Either way the current state — a pointer to a *done* item — must not
survive this item, because that pointer is what made it invisible.

## Acceptance

- One directory-listing walk, or an explicit written decision not to unify with the reason.
- `os/listdir.h`'s comment no longer defers to a closed item.
- Start menu, baked-menu union, and Desktop icon grid behave identically to before (these are
  the two most-touched surfaces in the OS — dotfile/symlink/cap policy must not shift silently).
- Planner-selected suites green (`node tests/run.js --diff`), reported with NUMBERS.
