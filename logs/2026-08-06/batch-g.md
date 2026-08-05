# Batch G — the false-green cluster (#466, #456, #175, #535) + the P0 it flushed out (#542)

One lane, four light/P2 gate-honesty tickets, one full 25-suite gate. The
batch's thesis — a guard that cannot go red admits regressions — proved
itself live: running #466's can-fail control found a real, shipped-feature
P0 hiding behind the existence-only check it replaced.

## #542 (P0, found and fixed here) — emitted-HTML seeding wrote through O_RDONLY fds

`compiler.js`'s HTML emitter seeded `dataFiles` with
`fs.open(path, 0x40|0x200, 0o644)` — O_CREAT|O_TRUNC with access mode
O_RDONLY — and never checked the write result. Since the fd access-mode
enforcement (todos/0376) every seed write failed EBADF, so every bundled
asset landed as 0 bytes: doom.html died at `W_Init` with "Wad file
doom1.wad doesn't have IWAD or PWAD id". Verified stepwise: the embedded
base64 is byte-identical to the vendor WAD (emission fine), and a Node
repro against BlockFS shows `write` returning null on the 0x240 shape and
4 on 0x241. Fix: O_WRONLY opens, throw on a short data-file write, warn on
a failed bundle-hash write (non-fatal — the page re-seeds next load). The
Node `.js` emitter uses `writeFileSync` and was never affected.

Why nothing saw it: the only tests of this path are the two doom drivers —
manual, in no suite, and until #466 existence-only. The window opened when
0376 landed and stayed open because the instrument could not go red.

## #466 — doom drivers gate on freshness

Both drivers now run `requireFreshArtifacts` (the #171 helper) against a
single shared input spec (`tests/browser/lib/doom-artifacts.mjs`):
compiler.js + inlined host.js + libc-ext.js + vendor/doom
(bin.json, src/*.[ch], Nuked-OPL3/*.[ch], doom1.wad) + build-doom.mjs — a
stated conservative over-approximation, the quake precedent. A
caller-supplied custom page keeps the existence check (unknown input set).
Controls: missing artifact → exit 1 naming the rebuild; touched
d_main.c → exit 1 STALE naming artifact and input, both drivers; rebuilt →
both drivers pass end to end (renders: 256000/256000 opaque; motion: 4
distinct frames). Also corrected quake-renders.mjs's "mirrors
build-quake.mjs exactly" comment (it deliberately over-closes on .h files).

## #456 — the residual was the red-log overwrite, not the race

The ticket's headline -j2 index race was already fixed by todos/0388
(per-instance mkdtemp repos — verified in tests/kernel/lib/gucman.js), so
the serial-vs-isolated design call in this batch's kickoff was moot. The
live residual acceptance bullet: the solo re-run that DIAGNOSES a red
truncates `<artifactDir>/<file>.log` into a PASS. suite-runner's runOne now
moves a log aside under a monotonic `.redN` suffix (announced on stdout)
when the previous invocation's own record for that file was non-pass;
greens overwrite freely. Contract pinned as section 10 of
tests/host/test_suite_record.js — 2 checks, verified red (rc=1) against the
unfixed runner, then green.

## #175 — the headline was already fixed; the audit was the deliverable

os-boots' vi leg has used the `VI-CAT""-OK` split needle since #356 — the
ticket predates that landing. The mandated audit: 149 waitOut sites in 33
tests/browser files; 140 static needles scanned mechanically
(needle-in-any-prior-typed-literal), 9 helper/dynamic sites read
caller-by-caller (fileman/touch split in the helper; keybind/paste-mac/undo
callers all split). One real instance: os-vt1mobile's history leg waited on
`/root/arr`, contained in its own echoed append command — which produces no
output, so the wait asserted nothing. Fixed with `&& echo ARR""1-OK`. One
scan false positive: os-boots:147 (`a.out`) — the reload resets __osOut.
Can-fail control: vi deliberately writing nothing FAILS the leg while the
split-needle wait still completes on cat's real output. The full 51-file
sweep (the loaded condition) passed at the gate.

## #535 — derived ext unit coverage

test_source_packages.js's payload assertion iterated a hardcoded 6-name
list, so #111's 8 search.h-family units had zero coverage (vacuous green —
the quiet half of the class batch-b fixed loud at 5eee574b). Now derived
from libc-ext.js filtered to `.c` (load-bearing: the map carries 7 headers,
which ride the header map), strengthened to byte-equality, parse-sanity
guarded, 14 units covered. Control: dropping regcomp.c at os-common's ext
merge fails naming `["regcomp.c"]`.

## Gate

`node tests/run.js --diff origin/main` at 61385ebc: rc=0, 3221.5s, all 25
suites pass. Heavy records honest: kernel 167/167, sweep 51/51, each with
one runs[] entry, filter null, 0 resumed, 0 carried. No image.json bump:
the #542 fix changes the HTML emitter, which is not a bake input path.
Liabilities: 41 entries before and after.
