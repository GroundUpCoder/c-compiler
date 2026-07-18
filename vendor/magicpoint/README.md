# MagicPoint (mgp) 1.13a — on SDL (todos/0119)

Upstream: `magicpoint-1.13a.tar.gz` (WIDE Project, 2008-02-14), fetched from
the NetBSD pkgsrc distfiles mirror
(`http://ftp.netbsd.org/pub/pkgsrc/distfiles/magicpoint-1.13a.tar.gz`,
sha256 `205e6752e3cb024bcce0583b43dafc9b89490c0016daa91d2486891edcf2cfc1`).
License: BSD-style (see `COPYRIGHT`).

The classic Unix presentation tool: plain-text `.mgp` decks with
`%`-directives (`SYNTAX` documents the format). Ships as the `mgp` gucman
package (binary + decks under the package's `share/`; `/opt/mgp` installed,
`/usr/opt/mgp` on a fat `--packages=all` bake) with a demo deck launcher
(Start menu ▸ Demos ▸ mgp); `.mgp` files open with it via the openwith
table. Decks reference `demo.gif` relative to `share/` — the menu launchers
run mgp from there.

## The port (round 2 of the 0119 X→SDL recipe)

mgp's display vocabulary is bigger than sent's, so the fork centralizes it:
**`sdlx.h` + `sdlx.c`** implement exactly the Xlib subset mgp speaks, over
one SDL window — every `Drawable` is a `0x00RRGGBB` canvas, `XFlush`
converts the window canvas into the SDL surface and presents, and the
`XNextEvent` family pumps SDL events into a small `XEvent` queue (SDL
keycodes → `XK_*`; window-close arrives as a synthetic `q`). This is NOT an
`os/` Xlib veneer — it is one file of this fork, sized to this app (the
0119 fork-vs-shim decision).

