# 0448 — vendor libjpeg as an in-OS source library + flip NetSurf WITH_JPEG

- **Status**: open
- **Design**: the gucOS image-viewer scoping pass,
  `~/git/meta/gucos/notes/image-viewer-scoping-email.md`. That report is the
  authority for *why*; this ticket is the authority for *what*.
- **Provenance**: filed 2026-07-30 by @master (cont-218) on jku's direct
  instruction, given as an email reply to the scoping report. jku's words:
  *"For the first step let's queue vendoring libjpg. This is very useful just for
  various reasons and also for NetSurf independent of the viewer so would be
  good."* He said **queue**, not do-now — hence P1, behind the Rust/codex P0 band.

## 🔴 THIS IS NOT THE IMAGE VIEWER

**No viewer app is in scope.** jku has **not** decided pull-from-ReactOS versus
roll-our-own; that call waits on a separate GDI+ scoping answer still in flight.
This ticket delivers a decode library and a browser capability that are useful on
their own. **Do not add a viewer app, a window, or a shell association.**

## Goal

Two independent wins from one vendoring job:

1. **`cc` in-OS can compile against libjpeg.** A `libjpeg` srclib package, so C
   programs written inside gucOS can decode and encode JPEG.
2. **NetSurf renders JPEG images.** NetSurf already ships a JPEG image handler
   upstream; it is compiled out only because the library is absent.

## Scope — measured against the tree at `main` `55ad5efe`

🔴 **`kernel.js` and `host.js` are at the REPO ROOT. `os/kernel.js` and
`os/host.js` DO NOT EXIST.** (Neither is touched by this ticket.)

**Verified absent — this is all genuinely new work:**
- `vendor/libjpeg/` does not exist. `packages/libjpeg.json` does not exist.
- `vendor/netsurf/netsurf-core.json` contains **`-DWITH_PNG`** (line 16) and
  **`netsurf/content/handlers/image/png.c`** (line 116) and **no JPEG entry of
  any kind**.

**Verified present — do not re-create these:**
- `vendor/netsurf/netsurf/content/handlers/image/jpeg.c` **already exists**
  (12,676 bytes, upstream). It is not compiled today.
- `vendor/libpng/` is the pattern to copy: `LICENSE`, `bin.json`, `lib.json`,
  plus flat `.c`/`.h` sources.
- `packages/libpng.json` (the srclib pattern) and
  `tests/kernel/test_cc_libpng_e2e.js` (the e2e pattern) both exist.

### 🔴 Three corrections to the filing brief — measured, and they win

1. **There is NO `UPSTREAM.json` in the libpng pattern.** The brief said
   *"lib.json + bin.json, LICENSE kept in-tree, UPSTREAM pin."*
   `find vendor -maxdepth 2 -iname "UPSTREAM*"` returns **exactly one** path:
   `vendor/netsurf/UPSTREAM.json`. **`vendor/libpng/` has no UPSTREAM file.** It
   pins its version in **two** places instead: `lib.json`'s `description`
   (*"libpng 1.6.58 — PNG reference library"*) and `packages/libpng.json`'s
   `version` field. ⇒ **Pin libjpeg the same way libpng does. Do not invent a
   `vendor/libjpeg/UPSTREAM.json` and do not go looking for one.**
2. **`netsurf-core.json` is OUTSIDE the patchcheck fence; `image/jpeg.c` is
   INSIDE it.** `vendor/netsurf/patches/pristine.json` has **0** matches for
   `netsurf-core.json`, **0** for `image/jpeg.c`, and **1** for `image/png.c`.
   ⇒ Editing `netsurf-core.json` is an ordinary edit. **But if you have to touch
   `jpeg.c` at all, there is no existing `.diff` section for it and the
   pre-commit hook will block you until you CREATE one** (see Acceptance).
3. **IJG libjpeg needs a `jconfig.h` that upstream does not ship.** Classic IJG
   libjpeg generates `jconfig.h` from `configure`. There is no configure step
   here, so **the vendored tree must carry a hand-written `jconfig.h`** matching
   this toolchain. Treat it as a real deliverable, not a detail. Record which
   options you set and why.

## Plan

1. **Vendor the library.** IJG libjpeg (classic, plain C — **not**
   libjpeg-turbo, which brings SIMD and a build system) at `vendor/libjpeg/`,
   following `vendor/libpng/` exactly: `lib.json` (`type: "lib"`, `name`,
   `description` carrying the version, `includes`, `srcRoots`, `sources[]`,
   `deps` — libjpeg needs **no** `zlib` dep, unlike libpng), `bin.json` for a
   golden decode test, and `LICENSE` kept in-tree. Write the `jconfig.h`.
   🔴 **Derive `sources[]` from the upstream tree you vendor, not from a list in
   this ticket** — a list here would rot. Omit the files that exist only for the
   `configure`/`make` build or for the command-line tools (`cjpeg`, `djpeg`,
   `jpegtran`, `rdjpgcom`, `wrjpgcom`) unless you deliberately want them, and say
   which you omitted.
