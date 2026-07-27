# python-clang — the clang-built CPython as a comparison artifact

Lane `python-clang`, 2026-07-27. Provenance: **jku's ask**, verbatim —

> "Can we also ship a python-clang, ie a gucman entry that installs the CPython built with
> clang instead of our own compiler? I'm curious how it'll compare in performance with not
> just my compiler but also against eg micropython with either compiler."

Tickets filed: **`todos/0331`** (ship it — blocked, see §4) and **`todos/0330`** (the sibling's
libc is 206 commits stale). Build recipe preserved next to this file:
`python-clang-build.sh`, `python-clang-ccjs-build.sh`, `python-clang-shim.h`,
`python-clang-srcs.txt`.

**Deliberately NOT done: any timing measurement.** The benchmark is a separate, quiet-machine
job; another lane was running a compiler gate on this box throughout. Everything below is a
size or a correctness result.

---

## 1. The headline, up front

**CPython 3.13.5 builds and runs with clang.** `python-clang.wasm`, **4,523,831 bytes**, runs
on `host.js` at functional parity with our compiler's artifact.

And the size finding runs **against** us:

| same 174 TUs, same tree, same libc lineage, same host.js ABI | total | code | data |
|---|---|---|---|
| `compiler.js` (0320/0321/0323-patched) | 7,006,275 | 5,120,947 | 1,853,688 |
| clang `cc2wasm -O2`                    | 4,523,831 | 2,964,617 | 1,421,771 |
| **ratio**                              | **1.55×** | **1.73×** | **1.30×** |

Stripped of the name section (which only clang emits): **1.59×**. Both artifacts were built by
the two committed recipes from one build root and one source list, and both were run and
verified before these numbers were taken.

## 2. Q2 — the 7 MB vs 29 MB anomaly is RESOLVED, and it was an artifact

The lane brief flagged this as a gate: our `python.wasm` was 7 MB, the clang+wasi-sdk positive
control 29 MB, i.e. **4.1× in our favour** — the direction that must be checked rather than
celebrated. It does not survive.

**The 29 MB is 75% debug info.** CPython's default `OPT` is `-DNDEBUG -g -O3 -Wall`
(`/tmp/cpy-m0/wasibuild/Makefile`), and nothing stripped it. Section census of that artifact:

```
wasi-sdk total       27.70 MB      (29,046,900 bytes)
  debug + name       20.80 MB      .debug_loc .debug_abbrev .debug_info
                                   .debug_str .debug_line .debug_ranges name producers
  everything else     6.90 MB      <- the strip-comparable size
```

**6.90 MB — for 304 objects, against our 6.69 MB for 174.** There was never a codegen-density
win to report. The "4.1× smaller" reading is **retracted**; it measured `-g`.

The brief also warned that the module-set gap moved the wrong way (235 vs 304 makes the output
gap *more* anomalous, not less). That reasoning was sound and is now moot — with debug info
removed the two are within 3% of each other on a *larger* module set.

### The count discrepancy, re-derived

The brief warned that "173" was doing several jobs. Every number below is `grep -c .` on a file
that exists, not a quotation:

| number | source | what it actually is |
|---|---|---|
| **174** | `logs/2026-07-27/cpython-m0-min-srcs.txt` | the TU list that **built the artifact** — the only one that describes a real binary |
| 235 | `logs/2026-07-27/cpython-m0-link-srcs.txt` | the aspirational full list; its driver `cpython-m0-link.sh` FAILED |
| 304 | `find /tmp/cpy-m0/wasibuild -name '*.o'` | the wasi-sdk control's objects |
| 173 | commit `a1dfe013` / ticket `0321` | matches nothing on disk — do not propagate |

This lane used **174** on both sides.

### What was made comparable, and what could not be

Made comparable (this is what licenses the table in §1):

- **Same source tree.** Both recipes read one `python-clang-srcs.txt` from one build root.
- **Same generated inputs** — `pyconfig.h`, `Modules/config.c`, the 24 `frozen_modules/*.h`.
  These come from a wasi-sdk `configure`; our compiler cannot generate them.
