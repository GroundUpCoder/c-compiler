# gucman #83 — human-readable `list [--all]` + `info <name>` (+ the C mgba fold), image v129

## What landed

Ticket #83: v128's gucman had `list` (installed-only, tab-separated) and
`index` (raw index.json dump) — no human-readable catalog and no per-package
detail. Both gaps closed in `os/gucman/gucman.c`; gucman stays the ONE
engine (one network stack — the storefront GUI spawns it, never fetches).

## The raw-vs-human split (why the storefront parser survives)

The storefront (`os/win32/software.c`, `catalog_parse`) spawns
**`gucman index`** and cJSON-parses its stdout. That verb is the locked
MACHINE surface: it still echoes the repository's index.json **byte-raw**
(validated, never reformatted). The new human surfaces are DISTINCT verbs,
so no flag can bleed into the storefront's parse:

- `gucman list` — installed packages only, no network. Now an ALIGNED
  table (`NAME  VERSION  SUMMARY`, widths computed per run) instead of
  tab-separated; prints `no packages installed` when empty. The install DB
  `/var/lib/gucman/*.json` is the only source, as before.
- `gucman list --all` (alias `-a`) — the CATALOG: fetches the index over
  the existing fetch path and cross-references every row against the
  install DB (`NAME  AVAILABLE  INSTALLED  SUMMARY`). INSTALLED is honest
  per row: `no`, the installed version, or `<ver> (update)` when the
  installed version differs from the index's. Installed packages the index
  no longer carries still get a row (`AVAILABLE -`, `<ver> (not in
  repository)`) — no silent drops.
- `gucman info <name>` — per-package detail: summary, available version,
  size (integer-math KiB/MiB + exact bytes), deps, minBase from the index;
  installed y/n + version, an explicit `update:` line (`no (up to date)` /
  `yes (a -> b)`), and the PLANTED lists straight from the DB record
  (files, symlinks, openwith keys, menu entries). A package that's
  installed but gone from the repo still reports (`available: - (not in
  repository)`); repository-unreachable degrades to local install state
  with a stderr note (exit 0 — the local half was delivered); unknown name
  → loud exit 1.

No per-package special-casing anywhere — all three verbs are derived
mechanically from the index + DB records. The one deliberate float-free
choice: `gm_human_size` renders `X.Y MiB` via integer x10 arithmetic, so
nothing new leans on printf float formatting.

Consumers checked before the format change: only the two kernel e2es
asserted the old `name\t<ver>` rows (needles updated to anchored aligned-row
regexes); software.c reads the DB dir + `gucman index` only.

## Tests

- `test_gucman_e2e.js`: new `==catalog` / `==infoinst` / `==infoavail`
  legs — catalog header + punes-installed-at-version + lua-available-`no`
  rows, info for an installed package (planted lists, `update: no (up to
  date)`, size), info for a not-installed package, unknown-package loud
  failure. Existing needles moved off `\t`.
- `test_gucman_quake_e2e.js`: list needle → aligned-row regex.
- `os-gucman.mjs`: browser-realm legs for both new verbs (catalog columns,
  lua installed-at-available backreference row, punes `installed: no`) —
  same split-needle marker discipline.

## The C fold (Part B)

`origin/mgba-shared-bug` (dc7054e, mGBA v0.10.5 ALU-flush fix) merged
clean onto main — exactly `vendor/mgba/src/arm/isa-arm.c`,
`vendor/mgba/src/main.c`, `vendor/mgba/README.md`,
`tests/kernel/test_mgba_e2e.js`, `logs/2026-07-18/mgba-shared-jsmolka-bug.md`.
compiler.js untouched by both halves → no SameBoy re-check needed.

## Gate (combined v129, fat `--packages=all` image)

- kernel suite: **94/94** (incl. the extended gucman e2es, `test_software_e2e`
  proving the storefront's `gucman index` parse, `test_mgba_e2e` on the
  combined image)
- browser sweep: **31/31** (incl. the extended os-gucman.mjs)
- flake gate: green — 3× under load, kernel + browser stable, 0% flake