| file | status |
|---|---|
| `COPYRIGHT*`, `SYNTAX`, `sample/` | verbatim upstream (docs + two sample decks) |
| `parse.c` | patched: `%filter` fork/exec pipeline → always-skip (no fork/execvp here); `lex_init`/`yyparse` externs un-GNUC-gated; `lex_init` decl matches the scanner (`char *`) |
| `grammar.c`, `scanner.c`, `tokdefs.h`, `ctlwords.h` | GENERATED (committed): `bison -y -d -l grammar.y`, `flex -L -t scanner.l`, `ctlwords.awk` over `globals.c`. `grammar.c` gets one added `extern int yylex(void);` (an implicit decl crossing TUs trips a compiler bug — see todo filed with 0119) |
| `mgp.c` | patched: the blocking `XNextEvent`+`select` main loop → a frame callback (`main_loop` seeds state and registers `frame_loop`; `handle_xevent` is upstream's per-event switch with `goto reload/repaint` → `fl_reload()/fl_repaint()`); no `setpgid`/`kill(0, SIGTERM)`; `-D` html dump disabled (needs external converters); `freetypefont0` defaults to the baked `/usr/share/fonts/mono.ttf` so any deck renders |
| `draw.c` | patched: `draw_one()` returns 2 ("would block") instead of select()ing; `%system/%xsystem/%tsystem`, EPS/ghostscript (`image_load_ps`/`epstoimage`) and the X-server-font path (`x_fontname/x_parsefont/x_setfont/draw_onechar_x`) stubbed — freetype is the only text engine |
| `tfont.c` | rewritten on FreeType **2** (upstream used the FreeType 1 `TT_*` API): same `struct tfont` + hash/LRU cache, but `dbitmap` is 8-bit coverage and `tfc_image()` alpha-blends over the prefilled line image (the old 5-level color ramp is gone). Latin-1 + latin2-4 remaps kept; charset16 (JIS) not built |
| `plist.c` | stubbed: the page-list popup / page-guide need per-page X child windows + X server fonts. Navigation keys cover it |
| `x11.c` | not vendored — replaced by `sdlx.c` (init/teardown/colors/gcs) |
| `background.c`, `postscript.c`, `unimap.c`, `globals.c`, `embed.c` | verbatim upstream (compile as-is over sdlx) |
| `mgp.h` | patched: X11 includes → `sdlx.h`; FreeType 1 header dropped; `strings.h`/`getopt.h` added |
| `missing/strsep.c` | verbatim upstream (this libc has no strsep) |
| `sdlx.h`, `sdlx.c` | ours: the X-vocabulary backend described above, plus truecolor replacements for xloadimage's `send.c` (`imageToXImage`/`freeXImage`/`ximageToPixmap`) and an X11 color-name table (140 names + `grayNN`) |
| `demo.mgp` | ours (the seeded demo deck) |
| `decks/*.mgp` | ours (todos/0185): the showcase decks — text/colors/align/bullets/images/backgrounds/effects, one capability slice each, shipped in the mgp package's `share/` (the present-e2e page-through pins them) |
| `decks/tutorial/NN-*.mgp` | ours (todos/0202): the learn-mgp TUTORIAL series, ten numbered decks (welcome → first deck → text → color → alignment → lists → images → backgrounds → builds → mastery) teaching only directives this port renders. Shipped in the mgp package's `share/tutorial/` (masters, launched by Start ▸ Demos ▸ learn-mgp) AND as writable COPIES in `/root/Desktop/Presentations/MagicPoint Tutorial/` (their own subfolder since todos/0221) — the decks teach a right-click-Edit → ctrl-r reload loop, which needs rw files (a /usr deck opens read-only in notepad and saves fail EROFS, honestly). `SYNTAX` ships as the package's `share/SYNTAX`, the upstream reference the last deck points at. Line-width budgets: tab-1 at size 4 fits ~50 chars, size 5 only ~42 (mgp folds overflow to column 0, no hanging indent); `\%` escapes are LINE-START ONLY — mid-line it is "unknown escape sequence" and mgp exits (bare `%` is fine mid-line) |
| `decks/talks/posix-on-wasm.mgp` | ours (todos/0221): "POSIX on WebAssembly (or: what is an OS anyway?)" — a real gucOS talk deck (what an OS does; the DO / DON'T / DON'T-NEED-TO split; emulation trade-off; prior art), tutorial house style, supported directives only. Master ships as the package's `share/talks/`, rw copy in `/root/Desktop/Presentations/POSIX on WebAssembly/` (the 0202 masters+copies rule); page-through pinned by present-e2e's TALKS list |

### image/ (the xloadimage-derived loader library)

Kept loaders: **PNG** (against vendored libpng 1.6 — `png_jmpbuf`,
`png_set_expand_gray_1_2_4_to_8` renames applied), **GIF** (static; `image/
gif.c` wraps the vendored giflib 5.2 decoder at `../giflib`, `-DUSE_GIF` —
first frame decoded, palette→RGB into a `newTrueImage`; multi-frame/
transparency/canvas-offset out of scope, an animated GIF shows its first
frame as a still), **PBM/PGM/PPM**, **XBM**, **XPM**, plus the zoom/rotate/
clip/bright/reduce/dither/halftone/compress/smooth transforms. Dropped:
JPEG, RLE, XWD, PCX and friends (files not vendored; `imagetypes.c`'s table
is trimmed to match). `zio.c` compressed-file support is off (`NO_UNCOMPRESS`);
`misc.c`'s X-server info dump and `XErrorEvent` handler are gone;
`make_gamma` is inlined into `bright.c` (its only consumer — the Utah RLE
lib stayed behind). `zoom()`/`gammacorrect()` take `double` with a real
prototype in `image.h` — K&R float params after default promotion ARE
doubles, and unprototyped float calls emitted invalid wasm (compiler bug
filed with 0119; same for `imagetypes.c`'s function-pointer table, which now
has real prototypes).

### What a deck can't do in this port (recorded descopes)

`%system/%xsystem/%tsystem` (fork X clients), `%filter`, `%embed` (works
only if a `uudecode` binary exists — none is seeded), EPS images, JPEG
images, animation (MNG, and multi-frame/animated GIF — the first frame
renders as a still), Xft/m17n/VFlib engines, 2-octet charsets (JIS),
UTF-8 text (upstream mgp is byte-oriented Latin-1 — as upstream), the
page-list/page-guide UI, html dump (`-D`), `xwintoppm` screendumps.
The forward cache (`-F`) draws into pixmaps and works; its idle-time
pre-caching runs on the 2s tick.

Tests: `tests/kernel/test_present_e2e.js` (headless pixels via `wmctl
shot`), `tests/browser/os-present.mjs` (compositor pixels).
