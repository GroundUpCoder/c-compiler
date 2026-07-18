# Per-filetype desktop icon glyphs (ticket #82)

Every desktop icon used to render as the same flat white tile + solid navy
center block (folders got the 0185 tab+body, the bin its 0093 basket, links
the black notch) — an .mgp deck, a .txt, an image and an executable were
indistinguishable. This lands a **general filetype→glyph dispatch** in the
wm.c desk render loop.

## The dispatch (type source)

`menu_ent` grew a `kind` field; `desk_kind()` normalizes one desktop entry:

1. name `Recycle Bin` → `DK_BIN` (basket, unchanged)
2. `is_dir` → `DK_DIR` (tab+body, unchanged)
3. `ow_is_runnable()` (openwith.h — the same `\0asm`/`#!` peek activate()
   does, symlink-following) → `DK_EXEC` (the pre-#82 solid block).
   **Runnability wins over extension**, matching activate()'s order, so an
   icon looks like what double-click DOES: a `#!` script named `build.sh`
   is a launcher, not a text file.
4. `ow_key_for()` (lowercase extension) through ONE `desk_ext_map[]` table:
   `mgp|sent` → `DK_DECK` (screen-on-stand), `png|ppm|…` → `DK_IMAGE`
   (frame + sun + ridge), `txt|md|log|cfg|…` → `DK_TEXT` (page + text lines)
5. else `DK_FILE` (dog-eared page)

No per-type special cases in the render loop: `draw_icon_glyph()` is one
switch, all glyphs stay fill_s/rect_s flat rects in the two desktop inks.
The type sources are the ones openwith.h already owned — no new
normalization machinery.

## Sniff cost — carry-over in desk_load

`ow_is_runnable` opens the file, and desk_load runs on the 1s coarse tick;
sniffing every entry per tick would be ~N brokered open/read/close RPCs per
idle second (IDLE-POWER regression). So kinds **carry over** from the live
grid when (name, is_link, is_dir) is unchanged — steady-state ticks stay
I/O-free; new names sniff; the ctx menu's Refresh sets `desk_resniff` and
re-sniffs everything (the escape hatch for an in-place content change,
e.g. `cc -o` landing a wasm magic under an existing name).

## Center-pixel contract — updated DELIBERATELY

Old contract: tile center navy for every non-bin icon; white = empty bin.
New contract (documented at `draw_icon_glyph`): **center NAVY = launches
or opens a container** — programs (solid block), folders (tab+body), the
FULL bin — **center WHITE = any data-file glyph or the empty bin**.

Exec/dir/bin glyph pixels are byte-identical to pre-#82, so every existing
probe passes unmodified: os-shell.mjs (doom navy center, Presentations tab
notch), test_wm_service_e2e (cell-0 histogram, calc block + link notch),
test_recycle_e2e/os-recycle.mjs (basket rim/center flips), ctxmenu's
zzz.txt white-tile histogram (the lined-page glyph leaves ~490 white px
against a >250 threshold). Only non-runnable files changed appearance.

## Test

New `tests/kernel/test_desk_icons_e2e.js` (registered in run.js): seeds one
file per kind on /root/Desktop, shots the desktop layer, probes 4 signature
pixels per glyph (26 checks) — exec/text/generic/image/deck/dir/bin all
mutually distinguishable. Sync note: the desktop re-read is the coarse 1s
tick with no marker, so the test uses the annotated `sleep 2` settle (the
openwith-e2e precedent, allowed by the 0171 rules).

## Gate

Image v127 (`--packages=all` bake). Kernel suite 93/93, browser sweep
31/31, flake gate green (tripwire set + the new e2e 3× under load, 0%).
compiler.js untouched. `.icons` persistence, selection, rename, drag paths
untouched (their suites all re-ran green).

Phase 2 (real bitmap icons) deliberately not taken — that's todos/0157
(deferred), whose baseline note now points here.
