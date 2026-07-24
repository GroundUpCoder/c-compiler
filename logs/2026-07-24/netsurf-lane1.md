# NetSurf Lane 1 — 3 compiler.js P0 fixes + the vendored constellation

Branch `netsurf-lane1`. The foundation lane of the /bin/netsurf stream
(file-only browser; measurement probe findings live with the coordinator).
Two halves: fix the three P0 compiler.js bugs the probe's 592-TU
whole-program link shook out, then vendor the 7 NetSurf libs + core with a
re-runnable pipeline. The vendored tree compiles the CLEAN upstream forms
— the probe's workarounds are gone — so `vendor/netsurf/smoke.mjs` is
also the integration test for the fixes.

## Part A — the three P0s (conformance tests added test-first)

1. **`cg_extern_ptr_agg_init`** — an extern pointer-variable in a local
   aggregate initializer stored the variable's ADDRESS, not its value
   (`struct W w = { ptr };` behaved like `w.f = &ptr`; assignment form was
   fine). Root cause: `constEvalExpr`'s `EIdent` case returned a global
   DVar's address as its constant "value" unconditionally — correct only
   for ARRAY identifiers (decay), silently wrong for scalar/pointer/struct
   rvalues. The EMember/ESubscript case had already been fixed this way
   (todos/0220: "a global's STORED value is runtime state, not a
   constant"); EIdent predated the rule. Fix: EIdent yields an address
   only for array-typed identifiers; `constEvalAddr` grew its own EIdent
   case so `&g.inner.field` base chains (the 0220 micropython pattern)
   keep folding. The same test pins the COUSIN: a self-referential static
   initializer (`static struct SN e = { 5, &e, &e };`, NetSurf urldb.c)
   failed with "Undeclared identifier" because the declarator was
   registered AFTER its initializer parsed; per C11 6.2.1p7 scope begins
   at the end of the declarator, so new file-scope names now register
   before initializer parse (re-declarations keep the prior binding for
   the linkage logic).

2. **`link_static_fn_def_no_keyword`** — `static int f(void);` followed
   by a definition `int f(void) {…}` was treated as an EXTERNAL
   definition, so two TUs doing this collided (C11 6.2.2p4/p5: the
   definition inherits internal linkage; ~60 sites in libcss
   parse.c/language.c). The declaration-side inheritance existed
   (todos/0219); the DEFINITION path categorized by the definition's own
   storage class. Fix: inherit STATIC onto the definition when a visible
   static declaration precedes it, and categorize by the resolved class.

3. **`cg_switch_intmin_intmax`** — case values spanning INT_MIN..INT_MAX
   crashed/hung the compiler. Root cause: the br_table density check
   computed `range = (maxVal - minVal + 1) >>> 0` — the true range 2^32
   wraps to 0, "0 ≤ 512" classified it dense, and the table build created
   a ~4-billion-entry sparse array. Fix: compute the range in plain
   doubles (exact to 2^53) so the ≤512 gate rejects it.

## Part B — vendor/netsurf/

- 10 upstream trees pinned in `UPSTREAM.json` (2026-02 master), installed
  by `update.sh`: pristine → generate (gperf/perl/gen_parser; perl runs
  under `PERL_HASH_SEED=0` — hash order leaks into entities.inc, found
  when the byte-identity check failed) → `patches/` → prune →
  `relativize.mjs` → install → drift gate. **Verified byte-identical on
  re-run at unchanged pins.**
- `relativize.mjs` replaces the probe's ~300-line sed: lib trees are made
  include-order INDEPENDENT (every cross-component-ambiguous quote
  include → includer-relative); the netsurf core keeps upstream
  spellings and instead must be FIRST in app jsons (deps expand
  depth-first in buildProject, so `netsurf-core.json` leads
  `bin.json`'s deps — the include-order rule is documented in README).
- Patch table shrank to 8 files (README table); the probe's
  scrollbar/monkey/urldb workarounds are dropped (Part A pays off), and
  its debug fprintf crud is gone. frames.c got a PROPER VLA→heap
  rewrite (the probe hardcoded `[64]` — an overflow for >64 rows).
- Shims: `shim/iconv.c` productized over libparserutils' own charset
  codecs (streaming, carry buffer, E2BIG resume; every parserutils
  charset + alias table, not the probe's UTF-8/Latin-1 stopgap) —
  exercised by `vendor/netsurf/test/iconv/`; real `inet_pton` v6 parse;
  testament + install-tree alias headers. libc grew `pread`/`pwrite`
  (unistd.h static-inline over lseek save/restore) and `EILSEQ`
  (+strerror string) — C99-required, was missing entirely.
- Build graph: per-lib `lib.json`s (standalone-consumable),
  `netsurf-core.json` (browser core minus frontend), `bin.json` = the
  monkey smoke binary, auto-discovered by run.py's `projects` suite
  (compile-check, ~30 s).
- `smoke.mjs` drives the real monkey protocol under standalone host.js:
  WINDOW NEW file://hello.html → load-complete throbber tracking →
  REDRAW → asserts `PLOT TEXT X 8 Y 52 STR Hello gucOS` (+ second line,
  clip rects) → QUIT exit 0. Gotchas: monkey stops the throbber once at
  window creation (wait for STOP after the load's START); the engine
  needs default/quirks/internal.css + Messages reachable or every load
  loops through about:fetcherror — smoke assembles a res dir and passes
  `NETSURFRES` (the env var monkey honours; Lane 3 seeds
  /usr/share/netsurf).
- hubbub's treebuilder mode-trace printed every parse state to stdout
  unless NDEBUG; the estate keeps asserts live, so the trace is now
  opt-in (`HUBBUB_TRACE_MODES`) — a curated patch, not a global NDEBUG.

Lane boundaries honoured: no gucman.c / os-common.js / wm.c / mkpkg.js /
image.json edits. Seeds + app shell are Lanes 2-3.
