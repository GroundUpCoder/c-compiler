# The CPython M0 build harness — preserved, and how to re-probe with it

Written by @master cont-92, 2026-07-27, immediately after v174 shipped and while the
`0319` fix was in flight.

## Why this file exists

The M0 probe log (`cpython-m0-probe.md:16`) says the build lived in `/tmp/cpy-m0`, *"per
the ticket's throwaway-by-design instruction."* Throwaway was the right call for a probe.
It stopped being the right call the moment jku reversed to **CPython-primary** and the
router made *"re-probe CPython immediately"* the acceptance test for `0319` — because that
re-probe is only "cheap and decisive" **while the harness still exists**, and `/tmp` on
macOS is purged on reboot and periodically swept.

At the time of writing `/tmp/cpy-m0` is **still alive** (558 MB: `cpython/` source,
`cpython-host/`, `ccbuild/`, `python.wasm` 7 MB, `compiler-patched.js`). This file
preserves the three small pieces that are **not re-derivable** — the patch, the link
driver, and the exact source list — so that when `/tmp` goes, the re-probe stays cheap.
The 29 MB CPython tarball is deliberately NOT preserved; it is a download.

Preserved here:

| File | What it is |
|---|---|
| `cpython-m0-compiler-patch.diff` | the **entire** delta between shipped `compiler.js` and the probe's `compiler-patched.js` — **22 changed lines**, three patches |
| `cpython-m0-link.sh` | ⚠️ **the driver that FAILED** — kept only as the record of the 2 remaining parse errors. **Do not re-probe with it.** |
| `cpython-m0-link-srcs.txt` | the **full** 235-TU source list — the *aspiration*, not what was built |
| `cpython-m0-minlink.sh` | ✅ **added by cont-95 — THE REAL DRIVER.** This is what produced `python.wasm`. |
| `cpython-m0-min-srcs.txt` | ✅ **added by cont-95** — the **174-TU** list actually built (the "173 TUs" of the probe log). Drops 61 extension-module TUs: math, struct, datetime, decimal, the hash family, array, pickle, unicodedata, the CJK codecs, expat. **The M0 artifact is a MINIMAL CPython — do not read it as batteries-included.** |
| `cpython-m0-shim/` | **added 2026-07-27 by @master cont-94** — `ccprobe_libc.{h,c}` + `stdatomic.h`, copied verbatim from `/tmp/cpy-m0/ccbuild/shim/`. **282 lines.** The entire `0325` Group A + `0324` prototype, validated against 173 real CPython TUs |

> ⚠️ **This file originally said "the three small pieces that are not re-derivable" and was
> read downstream as *purge risk retired*. It was exhaustive over a set of three that had a
> fourth member.** The M1 scoping lane found `ccbuild/shim/` still sitting only in `/tmp`
> and ranked preserving it as its #1 proposed ticket — "P0-adjacent, 5 minutes." It is the
> most expensive-to-recreate artifact of the whole probe (it is hand-written C, not build
> output), and it was the one piece not saved. Preserved now, in `cpython-m0-shim/`.
> ⇒ **A preservation pass is exhaustive over the set someone enumerated. Before writing
> "purge risk retired," walk the source directory, do not re-read your own list.**

## 🔑 The seam that makes the re-probe a one-liner

`link.sh:3` reads `node ${CCJS:-/tmp/cpy-m0/compiler-patched.js}`. **The compiler is an
env override.** So pointing the identical build at a different compiler is:

> 🔴 **CORRECTED AGAIN 2026-07-27 by @master cont-95, after running this block
> from the note alone and having it fail twice.** The block below named the WRONG
> SCRIPT and the WRONG ACTION. Both are fixed in place; the originals were
> `link.sh` and `ACT=link`. See `logs/2026-07-27/0319-cpython-reprobe.md`.
>
> 1. **`link.sh` is the driver that FAILED.** It is stamped 14:14 and its
>    `link.err` (14:17) contains exactly two parse errors — `xmlparse.c:284`
>    (CPython's `-DPREFIX='"/usr/local"'` rewrites expat's own `} PREFIX;`
>    typedef) and `dynload_shlib.c:41` (`SOABI` undefined). **`minlink.sh` +
>    `min-srcs.txt`, 14:22, is what actually produced `python.wasm`.** It defines
>    `SOABI`/`ABIFLAGS`/`PY_CORE_*` and drops the 61 TUs that do not build.
>    Preserved as `cpython-m0-minlink.sh` + `cpython-m0-min-srcs.txt`.
> 2. **`ACT=link` does not emit a wasm.** Actions are
>    `lex|parse|link|cfg|print|compile`; `link` is the link *check* — it dumps ~2M
>    lines of linked AST to stdout and exits 0 **with no output file**. The emit
>    action is **`ACT=compile`**. Following the old block gave a silent success
>    and no artifact, which is worse than a loud failure.
>
> ⇒ This is the THIRD error found in this one file by re-running it (after the
> `host.js` path and the missing `PYTHONPATH`/`PYTHONHOME`). **A preserved harness
> is not preserved until someone has re-run it from the note alone.**

```sh
CCJS=/path/to/compiler.js ACT=compile /tmp/cpy-m0/minlink.sh -o /tmp/cpy-m0/python-new.wasm
cd /tmp/cpy-m0 && PYTHONPATH=/tmp/cpy-m0/cpython/Lib PYTHONHOME=/tmp/cpy-m0/cpython \
  node ~/git/c-compiler/host.js python-new.wasm -c "import json; print(json.dumps({'a':1}))"
cd /tmp/cpy-m0 && PYTHONPATH=/tmp/cpy-m0/cpython/Lib PYTHONHOME=/tmp/cpy-m0/cpython \
  node ~/git/c-compiler/host.js python-new.wasm -c "print(sum(x*x for x in range(10)))"
```

