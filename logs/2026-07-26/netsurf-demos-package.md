# `netsurf-demos` — the `seed` content resource kind's first consumer

**Date:** 2026-07-26
**Branch:** `netsurf-demos`
**Design:** `meta/gucos/notes/gucman-content-resource-design.md` §7 stage 5
(the engine — stages 0–4 — shipped in image v169)

The NetSurf demo pages become a **preinstalled package** that plants them as
editable copies at `~/Desktop/Presentations/samples/Web Demos/`, and the
pages are restructured into one self-contained folder each with real
external CSS and JS.

## Why preinstalled, and why nested there

Preinstalled is a **superset** of "installable from the software manager":
the fat image folds every non-gated package, so the demos appear on a fresh
boot *and* `gucman install netsurf-demos` still works over the baked twin
(design §5's interplay case — install skips-and-keeps, so a later remove
cannot strip the baked layer).  No `nofold`, no `--purge`.

The destination honours the ask that started this ("various demos inside
Presentations/samples/ or something nested like that … each demo in its own
folder"): `Desktop/Presentations/samples` already exists in `image.json`'s
user section and already holds one sample, so the seed **merges additively**
into it and adds exactly one entry, `Web Demos/`, holding one folder per
demo.  A grouping folder rather than five loose ones because it gives the
set a landing page (`index.html`) and keeps `samples/` legible.

Because the seed is NESTED, the Desktop's own icon grid is untouched — the
usual "a new Desktop seed shifts every hardcoded row" trap does not fire at
the top level.  It fired one level down instead; see below.

## The finding: external `<script src>` never ran

All five demos were 100% inline, so **nothing in the tree exercised
subresource loading at all**.  Probing it first was the right order: a
throwaway page with an external stylesheet and an external script showed
`<link rel=stylesheet>` working and the script silently doing nothing.

Root cause, three files deep:

- `frontends/monkey/filetype.c:67-79` — the pre-seeded essentials mime table
  has `css`, `htm`, `html`, images … and **no `js`**.
- `filetype.c:234` — unknown extension falls back to `"text/plain"`.
- `content/handlers/javascript/content.c:115-122` — the JS content handler
  registers `application/javascript`, `text/javascript`, … `text/plain` is
  not among them.
- `content/handlers/html/script.c:49-55, :320-322` — a non-`CONTENT_JS` type
  makes `select_script_handler` return NULL, and the fetched bytes are
  dropped **without a diagnostic**.

So the script fetched fine and was thrown away.  Two `hash_add` lines fix it
for every frontend that shares the resolver (`gucos/fetch.c:55` uses the
same one), with or without a `mime.types` file — which matters, because the
baked `/usr/share/netsurf/mime.types` in `image.json` has no `js` line
either and the smoke harness ships no mime.types at all.  Fixing it in C
covers both; the manifest was deliberately left alone (executors don't touch
`image.json`), so that file is still worth a `text/javascript js mjs` line
for documentation's sake.

After the fix: sync, `defer`, and parse-time `document.write` **from an
external script** all work, landing in document order.

## The load-check pill — one line, two harnesses

Every page carries

```html
<p class="loadcheck"><span id="nocss">stylesheet did not load — </span><span id="jswatch">script did not run</span></p>
```

The stylesheet hides `#nocss` and paints `#jswatch` red; the script rewrites
it to "script ran" and turns it green.  That is honest UX in all three
states *and* the entire test instrument:

- monkey (`smoke-js.mjs`) has no colour in its plot stream, so it reads the
  **text**: "stylesheet did not load" absent, "script ran" present.
- in-OS (`test_netsurf_demos_e2e.js`) can't read text, so it **counts
  pixels**: green > 300, red == 0.

Two things were load-bearing and are commented where they live:

- `#jswatch.ran`, not `.ran` — an id selector (1,0,0) out-specifies a bare
  class (0,1,0), so the plain rule would never win.
- the colours `#c00000` / `#008000` are chosen **disjoint from every pixel
  the sketch canvas can draw** (its patterns always carry b≥64 or g≥48), so
  counting them over the whole window needs no coordinates.

The pill edits happen while the parser is still live, so they arrive through
normal load-time box construction — no Lane B dependency, and the pill still
works in the `-DNETSURF_NO_LIVE_RECONVERT` A/B build.

## One source of truth: `vendor/netsurf/demos/demos.js`

The demo set is not a list anywhere — it IS the directories under `pages/`,
which is exactly the tree the package ships.  `demos.js` is the one module
that says so, and everything reads from it: `smoke-js.mjs` (leg 0), the new
kernel e2e, the two older netsurf e2es (`demoFiles()` — they now plant a
whole demo FOLDER, since planting just the `.html` would silently drop both
subresources), and `drive.js`'s `pkgSeedPlants()`.

`checkContract()` fails loud on a demo with no external stylesheet, no
external script, a subresource reaching outside its folder, no pill, or
missing from the landing page's links.  Leg 0 additionally asserts every
shipped demo **has a leg** — adding a demo without one is a failure, not a
silent gap.

## Three existing tests broke, all the same class

None of them were about this feature; all three hardcoded something the new
seed moved.  Each was fixed by DERIVING, never by retuning a number:

1. **`test_desktop_defaults_e2e.js`** — `kept 33` → 57.  The reconcile's
   phase 3 walks every baked package's seeds, and on a fresh boot all 24 new
   nodes are already planted, so they land in the same `kept` counter.  Now
   `TOTAL` adds `bakedSeedPlants()`, derived per package from the definition
   + the payload tree.
2. **`test_minesweeper_sample_e2e.js`** — its comment said "samples lists
   only the .sh (row 0)", so `HOME` selected `Web Demos` and the test died
   in a mystery `wmctl wait` timeout.  New `drive.js` helper
   `userDirEntries(absDir)` models any user directory the way the file
   manager sorts it (dirs first, strcmp), from `image.json` + baked seeds;
   the test now computes its DOWN-count.  (`deskEntries()` is the
   `/root/Desktop` specialisation of the same idea.)
3. **`test_netsurf_js_e2e.js`** — its JS-off leg counted "strongly coloured
   pixels < 200" and got 2313: with scripts off the pill is *red*, which is
   a strongly coloured thing the page now legitimately draws.  Rather than
   raise the threshold, the leg now asserts the page's own report (green 0,
   red > 300 — a direct proof the script did not run) and checks the canvas
   with a predicate the red pill cannot satisfy: red and its antialiasing
   always have `g == b`; the canvas patterns essentially never do.

