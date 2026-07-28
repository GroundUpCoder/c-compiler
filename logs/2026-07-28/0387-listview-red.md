# 0387 — 0370's listview branch was RED: two lists, not one

`todos/0370` (SysListView32 / SysHeader32) added `os/win32/listview.c` and
declared it in exactly ONE of the three places a new veneer TU has to appear.
The 185 merged gate — the first execution those bytes ever got — came back
117/9. This lane fixed both halves and gated them.

## The three lists

A new win32 veneer source must land in:

1. `os/win32/lib.json` `sources` — the host-side build truth. **0370 did this.**
2. `os/win32/include/windows.h`'s `__require_source` block — what an in-OS
   `#include <windows.h>` pulls. **0370 did NOT.**
3. `packages/win32.json` `files` — what the win32 PACKAGE actually plants at
   `/usr/opt/win32/src/win32/`. **0370 did NOT.**

They fail in completely different places, which is why the gate's output made
them look like one bug plus one mystery.

## Defect 1 — the require block (8 of the 9 failures)

`mkpkg` runs `win32RequireDriftErrors` before building the win32 package and
hard-fails on drift. So every test that builds *any* package died at package
assembly, six of them in 0.1 s: `test_gucman_e2e`, `test_clang_pkgs_e2e`,
`test_cpython_clang_e2e`, `test_gucman_quake_e2e`, `test_fontpkg_e2e`,
`test_software_e2e`, plus `test_win32_ports` (14.2 s) and `test_cmdalt_e2e`
(85.8 s). One line in `windows.h`, positioned to mirror lib.json's order.

## Defect 2 — NOT the MessageBox line

The ticket recorded defect 2 as `Undefined symbol 'MessageBox'` in
`test_cc_win32_e2e`. **That line is an intentional assertion**, not a symptom:
`test_cc_win32_e2e.js:198` requires the engine-only `menucore.h` subset to
produce a loud undefined-veneer-symbol link error, proving
`WIN32_NO_REQUIRE_SOURCES` kept the full block suppressed. It is printed by a
*passing* check. `drive.js` only ever prints the last 12 lines of stdout when a
wait times out (the timeout text itself goes to stderr, so its `search` for the
site returns -1 and the "tail before the first timeout" is really just the tail
of the whole session) — the expected link error happened to sit in that window.

Re-running the test with defect 1 fixed and reading it properly: two `wmctl
wait` timeouts (`wait win`, `wait label`), and `wccrc=1` — the wWinMain compile
**failed**. Every in-OS `cc` of a `windows.h` app was failing.

Root cause, confirmed statically without a boot, by folding the manifest:

```
node -e "…C.foldPackages(fs,path,cwd,manifest,'all',{})…"
  → /usr/opt/win32/src/win32/{advapi32,comctl32,comdlg32,crt16,gdi32,…}.c
  → listview.c: ABSENT
```

`packages/win32.json` enumerates its `src/win32/*.c` one line at a time, and
the fat image is the folded packages — so the file the require block now names
was not on disk in either flavor. Unresolvable required source ⇒ compile fails
⇒ `hellowin.out` never exists ⇒ the waits burn their clocks. `TITLE-CHANGED`
and `WAPP-UP` still appeared in the log because they are *unconditional*
`echo`s after the failed waits, which is what made the log read as if the app
had come up.

So defect 2 is real, is independent of defect 1 (neither causes the other —
both are the same omission landing in two lists), and is not the MessageBox
line at all.

## The gate that closes the class

`win32RequireDriftErrors` (os-common.js — the ONE checker, run by
`tools/mkpkg.js` and `tools/win32ports.js --check`) cross-checked lists 1↔2 but
had nothing to say about list 3. It now also asserts that
`packages/win32.json` ships every `lib.json ∪ menucore.json` source under
`src/win32/`. One direction only — the payload legitimately ships files no
lib.json source backs (`wwinmain.c`, `menucore.h`, `win32_internal.h`).

Positive control (both halves re-broken in memory against the fixed tree):

```
fixed tree : []
ctl require: os/win32/include/windows.h is missing __require_source("win32/listview.c")
ctl payload: packages/win32.json does not ship "src/win32/listview.c", which the veneer requires
```

## Why this ticket existed

`0370` closed on "committed and pushed". Its heavy-lock waiter died with its
turn, so `build/test-kernel/summary.json` never existed in its worktree and
nothing ever ran the bytes. Both defects are the kind a single suite run
surfaces immediately — six failures in 0.1 s each. The gate artifact is the
evidence; the push is not.

An image bump is owed (baked OS code changed). Master assigns the number.
