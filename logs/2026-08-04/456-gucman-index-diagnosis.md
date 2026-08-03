# #456 — `gucman: index.json is not valid JSON` under `-j2`: what it was not, and what shipped

## The ticket's stated mechanism is refuted

The ticket says the two tests "share the live `dist/packages` index while one rebuilds it".
They do not, and have not since **2026-07-28**: `#388` (`d67f25a0`, then `488f3536`) gave every
*running instance* its own `mkdtemp` repo dir over a shared `--pool`
(`tests/kernel/lib/gucman.js:64`). The failure was observed on **2026-08-03**, six days later,
on a tree that already carried the fix. So the ticket body describes a hypothesis, not the
mechanism, and it should be corrected when the ticket closes.

## Every shared write path in the harness is atomic — there is no race left to remove

Checked in source rather than assumed:

| Path | Publisher | Verdict |
|---|---|---|
| `build/test-fixtures/os-system.min.img` | `mkimage.js:112,143` — `.tmp-<pid>` + `renameSync` | atomic |
| `<pool>/<payload>` | `mkpkg.js:767-768` — `.tmp-<pid>` + `renameSync` | atomic |
| `<out>/index.json` | `mkpkg.js:839-841` — `.tmp-<pid>` + `renameSync` | atomic |
| shared `--pool` prune | `mkpkg.js:772` — skipped when `sharedPool` | append-only |

A reader can therefore never observe a partial file, and the two tests' repos are disjoint.
Serialising them (the ticket's suggested "minimum correct fix") would slow the suite to work
around a race that is not there, so it was deliberately **not** done.

## Not reproduced — 100 runs

Under the heavy lock, with the fixtures prebaked and the mkpkg pool warm:

- `--repeat 20 -j2` over both files — **40 runs, 0 red** (this fans out file-by-file, so it
  mostly pairs each file with *itself*);
- a harness holding the lock once and launching the two files as a genuine **pair**, 30 rounds
  — **60 runs, 0 red**.

An intermittent failure that does not reproduce is not diagnosed, and this one is not. What
follows is what the funnel *does* establish.

## The funnel: only two states produce that exact line

`gucman.c:839` is reachable only on `CURLE_OK` **and** HTTP 200 — any transport failure returns
earlier, printing a curl error instead. Probing what Node's `fetch` (which is what
`kernel.js:_httpPump` consumes) reports for each malformed 200:

| Response | reader | reaches gucman as |
|---|---|---|
| declared `Content-Length`, socket destroyed early | **throws** (`terminated / other side closed`) | a curl error — **not** this symptom |
| chunked, terminated cleanly part-way | `done` after N bytes | 200 + short body → **this symptom** |
| 200 with `Content-Length: 0` | `done` after 0 bytes | 200 + `buf.p == NULL` → **this symptom** |

So a **wire truncation cannot present as this failure**. Only an empty body or a
cleanly-terminated short one can. That also rules out a Content-Length reconciliation as a fix:
a body short of a *declared* length cannot end cleanly, so such a check would be unreachable and
untestable, and it was removed again rather than shipped as decoration.

The corroborating detail from the original report: the failing run took **1.4 s**, its normal
duration, and exactly the 7 checks of the `==pkg` section failed while both `checkFullSet` legs
and the fat-image leg passed. The boot and the fs were healthy and nothing timed out — the
index fetch failed *fast*, which is what an empty or short 200 looks like.

## What shipped

The message threw away the one fact that separates those cases. `gm_fetch_index` printed the
same sentence for a 31 KB malformed document, a body cut short, and nothing at all — and passed
`cJSON_Parse` a NULL pointer in the third case. That collapse is why one occurrence cost two
investigations: the byte count would have named it in a line.

`gm_index_parse_error` now reports which fault it was — an empty body named as such, otherwise
the bytes received, the parse offset (`cJSON_GetErrorPtr`) and a printable-sanitized head of
what arrived. `cmd_index` shares the one reporter. This is a **product** fix: a real user behind
a proxy or hitting a partial publish gets told the transfer was empty, instead of being told
their repository is corrupt.

## The control, and a defect in the control itself

Session F of `test_gucman_e2e.js` drives a deliberately faulty repo through all three shapes.
Measured: **pre-fix 8 FAIL / 4 ok, fixed 0 FAIL / 12 ok**, no other leg in the file disturbed.

The first attempt at that control went red for the *wrong* reason — every leg reported
`Timeout was reached`. The server had been created with `http.createServer` **inside the test
process**, and `driveBoot` is `spawnSync`: it blocks the caller's event loop for the whole boot,
so the server accepted the connection and never answered, and the transfer died on the kernel's
30 s headers deadline. That is why every repo server in this suite is a child process
(`tests/kernel/lib/fault-repo.js`). A control that goes red for a reason unrelated to its
subject proves nothing, and this one nearly shipped looking like a pass of the "it can fail"
bar.
