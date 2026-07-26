# 0310 — strftime %s: we match glibc/BSD (mktime, TZ-dependent), musl uses tm_gmtoff — pick and document the semantics

- **Status**: open
- **Design**: this file. Source: todos/0298 (libc skip-table triage).

## Goal

Decide, and write down, what `strftime("%s")` means on this target. Right now it is
undecided by default: we inherited one of two incompatible real-world behaviours
without ever choosing it, and the divergence is observable **only** inside the
`strftime` libc-test, which is skipped — i.e. exactly the shape of gap that never
gets looked at again.

## The divergence (measured 2026-07-27, not inferred)

`compiler.js:31097-31100` implements `%s` as `mktime((struct tm *)tp)` — a **local
time** interpretation, so the result shifts with the host timezone.

musl's `strftime` computes `%s` from the broken-down fields **minus `tm_gmtoff`**, so
it is TZ-independent. `vendor/libc-test/src/functional/strftime.c` encodes musl's
answer.

For the test's `tm1` (2016-01-03 13:23:45, `tm_gmtoff` 0):

| implementation | result |
|---|---|
| musl / the test's expectation | `1451827425` |
| ours (`mktime`) on a `+0900` host | `1451795025` |

Difference: exactly 32400 s = 9 h = this host's UTC offset.

**Crucially — and this corrects the read in 0298's verification section — ours is not
simply "wrong".** A clang-built probe against the *host* libc on this machine gives:

```
TZ=Asia/Tokyo → 1451795025      (identical to ours)
TZ=UTC        → 1451827425
```

glibc does the same thing (its `%s` calls `mktime`). So **we match glibc and BSD;
musl is the outlier**, and the failing test is asserting musl's choice, not a
universal one. This is a semantics decision, not a bug report.

Two of the `strftime` test's 40 diagnostics are this (the other 38 belong to
todos/0307).

## Plan

Pick one, and say why in a comment next to the implementation:

- **(a) Match musl** — use `tm_gmtoff` when the field is meaningful. Un-skips the
  test cleanly and makes `%s` TZ-independent, but silently changes what
  `date +%s`-shaped shell code in the OS image reports.
- **(b) Keep glibc/BSD semantics** — then the test's two `%s` assertions can never
  pass as written, and 0307's acceptance ("un-skip `strftime`") is unreachable
  without a documented per-assertion exception. Say that out loud in `tests/run.py`
  rather than leaving the entry looking fundable.

Before choosing, check what the OS image actually depends on: busybox `date +%s`,
hush, and anything under `os/` that formats epoch seconds. There is a related
existing skip — `tests/run.py` skips the `time` test for "no tzset/putenv timezone
control" — so this target's whole TZ story is thin; (a) is the option that does not
require a TZ story at all.

## Acceptance

- A decision recorded in a comment at `compiler.js`'s `%s` case, naming both
  behaviours and why this one.
- If (a): the two `%s` assertions in the libc `strftime` test pass.
- If (b): `tests/run.py`'s `strftime` entry states that the test cannot pass as
  written, so nobody schedules an impossible un-skip.
- Either way the `todos/LIABILITIES.md` entry pointing here is retired or re-pointed.
