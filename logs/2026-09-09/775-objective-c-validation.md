# #775 final validation

Performed by cc thread 01a080d7-ee94-742a-8ee9-7e4f4be9359c, verified
codex/gpt-6-astra. The source and all validation runs below are pinned to
fb3a482d4afbd4b017910a96e701290ecc706bfb. No internal agents were used.
Independent external reviewer 01a08075-c875-7d8b-9af1-c85687c49d31 approved
this source after separately inspecting and testing the bounded-append delta.
Historical design, corrections and original reds remain in the September 8
#775 journal; #776 merged independently as 6f56fbf7 before this validation.

## Fresh mapper-selected regression gate

Executed `node tests/run.js --diff origin/main --dry-run`, then
`node tests/run.js --diff origin/main --out=build/775/gate2`, with source stable.
Run 20260908-135517-29232 started 2026-09-08 13:55:17 UTC, elapsed
3,918,004 ms, exit 0. Inspected the fresh dispatcher FIRST, then its archived
child manifests. All 25 selected suites are covered by seven literal-pass rows
(19 Python categories group into one row). Null filter; diff tier deliberately
omits netsurf-patch. This is merge validation, not a deployment/full ship claim.

Kernel 200/200, browser 70/70, BlockFS 15/15: done true, null filters,
selected=executed=recorded=total, zero resumed/carried records, every file pass.
Python 902 pass, zero failures, 113 skips; baseline checked with no violations.
Two skips beyond the earlier 111 are random live csmith native-leg timeouts
(seeds 873242738 and 134344023), exempt under the existing live-fuzz baseline.
No skip policy or tests were changed. Host guard and Objective-C host tests pass.
The broad kernel/browser Objective-C members exercise 25 actual /bin/cc programs
on each host; browser additionally compiles/runs the 79-record shared corpus.

Evidence: build/775/gate2/summary.json, gate2.log, gate2.exit and immutable
history/20260908-135517-29232 below gate2. The first broad gate remains RED and
preserved separately at build/775/gate/history/20260908-124756-86236: it caught
three unbounded call-argument spreads, fixed before this fresh run. Later filtered
manifests never substitute for the complete broad archive.

## Required flake and Objective-C repetition gates

Executed serially after the broad gate, at the same source pin:

- `node tests/flake.js`: exit 0 in 538.0s; default three repetitions under ten
  CPU load workers. Four selected kernel members yielded 12 fresh pass records;
  six browser members yielded 18 fresh pass records. Both legs actually ran.
- `node tests/kernel/run.js --filter=objc --repeat 3 --under-load=2`: exit 0,
  three fresh passes, each compiling/running all 25 Objective-C programs.
- `node tests/browser/os-sweep.mjs --filter=os-objc --repeat 3 --under-load=2`:
  exit 0, three fresh passes of the 79-record corpus and 25 /bin/cc programs.

Each selected file has exactly repetition indices 1, 2 and 3, all pass. The
reported flake rate is zero for these samples, not a universal stability claim.
The filtered manifests contain carried earlier records; these are explicitly
excluded from the 36 fresh stress executions above. Per-stage snapshots are
build/775/flake-kernel-summary.json, flake-browser-summary.json,
repeat-kernel-summary.json and repeat-browser-summary.json; stage logs and exit
files accompany them. build/775/stress-audit.json records independently checked
fresh counts and snapshot hashes. No heavy processes overlapped.

## Scope and next authorized work

#775 implements the documented Objective-C frontend/runtime/literal ABI, not
Foundation methods. User-authorized current follow-on chain is #777 real NSObject
and manual ownership/autorelease pools, #778 genuine Unicode NSString and
NSConstantString, then #779 collections with fast enumeration. Detailed library
contracts will precede implementation; ABI fixtures are not Foundation.
Properties/categories/extensions and Blocks are desired language development;
ARC follows correct manual ownership. Objective-C++ is explicitly unwanted.
The gamedev purpose remains usable in-gucOS application/editor tooling.

Final independent evidence assessment has been requested. Push/merge and ticket
closure will be recorded only after they actually occur.
