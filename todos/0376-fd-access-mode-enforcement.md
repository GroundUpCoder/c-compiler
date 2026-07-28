# 0376 — gucOS fds ignore the access mode: write() on an O_RDONLY fd silently mutates the file (P0 or an explicit waive)

- **Status**: open
- **Priority**: **P0**, filed per the unqualified bug rule. ⚠️ The review
  itself framed this as *"file as P0 **or explicitly waive**"* — so a
  considered, written waive is an acceptable outcome here. **A silent demotion
  is not.**
- **Difficulty**: medium
- **Design**: `logs/2026-07-28/review-libc-env-divergence.md` — **NOW IN `main`**
  (merged by master cont-123 as `35d72150`; `ecfc0f40` verified an ancestor of
  main — the `origin/review-libc-divergence` pointer is **stale**, read the `main`
  copy, which is the one that absorbs later corrections) — row **D3**, finding **F2**.
- **Provenance**: the libc env-divergence deep dive (Fable), 2026-07-28, row
  confirmed by execution.

## ⚖️ RULING 2026-07-28 — **P0 STANDS. FIX IT. NO WAIVE.**

**Provenance: FABLE DECIDER call, relayed by master cont-123, annotated by master
cont-124.** ⚠️ **This is a decider ruling, NOT a jku ruling** — do not let it
launder into "jku decided" (`meta/notes/correction-decision-provenance-2026-07-27.md`).
Full reasoning: `meta/notes/decisions-cont123-fable.md` (meta main `f16db6d`).

The ticket's own "P0 **or an explicit waive**" fork is hereby **closed on the fix
side**, for two stated reasons:

1. **The only available waive argument is the forbidden "nothing hits it yet"
   class** — precisely the shortcut the estate's core principle rejects.
2. A *coherent* waive would have to also cover **D11**, and writing that waive
   **costs more than the sketched fix**. So the fix is both more correct **and**
   cheaper. There is no version of the waive that is the lazy option.

🔴 **D11 stays on `0378`.** Do **not** migrate it into this ticket.

⭐ **The `0375` collision is CONFIRMED with its mechanism, not assumed:** the fix
lands in the **same `FS_OPEN` case at `kernel.js:3188-3190`** that `0375` is
rewriting — **`_makeOfd` records no access mode at all.** **This ticket
SERIALIZES BEHIND `0375`.** Do not start it against a pre-`0375` baseline.


## The defect

**gucOS fds do not carry their access mode.** `write()` on an `O_RDONLY` fd
**silently mutates the file** — in **both** gucOS environments. Node
passthrough enforces correctly.

Two halves, and they are not equally bad:

- **`write()` on `O_RDONLY` — corruption-capable.** A program that opens
  read-only and writes by mistake corrupts data that the OS promised was safe.
  Worse, correct defensive code (open read-only *because* you must not write)
  is exactly the code this defeats.
- **`read()` on `O_WRONLY` — disclosure-only.** Real, lesser.

## The cheap fix shape (the review sketched it; it did not implement it — that
thread was read-only)

Store `flags & 3` on the fd entry at `open`, and check it in `read`/`write`.
Kernel OFDs likewise. That is the whole mechanism.

## If you waive instead

The waive must be **written, dated, and reasoned in the tree** — not a queue
demotion. State what a program can do as a result, and why that is acceptable
for this OS. ⚠️ Note the related row **D11**: `access(path, mode)` **ignores
mode entirely**, so `access("/usr/…", W_OK)` returns 0 on the sealed read-only
volume. A waive on D3 that leaves D11 lying to callers is not coherent — decide
them together. (D11 otherwise rides `0378`.)

## Acceptance

- Test-first: red tests for `write()` on `O_RDONLY` and `read()` on `O_WRONLY`,
  in **both** gucOS environments.
- Either the enforcement lands and those go green, **or** a dated written waive
  exists in the tree, coherent with D11, and this ticket records which.
- `blockfs` + `kernel` green with NUMBERS.
- `todos/LIABILITIES.md` is machine-checked by the `todos` suite — re-anchor or
  retire any anchored line this change rewrites, in the same commit.