- **Same libc lineage.** `cc2wasm` does not use wasi-libc — it reuses **our** libc, mechanically
  extracted from `compiler.js` by the sibling's `extract-libc.js`. Same ABI too: the output
  imports only host.js's `"c"` env. (`host.js` has **zero** WASI support — grep confirms — so
  the 29 MB wasi artifact could never have run in gucOS at all. It is a host-side control, not
  a candidate.)
- **Dead-code elimination.** `compiler.js` defaults `gcSections: false` (`compiler.js:32543`)
  while `wasm-ld` GCs by default — a real unfairness. Closed by measurement rather than
  assumption: rebuilding ours with `--gc-sections` saves **48,692 bytes, 0.7%**. Not the
  explanation. (`--dedup-literals` is likewise off by default and untested here.)
- **Build date.** Pinned `-DDATE`/`-DTIME` (below).

**Could not be made comparable — the one caveat on the table:**

- The two libcs are **206 commits apart** (§3). Ten files differ. Only three symbols were
  material and all three were neutralised so both sides run the *same* implementation — but
  "same libc lineage" is not "same libc bytes", and closing that is `todos/0330`.
- Our side is **not shipped `compiler.js`**. It cannot build CPython: it dies in the
  preprocessor with `RangeError: Maximum call stack size exceeded` at the `todos/0320` spread
  site. The A/B therefore runs `compiler.js` **plus the open 0320 + 0321 + 0323 patches**
  (verified: the patch base is byte-identical to `origin/main`'s `compiler.js`). Once those
  three P0/P1s land the caveat evaporates; until then no size or speed number here describes a
  compiler anyone can `git checkout`.

## 3. The libc is 206 commits stale — and it blocked the build

The sibling pins `vendoredFromCommit: 2b6bfb7a`; this repo's HEAD is `3d51b684`, **206 commits**
later. Re-extracting changes 10 files. Two bit immediately:

- **`pread`/`pwrite`** landed here in `1794b618` (NetSurf Lane 1), after the pin. CPython's
  generated `pyconfig.h` sets `HAVE_PREAD 1`/`HAVE_PWRITE 1`, so `Modules/posixmodule.c`
  compiled fine under `compiler.js` and **failed under clang**. Worked around in
  `python-clang-shim.h` by copying both functions *verbatim* from `compiler.js`'s `unistd.h` —
  so the two artifacts get identical semantics rather than a feature gap.
- **`wcstol` collided.** `compiler.js`'s libc has no wide integer parsers at all
  (`todos/0325` Group A). **Both** downstream projects independently filled that same hole —
  the CPython probe in `ccprobe_libc.c`, the sibling as `wasm/libc-ext/__wcsto.c` — and they
  met at link time as `duplicate symbol: wcstol`. The recipe renames the shim's copy to a
  private symbol, which keeps *one* implementation (the probe's, the same one our build uses)
  in force on both sides. Dropping the shim's instead would have silently swapped
  implementations across the A/B.

Not re-vendored here on purpose: it rewrites the bytes of all 9 published clang payloads, whose
acceptance legs I cannot responsibly re-run mid-round. `todos/0330`.

> **The general shape**: an A/B across two toolchains silently measures "clang vs compiler.js"
> **plus** "libc-2026-07 vs libc-2026-05". The second term grows every week the pin sits.

## 4. Q1 — mechanism: a gucman package. And why it can't ship yet

**Decision: gucman package.** Not a bake-overlay entry. The two are not alternatives — they are
two layers of one pipeline, and the package is the user-facing half jku asked for:

- sibling `wasm/image/manifest.json` → `mk-overlay.mjs` → `out-image/overlay.json`
- consumed by **both** the opt-in bake overlay (`os/image.json:3-10`, `enableFlag:
  "clang-apps"`, `default: false`) **and** `mkpkg --clang` via the `clangApp` resource kind
  (`tools/mkpkg.js:316-323`)
- seven `*-clang` gucman packages already ride it; `packages/box2d-clang.json` is the template

**Verb**: `python-clang` only. gucman has no alternatives mechanism — `grep -E
'conflict|provides|replaces|alternativ'` over `gucman.c` + `mkpkg.js` returns **zero hits**, and
`gucman.c:976-980` refuses the entire install on an existing symlink. Both re-verified.

**It cannot be committed in this lane**, and the blocker is not on the clang side. Both halves
route through a **committed CPython source tree that neither repo has**:

1. `clangApp` can only name a payload already in the sibling overlay; publishing one needs a
   manifest project with a committed `base`. This build runs out of a machine-local
   `~/build/python-clang` — committing a manifest pointing there ships something nobody else
   can rebuild.
2. **The binary is useless alone.** Verified: with no `PYTHONHOME`/`PYTHONPATH` it dies with
   `ModuleNotFoundError: No module named 'encodings'`. A usable package must carry a stdlib —
   538 `.py` files, ~10 MB excluding `test`/`idlelib`/`tkinter`/`turtledemo`. Sizing is fine;
   *which* modules, laid out how, wired to `PYTHONHOME` how, is the CPython-port design.

That design is **M1's**, and M1 is unfunded and unratified (`todos/0313`). jku has already ruled
on adjacent points (CPython ships as a gucman package, never baked; claims `python3`/`cpython`
only). So this lane deliberately **did not** invent a `vendor/cpython`: two lanes writing that
tree differently is a merge disaster, and the stdlib subset is exactly the call M1 exists to
make. `todos/0331` carries the full plan for the moment the tree exists.

> ⚠️ The lane brief's premise was "this is cheap — the overlay mechanism already ships." That
> re-verified as **true but not sufficient**: the mechanism is cheap for projects that *have a
> source tree*, and all nine that ship do. CPython has none. The brief was right to say
> re-derive rather than inherit.

## 5. What was actually built, and how to rebuild it

174/174 TUs compile under clang (172 first try; the 2 were `pread`/`pwrite` and `__minstack`,
both toolchain-boundary artifacts, neither a CPython issue). `__minstack(8388608)` is a
`compiler.js` dialect directive; clang takes `-Wl,-z,stack-size=8388608` instead.

```
R=$HOME/build/python-clang sh logs/2026-07-27/python-clang-build.sh        # -> python-clang.wasm
CCJS=$R/compiler-reprobe.js R=$HOME/build/python-clang \
    sh logs/2026-07-27/python-clang-ccjs-build.sh                          # the A/B twin
```

`R` must hold `cpython/` (pristine 3.13.5) and `ccbuild/` (the wasi-sdk-generated headers).
Both recipes were run end-to-end from the committed copies before this was written.

Parity checks — identical output from both artifacts, except the version banner, which
usefully self-identifies (`[Clang 21.1.8 …]` vs `[C]`):

```
print(1+1) → 2          2**100 → 1267650600228229401496703205376
sorted({'b':2,'a':1}) → ['a','b']        sum(x*x for x in range(10)) → 285
json.dumps({'a':1}) → {"a": 1}           [c for c in 'abc'] → ['a','b','c']
io.StringIO/os.sep → StringIO /          script file + sys.argv → argv: ['a','b']
```

**Reproducibility.** `getbuildinfo.c` bakes `__DATE__`/`__TIME__` — which `compiler.js` happens
not to define (hence its `xx/xx/xx` banner) but clang does. The recipe pins
`-DDATE='"xx/xx/xx"' -DTIME='"xx:xx:xx"'`, CPython's own documented override. Two independent
full builds then differ in **exactly one field**: the module name in the `name` section, which
`wasm-ld` bakes from the `-o` basename — `mk-overlay.mjs` already builds straight to the final
name for precisely this reason. Everything else, 4.4 MB of code and data across two runs with
different temp dirs, was byte-identical.

## 6. For whoever runs the benchmark

The artifact is built to be measurable, per the brief's 2×2 (our compiler vs clang) × (CPython
vs MicroPython): no hardcoded name or path, `-o` free, stdlib located by
`PYTHONHOME`/`PYTHONPATH`, and both sides rebuildable from the two committed recipes.

Two things that would corrupt a naive run:

- **Use `-a compile`, not `-a link`.** `link` is the link *check*: it dumps ~2M lines of AST,
  exits 0, and writes **no file**. (Already burned a previous lane; the committed recipe
  defaults correctly.)
- **The `compiler.js` side is not a shipped compiler** (§2). Report it as
  "compiler.js + 0320/0321/0323" or wait for those to land — anything else overstates what a
  reader can reproduce.
