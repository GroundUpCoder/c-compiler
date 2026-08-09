# #617 — the -sources closure follows textual #include (P0)

The #568 dogfood's headline bug: `gucman install gcode-sources` + in-OS `cc`
could not rebuild gcode — the payload omitted `xatonum_template.c`, busybox's
`#include "a-.c-file"` template idiom, invisible to `closureOf` (listed
sources + headers-under-include-dirs + deps only). The bake never noticed
because bake-time cc resolves includes against the full repo tree; the e2e
never noticed because it cat'd bin.json and stopped one step short of `cc`.

## The fix is the general closure, not the pattern heuristic

The ticket's alternative ("ship sibling files matching a template pattern")
was rejected per the kickoff: it ships files nobody includes, misses files
outside the sibling dir, and encodes one project's idiom as a platform rule.
Instead `closureOf` now follows quoted `#include "…"` in every collected
file, transitively, in cc's own resolution order — includer's directory
first, then the include path (which now also carries `-I` compilerArgs,
walked for headers exactly like `includes` — the same gap one flag-spelling
over). A target is kept only when it lands inside the owning source root
(after `normalizeRelPath`); an unresolved target is a builtin/system header
or an untaken conditional include — nothing to ship. The union include path
across a unit's projects can over-resolve relative to any single TU's flags:
over-inclusion ships an extra file, the cheap direction.

## Measured estate-wide effect (old closure vs new, at landing)

The bug was never gcode-shaped; the follower surfaced real misses across 27
units (~2.7k files, mostly shared headers per unit):

- `doom-sources` +92: doom declares NO include dir — the payload had **no
  headers at all**.
- `sh-sources` / `coreutils-sources`: the same xatonum template idiom.
- `quake-sources` +progdefs.q1/q2; `jq-sources` +5 oniguruma data units;
  `micropython-sources` +re1.5 templates + emitnative.c.
- Every freetype-linking unit (+~130 each): freetype's internal src headers
  and aggregation units, plus os/*.h reached includer-relative from
  os/win32 sources.

Payload bytes change under unchanged versions for those units — mkpkg's
equal-version republish is routine (#595); whether any deserve a
`sourcesVersion` bump for installed users is the coordinator's call.

## The regression net that was missing

test_source_packages.js grows the leg whose absence let this ship: a REAL
compile from PAYLOAD-ONLY inputs in a hermetic dir — materialize
gcode-sources' def files into a tmp root, `buildProject('os/gcode/bin.json')`
with a reader bound to that root. Red control verified: the pre-fix closure
reproduces the exact dogfood failure (`Got 2 lex errors in xatonum.c`). A
synthetic fixture additionally pins transitivity (template → nested
include), `-I` resolution, root-escape skipping, and that the textual
follower tolerates `#if 0`-guarded unresolvable includes (it sees through
the preprocessor by design; skip-not-throw is what makes that safe).

## Named, not fixed

The freshness twins (`newestBakeInput`/`newestPkgInput`, the todos/0354
comment at the `projectExternalDirs` call) share the *shape* of this hole
for mtime scanning — but they are DIR-granular, and every file the follower
added lands inside a directory the twins already walk (project dirs, dep
dirs, include dirs). No live blind spot today; textual following there is
real per-file-read weight in a hot dev-loop scan for zero measured gap.
Left un-widened deliberately; the residual theoretical case (an include
reaching a directory no project declaration names) is the coordinator's to
ticket if wanted.

Tickets: #617 (this), #568/#621 (dogfood rounds), #407 (the -sources rule).
