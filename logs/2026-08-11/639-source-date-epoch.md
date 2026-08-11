# #639 — preprocessor honours SOURCE_DATE_EPOCH for `__DATE__` / `__TIME__`

## The two axes, and where the fix sits

The bug had a time axis (every build stamps a new string) and a timezone axis
(the local-time accessors made two machines disagree at the same instant —
cont-583's addition to the audit finding). Both collapse at one site:
`preprocess()` computes `dateStr`/`timeStr` once per TU. The fix adds ONE
registry field, `PPRegistry.sourceDateEpoch` (null = the pre-change local
wall clock), rendered with the UTC accessors when set. The unset path keeps
the LOCAL accessors deliberately: gcc/clang without the variable stamp local
time, the ticket's acceptance pins "unchanged", and anyone who wants
determinism states it by setting the variable — moving the default to UTC
would change every casual build's banner to buy nothing the override doesn't
already buy.

## Why the env seam lives in createDefaultPPRegistry

CLAUDE.md's portability rule ("no environment variables — options and flags")
is about compiler.js surviving the browser workers; SOURCE_DATE_EPOCH is THE
ecosystem convention and only means anything read from the environment. The
synthesis: the REGISTRY FIELD is the compiler option (browser-safe, embedder-
settable), and `createDefaultPPRegistry()` seeds it from `process.env` under
the file's existing `typeof process !== 'undefined'` guard. That one seam
covers every Node-side entry uniformly — the CLI, mkpkg/buildProject (the
epic's package-payload path), boot.js-hosted kernels — and is inert by
construction in kernel-worker/ksvc, where no `process` global exists. A
browser boot cannot see the variable, so it cannot regress.

Nuance worth recording: under boot.js the in-OS `/bin/cc` now honours the
HOST's SOURCE_DATE_EPOCH, because the kernel (and so the cc driver) runs
inside the Node process's environment. The IN-OS process's own environ does
NOT reach the compiler — the `__compile` RPC carries `{argv, cwd}` only
(kernel.js OP.COMPILE, host.js `__compile`). Making `SOURCE_DATE_EPOCH=x cc
foo.c` work at the hush prompt needs envp plumbed through the RPC — a kernel
ABI extension, separable from this ticket and surfaced in the lane report
rather than silently cut: the epic's payload-determinism payoff is fully
delivered by the Node seam, since packages are built by mkpkg under Node.

## The invalid-value rule (stated, per acceptance)

The value must be a string of ASCII decimal digits with numeric value ≤
253402300799 (9999-12-31T23:59:59Z — gcc's cap, which also keeps the year
four digits, the width `"Mmm dd yyyy"` assumes). Anything else — empty,
signed, spaced, hex, fractional, over-cap — REFUSES the build loudly,
naming the variable and the rule: CLI `error:` + exit 1 (caught, no stack
trace), embedder throw, and a named `cc:` line from createCcDriver (wrapped
so an invalid host value under boot.js surfaces as itself, not as the
compile hook's catch-all EIO). No silent fallback to the wall clock: that
would un-reproduce exactly the builds the variable exists to pin. Stricter
than gcc's strtoll on `"+5"`/`" 5"` — the reproducible-builds spec says an
ASCII integer, and strictness here can only reject, never mis-stamp.

## Test shape (tests/host/test_source_date_epoch.js)

Pacific/Kiritimati (UTC+14) vs Pacific/Pago_Pago (UTC-11): 25 h of offset,
no DST in either, so their local calendar dates differ at EVERY instant —
the TZ axis needs no clock in the assertion and no midnight race. Leg 1
asserts the epoch's UTC rendering directly and in isolation so the red
control at base fails AT the load-bearing claim; leg 5 proves the unset
path is still local by the same 25 h trick (the two dates must DIFFER).
Epoch 0 is its own leg — `sourceDateEpoch` is falsy-zero bait, hence the
`!= null` tests everywhere. Red control at db325184: 18 FAIL, leg 1 first
("Aug 11 2026" where the epoch demands "Sep  9 2001"); leg 5 passes at
base, as an unchanged-behaviour leg must.

## Related

#633 pinned quake's banner per-TU to ship a deterministic package payload —
this is the compiler-level fix for that class. #21 (bake mtimes) is the
complementary half of blob determinism; nothing here touches it.