Those two commands are the `0319` acceptance test: a `import json` and a generator
expression are precisely what double-freed on the un-fixed compound-literal bug.

> ⚠️ **CORRECTED 2026-07-27 by @master cont-94**, after the M1 scoping lane ran the block
> as written and it failed. The original said `node /tmp/cpy-m0/host.js …` and omitted the
> two env vars. **There is no `host.js` in `/tmp/cpy-m0`** — independently re-verified
> (`ls: /tmp/cpy-m0/host.js: No such file or directory`, against a positive control listing
> of that directory). Use the **repo's** `host.js`. Without `PYTHONPATH`+`PYTHONHOME` you
> get `ModuleNotFoundError: No module named 'encodings'`, **which reads like a port failure
> and is not one** — precisely the false-negative class this file's TRAP section exists to
> prevent, so it is fixed rather than annotated. Evidence: `notes/m1-scoping-pass.md` §1
> (in the `meta` repo).

## ⚠️ THE TRAP — do NOT re-probe with plain `compiler.js`, and do NOT report the result if you do

`compiler-patched.js` is **not** the shipped compiler plus the 0319 fix. It is the shipped
compiler with **0320, 0321 and 0323 pre-applied and 0319 NOT applied**. That asymmetry is
the entire reason the M0 artifact still double-frees, and it is the reason the merge commit
`a1dfe013` says *"builds and starts under a **PATCHED** compiler.js"*.

So there are two wrong ways to run this and one right way:

- ❌ `CCJS=<main compiler.js>` — **0321 alone produced 168 of the 173 link errors.** This
  will fail at link, loudly, for reasons that have nothing to do with 0319. Reporting it as
  "0319 didn't fix CPython" would be a false negative with a very convincing traceback.
- ❌ `CCJS=/tmp/cpy-m0/compiler-patched.js` unchanged — this is the **old** compiler. It
  re-measures the artifact we already have and reports it as the new one.
- ✅ **Re-apply this 22-line patch on top of post-0319 `main`, and link with THAT.** That
  isolates exactly one variable: the compound-literal fix.

The re-probe lane must **state which compiler its `python.wasm` was linked with** before
it reports any number. A number without that provenance is not a result.

## 🎁 The unplanned dividend — 0320/0321/0323 already have prototype fixes, validated at scale

The three patches in the diff are, one-to-one, three open tickets. Read the diff before
starting any of them; each already has a candidate shape that survived compiling **173
translation units of real CPython**, which is a far heavier exercise than any test in our
tree. That is worth a great deal as a starting point.

**`0320` (P0, preprocessor `RangeError` at ~70k tokens) — 7 sites, mechanical.**
Every one is `arr.push(...spread)` → `for (const __t of (spread)) arr.push(__t);` at
`:1591`, `:1657`, `:1658`, `:1695`, `:1716`, `:1754`, `:1836`, `:2113`. The bug is the JS
engine's argument-count limit on spread, not the preprocessor's logic. **This is the
closest of the three to a real fix.**
⚠️ But: 7 sites is *what the probe needed to get CPython through*, **not** an audit. The
ticket owes a sweep for every other `push(...)` on an unbounded array in the preprocessor,
each with a per-site reason it is safe — the same shape of audit `0319` owes for its four
other `compoundLiteralOffsets` consumers.

**`0321` (P0, static fn re-declared after its definition) — one deleted line at `:13372`.**
The probe simply removed `specs.storageClass !== Types.StorageClass.STATIC &&` from a
condition. ⚠️ **Treat that as a diagnosis, not a fix.** Deleting a guard tells you which
guard is wrong; it does not tell you what the guard was protecting. The lane owes the
question *"what legitimate case did that clause exist for, and does removing it now
mis-handle that case?"* before shipping the deletion — and a conformance test for the case
it was guarding, not only for the case it broke.

**`0323` (P1, cross-TU type strictness) — an error downgraded to a warning at `:9555`.**
The probe's own comment is a correct statement of the C model: *"C's separate-compilation
model does not require cross-TU declared types to agree, and CPython relies on that
(PY_CXX_CONST). A whole-program compiler must not turn it into a hard error."* This is the
same reasoning behind the standing **P1, not P0** ruling — a `const` qualifier with no ABI
consequence that clang/gcc/MSVC all accept. It is a whole-program-model artifact, and it
becomes a hard prerequisite the moment M1 is funded.
⚠️ `process.stderr.write` in the probe patch is a probe-ism; a real fix routes through the
compiler's own diagnostic path so the warning is suppressible and testable.

## Honest bounds on this note

- The 22-line count is a `diff` of two files on disk **at the moment of writing**, against
  `main` at `a1dfe013`. Once `0319` merges, `compiler.js` moves and hunks may need
  re-anchoring — re-run `diff -u compiler.js /tmp/cpy-m0/compiler-patched.js` rather than
  trusting the stored line numbers.
- "Validated at scale" means **these patches let 173 TUs compile and link**. It does not
  mean they are correct, and for `0321` and `0323` I have argued above that they are not
  yet. Compiling is not conforming.
- I have not re-run the build. Everything here is read off the preserved files and the
  probe log; the first person to run the re-probe should say so and post numbers.