2. **Package it for the in-OS `cc`.** `packages/libjpeg.json`, mirroring
   `packages/libpng.json`: a `files` map exposing the public headers under
   `include/` (`jpeglib.h`, `jconfig.h`, `jmorecfg.h`, `jerror.h` — confirm the
   set against the tree) plus the source tree under `src/`, and an `srclib` block
   declaring the `include` and `src` roots.
3. **Prove it compiles in-OS.** `tests/kernel/test_cc_libjpeg_e2e.js`, mirroring
   `test_cc_libpng_e2e.js`: compile a small C program against the package inside
   gucOS and assert a real decode result, not merely a zero exit status.
4. **Flip NetSurf JPEG on.** In `vendor/netsurf/netsurf-core.json`: add
   `-DWITH_JPEG` beside `-DWITH_PNG`, add
   `netsurf/content/handlers/image/jpeg.c` beside `png.c`, and add the dependency
   on the new library the same way the PNG path declares its own.
5. **Make a JPEG actually render.** Extend the NetSurf image e2e coverage so a
   JPEG is decoded and displayed, not just linked.

## Acceptance

- `vendor/libjpeg/` exists with `lib.json`, `bin.json`, `LICENSE` and a
  hand-written `jconfig.h`; the version appears in `lib.json`'s `description` and
  in `packages/libjpeg.json`'s `version`. **No `UPSTREAM.json` is added.**
- The `bin.json` golden test decodes a known JPEG and asserts the **pixel
  result**, not just a successful compile.
- `packages/libjpeg.json` is a valid srclib package, and
  `tests/kernel/test_cc_libjpeg_e2e.js` compiles a C program against it **inside
  gucOS** and asserts a decode result. **Report the new kernel-suite total** — the
  old total is a passing-looking number that means your test did not run.
- `vendor/netsurf/netsurf-core.json` carries `-DWITH_JPEG` and
  `netsurf/content/handlers/image/jpeg.c`, and the NetSurf build is green.
- **A JPEG renders in NetSurf**, proven by an e2e leg, not by the presence of the
  compile flag.
- 🔴 **The patchcheck fence is respected.** If you edit anything under
  `vendor/netsurf/netsurf/`, the tree edit and its `patches/<component>.diff`
  section **travel in the SAME commit**; refresh `pristine.json` with
  `patchcheck.mjs --write-manifest` if the residual moved. The pre-commit hook
  runs `patchcheck.mjs --staged`, and **if it blocks you it is telling the truth
  — do not reach for `--no-verify`.** There is no existing `.diff` section for
  `image/jpeg.c`, so an edit there fails until you **create** the section.
  If you changed nothing under `vendor/netsurf/netsurf/`, **say so explicitly.**
- The base image stays byte-identical **unless** this ticket deliberately ships
  the new package in the image — **decide that question, state the answer, and
  report the image number either way.** Do not let the image change silently.
- `node tests/run.js --diff --dry-run` maps the touched paths. (`--diff` is
  **ignored** in the `--list` form.)
- **`todos/LIABILITIES.md`** is machine-checked by the todos suite — re-anchor or
  retire an anchored line in the **same** commit. A gap that does not enter
  `todos/` does not exist.
- **No viewer app, window, or file association is added.** (See the scope note.)

## Notes for the lane

- **Build to the goal, not to the demo.** Vendor the library properly and
  generally. "The viewer is not decided yet" / "nothing uses encode yet" are
  **not** reasons to ship a decode-only stub or to special-case the easy path. If
  some part is genuinely high-complexity **and** genuinely out of scope, say so
  explicitly rather than silently narrowing.
- **Any prose you write follows ASD-STE100 Simplified Technical English.** This
  does not apply to code, code comments, or commit messages.
- 🔴 `tests/kernel/run.js` takes `--filter=SUBSTR` (comma-separated), **never a
  bare filename** (bare arg = exit 2). `tests/lib/heavy-lock.js` is a host-wide
  mutex: **exit 3 means "lock held", not a test failure.** Never set
  `CC_NO_HEAVY_LOCK=1`.
- 🔴 Heavy `summary.json` numbers live in **`runs[0]`** (`executed`/`total`).
  **`failed` and `recorded` DO NOT EXIST as keys — an absent field is not a
  zero.** Count non-`pass` entries directly from `results`.
- **Every presence/absence probe owes a positive control in the same command** —
  a zero from a broken instrument and a zero from a missing payload are the same
  output.
- Estimate from the scoping pass: **1–2 days.** Re-derive it yourself; do not
  treat that number as a budget.
