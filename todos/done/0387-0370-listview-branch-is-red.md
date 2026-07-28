# 0387 — 0370's listview branch is RED — win32 require-block drift + MessageBox link error; it must gate before it can merge

- **Status**: done — branch `0387-listview-fix`, gated (kernel 126/126, sweep 40/40,
  host 24/24, todos 5/5). See "Resolution" at the foot. `0370` stays OPEN; its bytes
  ride this branch and **an image bump is owed** (master assigns it).
- **Difficulty**: medium
- **Design**: this file. Evidence branch: **`185-bundle-RED-0370`** (pushed, `4bffa4cd`).
- **Provenance**: master cont-129, 2026-07-28. Found by the **merged 185 gate**, which is
  the only gate `0370`'s bytes have ever been subjected to.

## What happened — and why nobody knew

`0370` (SysListView32 / SysHeader32 + WM_SETFONT delegation) went **idle mid-turn**: its
own final message says it left a *"foreground waiter"* watching for the heavy lock, and that
waiter **died with the turn** (lesson (BR)). Before dying it had committed, pushed head
`135c060d`, left a clean worktree, and **closed its own ticket** via `queue.js done 0370`.

Every git-visible signal therefore said "landable". **`build/test-kernel/summary.json` does
not exist anywhere in its worktree** — `0376` held the heavy lock for `0370`'s entire window
(04:53:11Z → 05:09:36Z), so it never ran the kernel suite at all. This is the case that
produced master lesson **(CK)**: *"code-complete and pushed" is not "green" — verify the gate
ARTIFACT, not the push.*

## The two defects — both confirmed off a real 126-file run

Merged gate on `185-bundle` @ `4bffa4cd` (main + `0376` + `0370`, image 185):
**117 passed / 9 failed**, `selected == executed == recorded == 126`, `carried 0`, 1061.3 s.

### 1. `win32` require-block drift — accounts for 8 of the 9
```
package 'win32': require-block drift
  os/win32/include/windows.h is missing __require_source("win32/listview.c")
  (require-block drift, design §4.4)
```
`0370` adds `os/win32/listview.c` to the win32 package tree but never declares it in
`windows.h`'s require-block. `mkpkg` hard-fails on the drift, so **every test that builds a
package dies instantly**: `test_gucman_e2e`, `test_clang_pkgs_e2e`, `test_cpython_clang_e2e`,
`test_gucman_quake_e2e`, `test_fontpkg_e2e`, `test_software_e2e` (all **0.1 s**), plus
`test_win32_ports` (14.2 s) and `test_cmdalt_e2e` (85.8 s).

🔴 **Verified NOT a merge artifact.** `git show` of `os/win32/include/windows.h` on
`origin/0370-listview`, on `origin/main`, and on the merge commit are **byte-identical** in the
require-block (all end at `comdlg32.c`). The line is missing on `0370`'s own branch.

### 2. `MessageBox` fails to link — a SECOND, distinct defect
```
test_cc_win32_e2e.js (67.7 s)
  Error: driveBoot: wmctl wait timed out (a wait on an unreachable condition —
         root-cause it, do not lengthen the timeout):
  Link error: Undefined symbol 'MessageBox' during linking
```
⚠️ **Do not assume this is downstream of defect 1.** It may be (an undeclared source is not
compiled, so its symbols go missing), but that is a *hypothesis*, not a finding — and it is
exactly the shape lesson (CD) warns about. **Fix defect 1 first, re-run `test_cc_win32_e2e`,
and only then decide whether defect 2 is real.** If it survives, it is its own bug.

⭐ **Six of nine failures are 0.1 s.** Per the standing rule, **a test that dies that fast has
no timeout story** — it failed at an assertion/throw instantly. Do not reach for contention.

## What master did about it (do not redo)

- **`0370` was DROPPED from the 185 bundle** under the pre-authorised bounded fallback
  (*"merged gate RED and the failures are listview/`0370` files → drop `0370`, re-gate
  `0376`-only, deploy that"*). 185 shipped as `0367 + 0375 + 0374 + 0376`.
- **`origin/185-bundle` was force-moved to the corrected, `0370`-free bundle**, and the red
  byte-set preserved as **`origin/185-bundle-RED-0370`** so this evidence is not lost.
- `0370`'s ticket **stays OPEN on main** (the drop restores main's `queue.json` row). Its
  branch `origin/0370-listview` @ `135c060d` is untouched and still carries the work.
- ⚠️ **`0384` goes with it.** `0370` had appended `{"id":"0384","difficulty":"light"}` and a
  `todos/0384-*.md`; dropping `0370` drops both. The id stays **reserved** (`queue.js next-id`
  surveys all refs, including `0370-listview`), so nothing will reuse it. It returns when
  `0370` lands.

## Plan

