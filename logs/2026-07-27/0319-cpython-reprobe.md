# The CPython re-probe after 0319 — PASS, and the batteries question is now priced

Written by @master cont-95, 2026-07-27, immediately after v175 shipped.

## Compiler provenance — read this before quoting any number below

Per the harness note's standing rule, the artifact is named first:

**`python-new.wasm` was linked with `/tmp/cpy-m0/compiler-reprobe.js`, which is
post-0319 `main` (`88dee8fb`) plus the preserved 22-line 0320/0321/0323 patch and
nothing else.** Verified, not assumed: `diff -u compiler.js compiler-reprobe.js`
is **exactly 22 changed lines in 9 hunks** (7 hunks for 0320's 8 sites — the
`@@ -1654,8 @@` hunk carries two — 1 for 0323, 1 for 0321), and the 0321 guard
count goes 4 → 3. So the only variable against the M0 artifact is the 0319 fix.

## The result — 0319 ACCEPTANCE: PASS

Run with `PYTHONPATH=…/cpython/Lib PYTHONHOME=…/cpython`, the old M0
`python.wasm` kept as the **negative control**:

| test | old `python.wasm` (pre-0319) | `python-new.wasm` (post-0319) |
|---|---|---|
| `print(1+1)` — positive control | `2` | `2` |
| `import json; json.dumps({'a':1})` | **crash** (wasm trace) | **`{"a": 1}`** |
| `sum(x*x for x in range(10))` | **crash** (wasm trace) | **`285`** |

The negative control is what makes this worth something: the same two programs on
the same source tree with the same 22-line patch still die on the pre-0319
compiler. `0319` is the whole distance between "starts" and "usable", exactly as
`a1dfe013`'s commit body framed it.

### What the minimal core does now — 12 of 15

`sys.version` (3.13.5) · `os` · `re` · `collections` · `itertools` · `functools` ·
`typing`+`textwrap` · classes + custom exceptions + `__repr__` + f-strings ·
dict/set comprehensions · decorators + closures · nested generator expressions ·
`sorted(key=lambda)` + `2**100`.

Failing: `math`, `struct`, `datetime` — all `ModuleNotFoundError`. See below;
they are not language failures.

## The batteries question, measured rather than estimated

**The M0 artifact is a MINIMAL CPython and the arc has been reading it as a full
one.** `python.wasm` was built from `min-srcs.txt` — **174 TUs** — while the full
list `link-srcs.txt` has **235**. The 61 dropped TUs are precisely the C extension
modules: `mathmodule.c`, `_struct.c`, `_datetimemodule.c`, `_decimal`+libmpdec,
the `_hacl`/md5/sha/blake2 hash family, `arraymodule.c`, `binascii.c`,
`_pickle.c`, `_csv.c`, `_zoneinfo.c`, `unicodedata.c`, `selectmodule.c`,
`_randommodule.c`, `_heapqmodule.c`, `_bisectmodule.c`, `_json.c`, `_asynciomodule.c`,
`_contextvarsmodule.c`, the six CJK codecs, expat/pyexpat.

⇒ `import json` succeeding above is **pure-Python `Lib/json/`**; the `_json` C
accelerator is not in the build. That is a real success, not a lesser one, but
name it correctly.

### Driving the FULL list: 2 front-end root causes, 9 of 231 TUs

`-a link` over the full list (expat's 4 TUs excluded, see below), with `SOABI`
defined: **26 error lines collapsing to two root causes.**

1. **`__extension__` is not supported** — `Modules/_hacl/include/krml/fstar_uint128_struct_endianness.h:27`.
   Fails **8 TUs**: `Hacl_Hash_{MD5,SHA1,SHA2,SHA3}.c`, `{md5,sha1,sha2,sha3}module.c`
   — i.e. **the entire hashlib family, from one unsupported GNU keyword.** Filed
   as `todos/0327`.
2. **`_elementtree.c` cannot find `expat.h`** — a missing `-I…/Modules/expat`.
   Harness flag, not a compiler gap.

Everything else parses and links: math, struct, datetime, decimal/libmpdec, array,
pickle, csv, zoneinfo, unicodedata, select, random, heapq, bisect, _json, the CJK
codecs. **222 of 231.**

### Then codegen: 6 undefined libc symbols

With those 8 TUs excluded, `-a compile` over **223 TUs** reaches the linker and
stops on **7 link errors / 6 distinct symbols**, all against the probe shim
`ccbuild/shim/ccprobe_libc.h`:

```
clock_getres   explicit_bzero   fma   gmtime_r   tzset   wcstol
```

**`wcstol` is already liability `L29`, funded by `todos/0309`** ("the `wcstol`
family and wide scanf are absent"). An entry written for an unrelated reason
turned out to name a measured blocker on the CPython arc — that is the register
doing exactly what it exists for.

### The one structural finding — a whole-program flag-scoping limit

Expat's 4 TUs (`xmlparse.c`, `xmlrole.c`, `xmltok.c`, `pyexpat.c`) cannot be built
in the same invocation as CPython core, because CPython's build defines
`-DPREFIX='"/usr/local"'` while expat declares `} PREFIX;` as a typedef. A
per-TU-flags compiler scopes that away for free; **a whole-program compiler taking
one flag set cannot express it.** This is not a defect, it is a model consequence,
and it is the first place the whole-program model has actually cost us something on
this arc. Workaround is a shim header that `#undef`s the collision for expat.

## Corrections to the harness note (`cpython-m0-reprobe-harness.md`)

Two errors in it cost this lane ~40 minutes; both are fixed in that file now.

1. 🔴 **`link.sh` is the driver that FAILED.** `link.sh` is stamped 14:14 and its
   `link.err` at 14:17 holds exactly the two parse errors above.
   **`minlink.sh` + `min-srcs.txt` (14:22) is what actually built `python.wasm`.**
   The preservation pass preserved the *failed* driver and labelled it "the
   compile/link driver". `minlink.sh` differs in ways that matter: it defines
   `SOABI`, `ABIFLAGS`, `PY_CORE_CFLAGS`, `PY_CORE_LDFLAGS`, and drops the sources
   that do not build. Both are now preserved (`cpython-m0-minlink.sh`,
   `cpython-m0-min-srcs.txt`).
2. 🔴 **`ACT=link` does not emit a wasm.** The compiler's actions are
   `lex|parse|link|cfg|print|compile`; `link` is the *link-check* and dumps ~2M
   lines of linked AST to stdout, exiting 0 with no artifact. **`ACT=compile` is
   the emit.** The harness note's re-probe block said `ACT=link`, so following it
   verbatim yields "exit 0, no output file" — a silent nothing, which is a worse
   failure than a loud one.

**Both errors survived because the note was never run end-to-end before being
labelled correct** — the same shape as the `host.js`/`PYTHONPATH` correction
cont-94 made to the same file, and the same shape as the `ccbuild/shim/` miss.
Third instance in one file. A preserved harness is only preserved once someone
has re-run it from the note alone.
