# #631 — the zlib `gz*` layer (and `inflateBack`) become linkable from the in-OS cc

The residual #498 deliberately recorded: `vendor/zlib/lib.json` listed 10 of
the 15 upstream libz TUs, so `<zlib.h>` — on the default include path, with a
require block that is a *projection of lib.json* — promised `gzopen`/`gzread`/
`gzwrite`/`gzprintf`/`gzclose` and died at link with a bare
`Undefined symbol`. Verified live before the fix (fat image, in-OS cc):
5 gz link errors, each citing `/usr/include/zlib.h`.

## The referent set, re-derived from code (differs from the ticket)

The ticket named the four `gz*` TUs. The header also declares
`inflateBack`/`inflateBackInit_`/`inflateBackEnd` **unconditionally**, and
`src/infback.c` was equally absent from `lib.json` — the identical
promised-but-unlinkable trap, confirmed live (`Undefined symbol
'inflateBackInit_'`). So the promotion is **five** TUs, not four, and
`lib.json` now equals the full 15-TU upstream libz member set. There is no
sixth: every other symbol `zlib.h` declares lives in the original 10.

Also *not* in the ticket: `vendor/netsurf/netsurf-core.json` had to **drop**
its four explicit `../zlib/src/gz*.c` entries. The "netsurf-core precedent"
(#498's rationale for leaving gz out) assumed the two listings would
path-identity-dedup. They do not: dedup applies to *require-vs-listed-TU*,
not *listed-vs-listed* — the netsurf build broke with `Duplicate definition
of symbol 'gzclose_w'` the moment lib.json carried the gz TUs. netsurf still
reaches them, now through its `libpng/lib.json → zlib/lib.json` dep chain
(both netsurf consumers dep libpng).

One kickoff correction: the os-common `srclibs` table does **not** pin a
count. `srclibErrors` derives the expected require set dynamically from
`lib.json` (set equality per namespace), so no os-common edit was needed —
the gate re-pins itself.

## Hazard decisions

1. **`gzguts.h` resolution** — resolves. It ships inside the payload's whole
   `vendor/zlib/src` tree (the libpng package's `z` srclib entry is
   tree-mapped), and the gz TUs include it with a quoted include relative to
   their own directory. Proven empirically: the in-OS compile of the gz round
   trip succeeded on the fat image (`/usr/src/z`) — and the extended e2e also
   proves the minimal-image `gucman install` tier (`/usr/local/src/z`).
2. **libc surface** — no gap found, no shim needed. On non-Windows C99 the
   `gzguts.h` ladder selects plain `snprintf`/`vsnprintf` and
   `open/read/write/lseek/close`, all of which the gucOS libc provides.
   `gzprintf` (the vsnprintf path) round-tripped byte-exact in the probe.
3. **Repo-side blast radius** — measured, not assumed. All 7 win32 ports
   still link (`tools/win32ports.js --check` green). The one breakage was the
   netsurf double-definition above, fixed by deleting the redundant explicit
   listing. `vendor/cpython/bin.json` needs no edit: it lists its own 10-TU
   zlib subset directly (no lib.json dep, so no duplication), and its
   `srcRoots {z}` resolves the grown require block's five new names to files
   that exist — the #498 "not one flag-flip from unresolvable" property holds.
   `os/git` uses libgit2's own `deps/zlib` copy and is untouched.
4. **Cost** — measured, immaterial. In-OS compile time: three consecutive
   `<zlib.h>`-only compiles fit inside one wall-second both before and after
   (the five extra TUs are small and the linker dead-strips unused code —
   package binary payloads grew only +42…+146 bytes *compressed*). Fat image:
   84,616,296 → 84,634,840 bytes (**+18.5 KB, +0.022%**), dominated by the
   `-sources` closures now carrying the five TUs' source text (~+17 KB
   compressed each in the standalone `-sources` payloads).
5. **`os/image.json` bump — owed, 255 → 256.** Container argument: the
   *minimal* (shipped) image bakes `gucman`, `deck`, and `mgp`/`mgpp`, all of
   which reach `vendor/zlib/lib.json` through deps, and the package-payload
   sha diff proves same-pipeline binaries change bytes when the TU set grows.
   A baked-binary change is invisible to the browser OPFS gate without a
   version bump. `compiler.js` is untouched (#498 already moved
   `__SDL_image.c`'s metadata into the headers), so this is the image-only
   half of the #498 container mix.

## Package version bumps (measured by index sha diff, not guessed)

13 of 87 payloads changed. Independently-versioned → manual bumps:
`libpng 1.6.58-2→-3` (ships the edited `zlib.h`), `netsurf 3.12-2→-3`,
`cairodemo 1.0→1.0-2`, `demos 4→5`, `sent 1→2` (binaries relink). The
changed baked-app `-sources` payloads (deck/gucman/mgp/mgpp/wm/…) are
auto-versioned by baseVersion and ride the 256 bump.

## Decisions rejected

- **Padding the require block past lib.json** — rejected per the ticket; the
  block stays a pure projection and the §4.4 gate stays load-bearing (red
  control: deleting `z/uncompr.c` from the block fails `win32ports --check`
  at exit 1 naming the exact require).
- **Leaving netsurf-core's explicit gz entries "harmless"** — rejected by the
  compiler itself (duplicate `gzclose_w`); explicit source lists don't dedup.
- **Skipping `infback.c` as out-of-ticket-scope** — rejected; the header's
  promise is the spec, and a 15-TU lib.json is the only state in which
  "include the header ⇒ everything it declares links" is true.
- **A separate gz probe test file** — rejected; extending the existing
  `zonly.c` in `test_cc_libpng_e2e.js` covers both the fat standalone path
  and the minimal gucman-install tier path with zero registry change, and
  the existing `ZLIB_NO_REQUIRE_SOURCES` hatch leg keeps the anti-vacuity
  red control.

Controls (literal outputs in the lane report): positive gz round trip
`GZRT n=33 match=1 tail=line2 631` + `IBACK-DONE`; negative control
`Undefined symbol 'gucos_631_no_such_symbol'` rc=1; drift-gate red control
exit 1, green exit 0.
