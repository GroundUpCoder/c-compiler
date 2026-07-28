# 0378 — The libc env-divergence batch (D5–D22) + do libc contracts deserve their own conformance seats

- **Status**: open
- **Priority**: P2 (the batch); ⚠️ **the design question in §2 below is not P2 —
  it is the reason the batch exists.**
- **Difficulty**: heavy
- **Design**: `logs/2026-07-28/review-libc-env-divergence.md` — **NOW IN `main`**
  (merged by master cont-123 as `35d72150`; `ecfc0f40` verified an ancestor of
  main — the `origin/review-libc-divergence` pointer is **stale**, read the `main`
  copy, which is the one that absorbs later corrections) — the full 22-row table (§2),
  findings F4–F13 (§3), and **§4, the design question**. **Read §4 first.**
- **Provenance**: the libc env-divergence deep dive (Fable), 2026-07-28. The
  P0s from that review are filed separately as `0375`, `0376`, `0377` — **do
  not fold them back in here.**

## ⚖️ RULING 2026-07-28 — §4 ANSWERED: **YES, libc contracts get their own conformance seats**

**Provenance: FABLE DECIDER call, relayed by master cont-123, annotated by master
cont-124.** ⚠️ **Decider ruling, NOT jku's.** Full reasoning:
`meta/notes/decisions-cont123-fable.md` (meta main `f16db6d`).

- Build a **dedicated contract suite at `tests/contracts/`**, **first-class in
  the runner, the heavy lock, and the gate** — explicitly **NOT** an opt-in
  checker. (Lesson **(BZ)**: a checker you must CHOOSE to run does not close a
  class, and **the master is the likeliest bypass**.)
- **One contract file per libc behavior, executed in ALL THREE environments
  (N / B / R).** That is the structural fix for *"we test the env nothing ships
  on and ship the env nothing tests."*
- 🔴 **D15/D16-style exemptions are VISIBLE, ANNOTATED OBJECTS — never dropped
  rows.** An exemption that disappears is indistinguishable from a gap.
- **Stays ONE ticket, internally staged:** seat design → errno sweep
  (D5/D9/D10/D11/D13) → D6+D17 → D7+D12 → the rest.
- **SEQUENCE AFTER `0377`.**
- ✅ The `kernel.js:3416` false-comment claim was **independently verified real**.

🔴 **22 tests is the SYMPTOM; §4 is the ticket's real content.**


## 1. The batch

The estate has **three** filesystem environments, not two: **Env N** (Node
passthrough), **Env B** (in-process BlockFS), **Env R** (brokered/kernel). The
review diffed all three across 22 behaviours. After `0375`/`0376`/`0377` take
the corruption-class rows, these remain:

| row | divergence |
|---|---|
| **D5** | readdir error-vs-EOF conflation, **inverted** — `0340` made EOF clean by making *every* null clean, so the real-failure branch is **dead code** (`host.js:4266–4269` tests for a negative number no fs method ever returns). Low urgency, but **the dead branch documents an intention the code does not implement.** |
| **D6** | `d_type` never reports `DT_LNK`/`DT_CHR`/`DT_UNKNOWN` in gucOS (`host.js:3558`, ~one line). Mis-answers CPython's `os.scandir` fast path and every `find`-class walker in-OS. |
| **D7** | rename type-check gaps — `rename(file, emptydir)` and `rename(dir, file)` both succeed; POSIX says `EISDIR`/`ENOTDIR`. |
| **D9** | `F_GETFL` fabrications. |
| **D10** | walk-error errno fidelity — `_walkHops` returns bare null; `stat`/`lstat` coerce everything but `ELOOP` to `ENOENT`; `opendir` coerces even `ELOOP`. **`ENOTDIR` is never observed from a gucOS path walk.** |
| **D11** | `access(path, mode)` **ignores mode** — `access("/usr/…", W_OK)` → 0 on the sealed read-only volume. 🔴 **Decide this together with `0376`/D3** — a waive there that leaves `access` lying is not coherent. |
| **D12** | `open(dir, O_RDONLY)` → `EISDIR` unconditionally. Breaks the **fsync-the-directory durability idiom** (sqlite-class). |
| **D13** | `isatty` — **three-way**. fd≤2 with any entry → 1 always, so piped stdio still reports "a tty"; the `toWasmEnv` layer returns 1 for fd≤2 whenever `_stdinSab` is wired even if the fd was `dup2`'d to a file; kernel-side truth is right but **errno is never set on 0**. |
| **D8** | `fstat` on a pipe — three-way. |
| **D14** | `fsync(bad fd)` — three-way, minor. ⭐ `kernel.js:3418` returns EBADF while **its own comment claims it matches the in-process env's no-validation behaviour** — the comment is wrong about the code it sits on. |
| **D19** | `ftruncate` size width — `req.size \| 0` clamps to 32 bits kernel-side, so >2 GiB wraps negative → `EINVAL`. |
| **D21, D22** | futime / EROFS-ordering minors. |
| **D17** | `d_ino` always 0 in **Env N** — some C skips `ino == 0` entries. Not a bug per the review; **worth fixing for symmetry when D6 is touched.** |

**Explicitly NOT bugs, do not "fix" them:** **D15** (empty same-instance pipe
read returns 0 — documented structural exemption, inherent to sync-in-one-
thread) and **D16** (pipe write semantics; mostly by design, though
`PIPE_ATOMIC = 512` vs Linux's 4096 is worth knowing).

**Sequencing suggestion, not a mandate:** D6 + D17 together (one readdir pass);
D7 + D12 together (path-type checks); the errno-fidelity rows (D5, D9, D10,
D11, D13) as one sweep — they share a mechanism and fixing them one at a time
will re-open the same files five times.

## 2. THE DESIGN QUESTION — this is the point, not the batch

> **Do libc contracts deserve their own conformance seats?**

The review's case: **D1–D7 sat unfound** until someone diffed the three
environments by hand. The one that *was* found earlier was found only because
**CPython checks errno after readdir** — i.e. the estate's coverage of its own
libc is currently a side effect of whatever vendored program happens to be
picky. And the divergences do **not** live at one layer: several are at the
method layer (D4, D5, D8, D13, D14), so *"test one of B/R"* does not cover the
other.

**The cost of not having them is already on the books:** `0340`, `0140`, and
the `0375` corruption **sitting in the tree today**.

🔴 **Do not answer this question by adding tests for the 22 rows.** That is the
batch, and the batch is the symptom. The question is whether the estate needs a
**contract seat** — a place where a libc behaviour is asserted once and checked
in all three environments — such that the 23rd divergence cannot be introduced
silently. Design that seam first, then let the batch land through it.

## Acceptance

- **§2 answered in writing first**, with a recommendation and its cost — before
  any row is fixed. If the answer is "no seats", say why, and say what stops
  divergence 23.
- Each row above either fixed with a test that runs in **all three
  environments**, or explicitly waived with a reason. **A row that is silently
  dropped is the failure mode this ticket exists to prevent.**
- D11 resolved coherently with `0376`.
- The `kernel.js:3418` comment that is wrong about its own code corrected —
  ⭐ *a false comment asserting a closed gap is worse than a true one naming an
  open gap.*
- `blockfs` + `kernel` + `host` green with NUMBERS.
- `todos/LIABILITIES.md` is machine-checked by the `todos` suite — re-anchor or
  retire any anchored line this change rewrites, in the same commit.
