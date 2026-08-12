# #623 — rename the require-drift checker (`win32RequireDriftErrors` → `requireDriftErrors`)

The §4.4 require-block drift gate started life checking only the win32
veneer's `__require_source` blocks (Lane B2), and its name said so. By #662
it adjudicated eleven srclib packages (freetype, zlib, libpng, libjpeg,
libnsgif, libnsbmp, pixman, cairo, giflib, cjson) plus win32, so
`win32RequireDriftErrors` had become a misnomer — and a dangerous one: a
checker whose name claims a win32-only scope is a standing invitation for the
next srclib author to assume their package is not covered and skip the gate,
the exact silent-coverage failure #623 was filed against.

**Note the ticket body is stale**: it was written before #661/#662 and asks
for a data-driven package registry. That already exists — `SRCLIB_TABLE` +
`srclibDriftPackages()` in os-common.js, proved by #662's one-row cJSON
addition. This lane is ONLY the rename the ticket also calls out (re-scoped
by @master; see the ticket comment).

## The name: `requireDriftErrors`

Considered `srclibRequireDriftErrors` and rejected it: the gate adjudicates
every `srclibDriftPackages()` member — the srclib owners AND win32 (whose
windows.h/menucore.h/gdiplusflat.h multi-header blocks it also pins). Putting
ANY package subset in the name repeats the misnomer class this ticket exists
to fix; the function checks require-block drift, full stop, and its own error
strings already say "require-block drift". So: `requireDriftErrors`.

## What changed (rename + comments only, zero logic)

- `os/os-common.js` — definition + `module.exports` entry; the gate's doc
  comment now says the blocks it guards are the win32 veneer's AND every
  srclib package's shipped header.
- `tools/mkpkg.js:857/863`, `tools/win32ports.js:227/231` — the two callers
  (call + "the ONE checker" comments).
- `os/win32/gdiplus.c` — a comment naming the checker (not in the kickoff's
  list; found by grep).
- **All ten srclib vendor headers** (`ft2build.h`, `zlib.h`, `png.h`,
  `jpeglib.h`, `nsgif.h`, `libnsbmp.h`, `pixman.h`, `cairo.h`, `gif_lib.h`,
  `cJSON.h`) — each require block's comment names the checker. These are the
  pointer a future package author actually follows, so a stale name there IS
  the discoverability failure; also not in the kickoff's list.
- `vendor/netsurf/patches/libnsbmp.diff` + `libnsgif.diff` — the two edited
  netsurf headers are patch-recorded, and `patchcheck.mjs` strict-reverse-
  applies every section against the committed tree, so the tree edit and the
  regenerated `+` lines travel as ONE change (the todos/0407 rule). Verified:
  `patchcheck: 72 file check(s), 0 failure(s)`. The pristine base did not
  move, so `pristine.json` is untouched.

Historical records keep the old name on purpose: `logs/**` and `todos/done/`
are journals of what was true when written; rewriting them would falsify
history.

## Controls (renamed checker, re-verified)

Positive: clean tree → 0 errors, through the renamed export. The four #464
negative controls all still REFUSE, each with its exact message: dropped
srclib shim ("packages/freetype.json ships no vendor/freetype/srclib/
ftbase.c, which vendor/freetype/demo/ft2build.h requires"), regrown gdi32.c
block ("stray __require_source"), win32.json dropping a veneer TU ("does not
ship \"src/win32/user32.c\", which the veneer requires"), remapped srclib
namespace ("does not map srclib namespace 'freetype' to the
vendor/freetype/srclib tree"). End-to-end caller refusal re-proved the #662
way: drifted ft2build.h on disk → `node tools/mkpkg.js freetype` exits 1 with
`package 'freetype': require-block drift` naming the stray require.

Explicitly left alone (out of scope per the ticket): the win32-internal pins
(windows.h/menucore.h/gdiplusflat.h/gdiplus.c/the gdi32.c empty-pin) stay
hardcoded inside the checker — they are win32's own multi-header blocks, not
a per-new-package registration burden.
