# 0272 — MagicPointPlus (/bin/mgpp fork of mgp)

User-requested (2026-07-21) LIGHT gucOS feature: a fork of the MagicPoint
viewer that adds click-to-go-back and arrow-key navigation.

## Design decision: fork via a compile-time `-DMGPP` flag, not a copy

The todo asked for a *fork* ("MagicPointPlus" = its own binary/name/launcher)
but explicitly preferred "a compile-time flag or a small shared core … over a
full copy that drifts". Both pulls are satisfiable at once, so I took them
literally:

- **`vendor/magicpoint/mgpp.json`** builds a second binary (`/bin/mgpp`) from
  the *exact same source list* as `bin.json`, adding only `-DMGPP`. Every TU is
  shared — zero duplication of the ~1500-line viewer or its 30-odd image/parse
  TUs.
- The behavioural delta is **three tiny `#ifdef MGPP` blocks in
  `handle_xevent`** (`mgp.c`): a left-half-vs-right-half hit-test on the
  button-1 press, and `XK_Left`/`XK_Right` folded into the existing
  back/forward keysym case groups. With `MGPP` undefined, `mgp` preprocesses to
  byte-identical source — proven by `present_e2e`/`mgp_livereload` staying green.

This is strictly better than a mode-flag inside one binary (which the todo said
to surface, not silently pick): the fork gets its own name/launcher/association
*and* there is no runtime branch or shared-state risk in `mgp`.

### Why the hit-test is trivial

The SDL port already fills `e->xbutton.x` (client coords) in `sdlx.c`, and
`window_width` is a global. So left-half = `x < window_width/2` → mirror the
existing button-3/`b` backward path; right-half falls through to the untouched
forward path. `XK_Left`/`XK_Right` already map from `SDLK_LEFT/RIGHT` in
`sx_mapkey` — upstream simply never bound them.

## Seeding

`/usr/bin/mgpp` + a Start▸Demos launcher. The "Open with" picker is free-text,
so a `.mgp` deck opens in mgpp by typing `mgpp`; the default double-click viewer
stays `mgp` ("either viewer"). **image.json version deliberately NOT bumped** —
master serializes the gucOS deploy; 0272 rides v144.

## Tests + evidence

- `tests/kernel/test_mgpp_e2e.js` — headless page-identity off `wmctl shot`
  (`same`/`differ` on the demo deck's four distinct pages). Asserts Left/Right
  arrows and left/right-half clicks each move the expected direction and that
  `space`/`b`/`q` still work. **RED→GREEN pinned via `process.argv[2]`**:
  `node … test_mgpp_e2e.js mgp` drives the OLD binary and fails 5/21 (arrows
  inert; a left-half click is button-1 forward); default `mgpp` passes 21/21.
- `tests/browser/os-mgpp.mjs` — real mouse + arrow input through the compositor,
  using the page-2-only green `%tab` boxes as a two-sided present/absence page
  witness; saves look-confirm PNGs. Passed 10/10; the PNGs show a real
  left-half click taking the deck from page 2 back to page 1.
- `tests/run.js` RULES gap fixed: `vendor/magicpoint` + `vendor/sent` are
  OS-seeded but were mapped `projects`-only, so a `mgp.c` edit wouldn't trigger
  its own kernel/sweep e2es under `--diff`. Added both to the seeded-vendor rule.

Regression: `present_e2e`, `mgp_livereload`, `os_boot`, `os-present` all green;
kernel mgpp e2e 3/3 stable (flake 0%).

## Note (not in scope)

`demo.mgp`'s page-1 footer reads "space / click: next   b: back   q: quit" — now
slightly inaccurate under mgpp (a left click goes back). It's shared *deck
content* used by `mgp` too (and by the `present_e2e` goldens), so it was left
untouched; a per-viewer footer would be a deck/app change beyond this fork.