1. Add `__require_source("win32/listview.c");` to `os/win32/include/windows.h`'s require-block,
   in the position the design §4.4 ordering requires.
2. Re-run `node tests/kernel/run.js` **in full** — not just the 9. The 8 package tests should
   go green together.
3. Re-assess `test_cc_win32_e2e`'s `MessageBox` link error against the fixed tree. If it
   persists, root-cause it — 🔴 **do not lengthen the wmctl timeout**; the harness message says
   so explicitly and `0369` documents why.
4. Rebase/merge onto whatever main is by then and **re-gate on the merged bytes**, not on the
   branch alone.

## Acceptance

- Full kernel suite green **with NUMBERS**, from a `summary.json` whose
  `files.selected == files.executed == files.recorded` and `carried == 0`.
- **BOTH** browser sweep halves green (`0370` touches `os/win32/*.c`, which is baked).
- `0370` owes an **image bump** — master assigns it; a lane never edits `os/image.json`'s
  `version`.
- `todos/LIABILITIES.md` is machine-checked by the `todos` suite — re-anchor or retire an
  anchored line in the same commit.
- 🔴 **This ticket closes only on gate evidence, never on a push.** That is the whole point
  of its existence.

## Resolution (2026-07-28, branch `0387-listview-fix`)

### There were THREE lists, and `0370` filled in one

A new win32 veneer TU must appear in `os/win32/lib.json` `sources` (host builds),
`os/win32/include/windows.h`'s require block (what an in-OS `#include <windows.h>`
pulls), and `packages/win32.json` `files` (what the package — and via
`foldPackages`, the fat image — actually PLANTS). `0370` did only the first.

**Defect 1** was as filed: one line in `windows.h`, placed to mirror lib.json's order.

**Defect 2 was mis-identified in this ticket.** `Undefined symbol 'MessageBox'` is
not a symptom — it is an ASSERTED negative at `test_cc_win32_e2e.js:198`, which
requires the `menucore.h` engine-only subset to produce a loud undefined-veneer-symbol
link error, proving `WIN32_NO_REQUIRE_SOURCES` suppressed the full block. It is
printed by a *passing* check. It surfaced in the failure text because `drive.js`
searches **stdout** for the timeout line, which `wmctl` writes to **stderr** — the
search returns -1, so "stdout tail before the first timeout" degrades to the tail of
the whole session, and the expected link error happened to sit in that window.

The real second defect: `packages/win32.json` never shipped `listview.c`. Confirmed
statically, no boot needed —
`foldPackages(fs, path, cwd, manifest, 'all', {})` yields
`/usr/opt/win32/src/win32/{advapi32,comctl32,comdlg32,crt16,gdi32,…}.c` with
**listview.c absent**. So once defect 1 was fixed the require block named a file that
was not on disk in either flavor, and EVERY in-OS `cc` of a `windows.h` app failed —
`wccrc=1`, and two `wmctl wait` timeouts (`wait win`, `wait label`). `TITLE-CHANGED`
and `WAPP-UP` still appeared in the log because they are unconditional `echo`s after
the failed waits, which is what made the log read as though the app had come up.

The two defects are siblings, not cause and effect: one omission landing in two lists,
failing loudly in one place and silently in the other.

### The gate that closes the class

`win32RequireDriftErrors` (os-common.js — the ONE checker, run by `tools/mkpkg.js`
and `tools/win32ports.js --check`) cross-checked lists 1↔2 and was blind to list 3.
It now also asserts `packages/win32.json` ships every `lib.json ∪ menucore.json`
source under `src/win32/`. One direction only — the payload legitimately ships files
no source backs (`wwinmain.c`, the internal headers). Positive control, both halves
re-broken in memory against the fixed tree: one error each, fixed tree returns `[]`.

### Gate artifacts

- kernel `build/test-kernel/summary.json`: `filter: null`,
  `files {total 126, selected 126, executed 126, resumed 0, carried 0, recorded 126}`,
  1 run, **126 passed / 0 failed** (1034.5s). `test_cc_win32_e2e` 256.3s-FAIL → **11.4s-ok**.
- sweep `build/test-browser/summary.json`: `filter: null`,
  `files {total 40, …, carried 0, recorded 40}`, **40 passed / 0 failed** (921.8s).
- host suite: 24 files, exit 0, "All host tests passed", no FAIL/SKIP. (There is no
  `pnpm verify` script in this repo — `package.json` has no `scripts` block at all.)
- todos suite: **5/5**.

### Filed on the way

`todos/0396` — `tests/kernel/test_punes_e2e.js` is on disk but not in the kernel
registry (127 files, 126 rows), while `tests/run.js:363` maps `vendor/punes/` →
kernel. Pre-existing on `main`; found by counting the suite instead of trusting its
summary line.