That drive.js pair — `pkgSeedPlants` / `userDirEntries` — is the general
answer for the next seed-carrying package, which is why it lives there and
not in this lane's test.

## Gate

`node tests/run.js --diff origin/main` → host, projects, kernel, sweep.

| suite | result |
|---|---|
| host | PASS |
| projects | 29/29 |
| kernel | 118/118 (117 baseline + `test_netsurf_demos_e2e.js`) |
| browser sweep | 39/39 (20 + 19, split for the 600 s tool ceiling) |
| `vendor/netsurf/smoke-js.mjs` | PASS, 9 legs |

The in-OS e2e carries two negative controls built **from the shipped copies
in the image** (one with its script removed → red pill; one with its
stylesheet removed → no colour at all), so the green assertion is calibrated
against a real red rather than a magic number.  The smoke-js subresource
checks were verified non-vacuous the same way — renaming `counter.css`/`.js`
turns them red.

## Left out, deliberately

- **No new demos.**  `paint`/`breakout` need Lane C's mouse coordinates and
  Lane D's canvas primitives; a stubbed version would be a lie.  All five
  existing demos shipped.
- **No menu entry, no `desktop:{cmd}`** — nothing executable to point at;
  `.html` opens through the existing `html` openwith association.
- **`os/image.json` untouched** (version bump is master's).  The one thing
  worth folding in later is a `text/javascript js mjs` line in the baked
  `mime.types` — cosmetic now that the C table seeds it, but the file
  currently reads as if it were the full map.
