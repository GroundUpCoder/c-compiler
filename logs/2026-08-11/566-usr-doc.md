# #566 — /usr/doc: self-contained in-OS development documentation

## The path-convention decision (the ticket's explicit question)

jku asked for `/usr/doc/`. The existing convention, measured: exactly ONE doc
file bakes today, `/usr/share/doc/sdl-gucos.md` (image.json:36), and the
`/usr/share/doc` path is referenced by name from two shipped places — the
minesweeper sample script (image.json, the `SDL_RENDER_DRIVER=software`
comment) and `os/gcode/GCODE.md` (baked at `/usr/share/gcode/GCODE.md`, lines
21/26). FHS also puts docs under `/usr/share/doc`.

**Decision: the real directory stays `/usr/share/doc/`; `/usr/doc` becomes a
baked symlink → `/usr/share/doc`.** Reasons:

1. Migrating would break the two live references (fixable) but would also fork
   gucOS away from FHS for no capability gain — the OS is "almost-POSIX" on
   purpose and `/usr/local → /var/local`, merged-usr `/bin → /usr/bin` show the
   established pattern is *symlink aliases over conventional layout*, not
   bespoke layout.
2. The symlink satisfies the literal ask: `ls /usr/doc`, `cat
   /usr/doc/toolchain.md` work. MountFS resolves baked symlinks in the full
   namespace (`_walkHops`), same mechanism as `/usr/local`.
3. Cost: one image.json `link` entry (`entry.link`, os-common.js:304→363).

Both paths appear in the docs themselves; `/usr/doc` is the one the docs teach
(shorter, the ask), `/usr/share/doc` is where a POSIX-minded reader will also
look and find the same files.

## The image-bump container argument (re-derived, not reflexed)

- The new doc files bake as manifest `bin` entries in the `system` section, so
  they change the system blob's bytes.
- Node-side freshness is version AND input-mtime (`newestBakeInput`,
  os-common.js:2486ff). Note the subtlety: the os/ tree walk *excludes* `*.md`
  ("can't change blob bytes" — no longer strictly true), but every manifest
  `bin` blob is stat'ed individually via the closure, so the new `os/doc/*.md`
  ARE freshness inputs through their entries. boot.js/serve.js re-bake without
  a bump.
- The browser is the forcing case: a persistent OPFS image re-materializes
  only on `bakedVersion < manifest.version` (kernel-worker.js:714) — the
  in-browser gate cannot stat inputs. v256 is SHIPPED (live at
  groundupcoder.com as of 2026-08-11), so without a bump a deployed browser
  never sees /usr/doc.
- Therefore: version 256 → 257.

## Scope decisions

- #618 (cc project mode) is OPEN → the packages chapter teaches the manual
  bin.json/lib.json → cc translation (the thing D1 round 1 proved is needed),
  and does not promise a tool.
- #563 (in-OS gucman build) is OPEN → no ".pkg.tar.gz inside gucOS" section;
  local test = cc build + run.
- #596 (intake pipeline) is OPEN → the publish chapter says the host-side
  intake is a maintainer action today, ends the developer's own job at
  `git push`, and gives the server-side verification recipe (fetch
  /packages/index.json) per the ticket comment.
- #362 is DONE (net bridge reachable from the shipped origin, Chrome 142+ LNA)
  → network prerequisites documented as landed.

## What the docs deliberately do NOT document

- `gucman build` / local `.pkg.tar.gz` install — #563 open. The packages and
  publish chapters state the limit instead.
- `cc --project` — #618 open. packages.md teaches the hand translation and
  states the limit.
- Automated publish intake — #596 open. publish.md says the maintainer step
  is manual.
- The host-side machinery (mkpkg, comguc, deploy ledger) — invisible and
  irrelevant from inside the OS; publish.md describes only the developer's
  side of the contract.
- `git merge`/`rebase`/`reset` etc. — listed as not implemented (true), with
  the FF-only workflow consequence (push to your own branch) spelled out.

The three "not yet" statements in baked docs are TRUE gap statements, so they
enrol in todos/LIABILITIES.md (L78 #618, L79 #563, L80 #596) per the 0286
rule — a doc line is exactly the register's subject matter.

## Referent corrections (agent-sweep findings the kickoff/ticket did not have)

- The auto-link srclib class is BIGGER than the #498/#631 five: it also
  contains `<ft2build.h>` (freetype), `<windows.h>`/`<menucore.h>`/
  `<gdiplusflat.h>` (win32), and the builtin ext headers `<regex.h>`,
  `<glob.h>`, `<search.h>`, `<fnmatch.h>`. Re-derived by grep over the
  shipped headers; toolchain.md tables all of them.
- There is no zlib package: `<zlib.h>` + the `z/*` sources ship in libpng.
- `-sources` packages are synthesized per mkpkg build (no packages/*.json
  files); they install at /opt/<name>-sources with a /usr/local/src/<parent>
  symlink onto the payload root.
- In-OS git does not use the curl veneer — its libgit2 smart-HTTP
  subtransport sits directly on the kernel __http_* imports.
- `git diff` emits a file-change list only (patch hunks overflow wasm memory
  on large files, by design); pull is fast-forward-only.
- PUBLISH-PATH.md still calls #362 an open blocker; the ticket is done
  (LNA priming landed) — publish docs treat the bridge + LNA grant as a
  user-visible requirement, not a missing capability.

## Gate (2026-08-11, tree = lane-566 tip)

Plan (`tests/run.js --diff origin/main --dry-run`): todos, kernel, sweep.

- todos: pass, 7.0s (run AFTER the LIABILITIES edit; liabilities.js check
  OK — 38 entries, 3 new).
- kernel: 173/173 recorded (171 native + 2 sibling gucos-packages), all
  pass; sibling block ok/members 2; evidence.resumedExistenceOnly 0; every
  carriedFrom ∈ the suite's own runs[]. Sliced 6 invocations (#630
  technique); test_os_boot.js 675.1s as its own auto-backgrounded slice.
  Artifact: build/test-kernel/summary.json.
- sweep: 59/59 recorded, all pass, 10 filter slices; same formal fields
  clean. Artifact: build/test-browser/summary.json.
- No dispatcher-level summary for the heavy suites (sliced runs — the
  per-suite artifacts carry the membership proof). No flake-gate run: this
  change adds no test and no timing-sensitive code, and no red appeared.

In-OS acceptance: booted os/boot.js on the resealed v257 image —
`ls /usr/share/doc` lists all 8 files, `readlink /usr/doc` →
`/usr/share/doc`, and every chapter reads through /usr/doc (wc -l totals
587 lines across the 6 new chapters).
