# 0318 — tests/run.js: map vendor/ paths to suites (the RULES table has no vendor rule)

- **Status**: done (filed 2026-07-27 by todos/0117 R1)
- **Difficulty**: light
- **Design**: this file.

## Goal

> **Premise correction (2026-07-28, at implementation).** The paragraph
> below was already false when this ticket was picked up, and the record
> should not keep asserting it. `tests/run.js` carried per-project vendor
> rules AND a blanket catch-all (`[/^vendor\//, ['projects']]`); because
> rules UNION, nothing under `vendor/` could report UNMAPPED. Acceptance
> legs 2 and 3 below were both already satisfied on `main` at `f6428735`.
>
> The real defect was the opposite shape — **under-scheduling, not
> under-mapping**. The catch-all made every unlisted vendor dir *look*
> mapped while handing it the narrowest possible gate: 26 of 37 dirs
> change the bytes of the baked system blob, yet dirs like `vendor/fonts`
> (every rendered glyph), `vendor/freetype` (the ksvc text service) and
> `vendor/cjson` (compiled into five seeded binaries) scheduled only
> `projects` — which, lacking a `bin.json`, does not even build cjson or
> fonts. In the other direction `vendor/tinyemu` rode the OS-seeded rule
> and drew `kernel` + `sweep` that nothing justifies. A comment at the
> `^vendor/micropython/` rule additionally claimed the gap existed and
> cited *this ticket*, ~55 lines above the catch-all that refuted it —
> a true-sounding, ticket-backed comment being the most durable kind of
> wrong. That comment is now gone.

*Original text, retained for the record:*

`tests/run.js`'s `RULES` table — the single documented source of "what does
this diff need" — has **no rule for `vendor/`**. Every vendored project
(doom, quake, busybox, sqlite, lua, netsurf, sameboy, freetype, libpng,
zlib, libgit2, the win32 corpus, …) therefore reports **UNMAPPED** on a
diff that touches it, which is the "warned, never silently skipped" state
CLAUDE.md describes as *the signal to add a rule*. Nobody added them.

todos/0117 R1 added the first one (`^vendor/micropython/` →
micropython, micropython-upstream, kernel, sweep) because its own diff
needed it. The rest are still unmapped.

## Plan

1. Enumerate `vendor/*` and, for each, the suites that actually consume it.
   The two axes that decide the answer:
   - does a `tests/run.py` category build it (lua, sqlite, freetype,
     libpng, zlib, disw, micropython, cairo, tcc…)? → that category;
   - is it seeded into `os/image.json` or a `packages/*.json`? → then it
     folds into the image fixture, so `kernel` + `sweep` (same blast
     radius the existing `^packages/` rule already claims);
   - does a named kernel/browser e2e drive it (doom, quake, sameboy,
     term's freetype, netsurf, winmine…)? → that suite.
2. Prefer a small number of explicit rules over one blanket
   `^vendor/ → everything`: a blanket rule would make a comment-only edit
   in vendor/libgit2 run the browser sweep. Rules accumulate (a path can
   match several), so a per-project rule plus a catch-all narrow default
   is fine.
3. Whatever is left genuinely unmapped (e.g. compile-stage-only corpora)
   should get an explicit `[]`-with-a-reason entry rather than staying
   UNMAPPED, so the table states the decision.

## Acceptance

- `node tests/run.js --list` shows a rule for every `vendor/*` directory
  that any suite consumes, each with a stated reason.
- ~~A diff touching a vendored project reports suites, not UNMAPPED.~~
  Already true before this ticket (the catch-all) — superseded by: every
  one of the 37 `vendor/*` dirs carries an explicit rule stating its gate
  and the evidence for it, and the catch-all survives as a floor so a
  newly vendored tree still cannot report UNMAPPED.
- No rule is wider than the project's real blast radius (spot-check: a
  vendor/libgit2 edit must not schedule `sweep`) — held, and `tinyemu`
  was NARROWED off `kernel`+`sweep` for the same reason.

## Outcome (2026-07-28)

Derived per directory from three axes, in this order: the bake-input
closure (`os-common.js` `newestBakeInput` — the estate's own oracle for
"does an edit here restale the system blob"; 25 of 37 dirs are inside it,
and the shared fixture is the FAT image), the `tests/run.py` category that
builds it, and the `vendor/<d>/bin.json` the `projects` glob needs.

`sweep` is not redundant with `kernel` for closure dirs: the headless
suite never constructs a compositor, so a blob change that breaks
*rendering* is invisible to it. That is what justifies the fat-fixture
radius rather than `kernel` alone, and it is why `^vendor/netsurf/` gained
`sweep` — its original reason weighed only "no browser leg names netsurf"
and missed that gucos/ is seeded into the blob every browser boot uses.

Note the union rule: the catch-all is a FLOOR no entry can subtract from,
so an `[]` entry under it would be inert. Entries narrower than the floor
document a reason; they do not remove `projects`.

Spun out: **todos/0354** — `newestBakeInput` recurses a project's `deps`
but not its `sources`/`includes`, so `vendor/cjson` (compiled into five
seeded projects) is missed by the freshness gate.
