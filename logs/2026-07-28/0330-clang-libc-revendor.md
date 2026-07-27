# 0330 — re-vendoring clang-simplified's wasm/libc (225 commits of drift)

`todos/0330`. Sibling branch `0330-libc-revendor` @ `85aa87b`
(clang-simplified); this side carries the shim retirement + close-out.

## What the pin actually was

The ticket said 206 commits behind. By the time this ran it was **225**:
`2b6bfb7a` → `9fdaed52`. Re-extraction touched **11 files** — the ticket's
predicted 10, plus `SDL3/SDL_main.h` (it named the `SDL3/` directory without
enumerating it).

I extracted from **`compiler.js` at `9fdaed5262dc61037d57e3dab8ae5ed00cf4c2c1`**
(= `origin/main`), read out of a c-compiler *worktree* at that commit rather
than the main tree, so the whole operation was self-consistent. The guard
(`check-libc-vendor.sh`, the todos/0039 invariant) exits 0 against **both**
that worktree and the default `~/git/c-compiler` — both were at the same
clean commit.

## The blast radius is smaller than the ticket predicted — and that is the finding

The ticket asserts the republish "changes the bytes of **all 9** existing
overlay payloads". Measured against the main tree's `out-image/` — which is a
genuinely clean A/B baseline, built from the *same* repo commit `1beacf2` with
the *same* `simple1/out/llvm`, differing **only** in the libc pin:

| payload | verdict |
|---|---|
| doom-clang | CHANGED +48 B |
| box2d-clang | CHANGED +672 B |
| imgui-clang | CHANGED +240 B |
| etl-clang | CHANGED +576 B |
| ninja-clang | CHANGED +320 B |
| gameboy-clang, sdl_demo, stl4, glm-clang, tinyrenderer-clang | **byte-identical** |
| 6 assets (WAD, ROM, .obj, 3×.tga) | byte-identical |

**5 of 10 changed, not 9 of 9.** (It is 10 payloads now, not 9 — the T3 lane
added ninja-clang and tinyrenderer-clang after the ticket was written.) The
five that did not move GC'd out every changed symbol. Note `sdl_demo` is an
`--sdl` build that did *not* move while `box2d`/`imgui` did: the delta is not
"SDL programs", it tracks `strerror` (the new `EILSEQ` case + its string) and
the handful of new `__SDL.c` entry points that survive dead-code elimination
in a given program.

### The hazard that did NOT materialise

`__SDL.c` now routes `SDL_HasClipboardText` through a **new `__clip_has`
import** instead of `__clip_get`. That is the shape of a deploy-skew break: a
payload gaining a host import an older `host.js` cannot satisfy. Checked
directly — the import set is **byte-identical across all ten modules**, old vs
new, and **no module imports `__clip_has`** (the call is GC'd out everywhere in
this corpus). `host.js` at `9fdaed52` does provide it (`host.js:5827`), so even
a future consumer is covered. All ten payloads re-compile as valid
`WebAssembly.Module`s.

## `__SDL_image.c` is vendored but not linked — on purpose

The new `__SDL_image.c` includes `<png.h>`, which is a c-compiler *vendored
project*, not part of the libc, so it cannot link in the workable set and is in
no `.tus`. This is not a new gap: `extract-libc.js` vendors **every** source and
`libc.tus` picks the subset that builds, so `__SDL_image.c` simply joins the
five that were already there (`__SDL_popup.c`, `__alloca.c`, `__guc.c`,
`__sdl3webgpu.c`, `__setjmp.c`).

## The shim retirement, with a negative control

`logs/2026-07-27/python-clang-shim.h` lost its `pread`/`pwrite` half (the
`__minstack` macro stays — that one is a real compiler.js-dialect artifact, not
a staleness workaround). Rebuilt python-clang against the **worktree** cc2wasm
(`CC2WASM=` override — the script defaults to `~/git/clang-simplified/cc2wasm`,
i.e. the still-stale main tree, which would have silently proved nothing):

    174 TUs → /Users/jku/build/python-clang/python-clang-0330.wasm
    4,523,917 bytes, 6m37s, exit 0

`cpython/Modules/posixmodule.c` is line 32 of the 174-source list, so the link
succeeding *is* the proof it compiled. Pinned it down anyway with a two-sided
control on a 3-line TU calling both functions:

    worktree cc2wasm (re-vendored libc)  → built, 4776 bytes
    main-tree cc2wasm (stale pin 2b6bfb7a) → error: call to undeclared
                                             function 'pread' / 'pwrite'

So the functions really arrive from the re-vendored `<unistd.h>`, and the
negative control reproduces exactly the failure the ticket describes.

## wcstol: unchanged, deliberately

`compiler.js` at `9fdaed52` still ships **no** wide integer parsers (`wcstol`
and `wcstoul` appear nowhere in it). So after this re-vendor the situation is
byte-for-byte what it was:

- the sibling still carries `wasm/libc-ext/__wcsto.c` (and
  `extract-libc.js`'s `HEADER_APPEND` still injects the two declarations into
  `wchar.h` — exactly one copy, verified);
- the c-compiler CPython probe still carries its own in `ccprobe_libc.c`;
- `python-clang-build.sh` still resolves the link-time collision with
  `-Dwcstol=__ccprobe_wcstol`.

Retiring both copies is `todos/0325` Group A and was explicitly out of scope
here; nothing was half-fixed.

## Two process gaps found on the way

1. **`test_clang_pkgs_e2e.js` run directly bypasses the heavy lock.** The
   RAM guard (`tests/lib/heavy-lock.js`) is taken by `tests/kernel/run.js`, the
   *suite* runner — not by individual test files. But this test's own header,
   and `todos/0330`, both prescribe `node tests/kernel/test_clang_pkgs_e2e.js`,
   which boots full OSes while taking no lock at all. Running it against a live
   kernel suite is precisely the stacking the 2026-07-25 OOM policy exists to
   prevent, and nothing stops it. Filed as `todos/0342`.
2. **The diff planner cannot see a cross-repo change.** `node tests/run.js
   --diff <merge-base> --dry-run` reports *(nothing)* for this lane, correctly:
   the c-compiler-side diff is `logs/` + `todos/` only, which is the IGNORE set.
   The substantive change is in the sibling repo, so the c-compiler-side
   acceptance had to be named by the ticket rather than derived by the mapper.
   Recorded, not filed — a rule in `RULES` cannot map a path this repo does not
   contain.

## What this does not do

No `os/image.json` change and none needed: the `*-clang` apps ship as gucman
*packages* built from the overlay, not as baked image entries, so no version
bump is implied by this lane.
