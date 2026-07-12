# 0119 — sent + MagicPoint on SDL (the presentation tools)

Both rounds of todos/0119 landed in one pass: **suckless sent** (round 1,
the small proof) and **MagicPoint 1.13a** (round 2, the payoff), each with
its display layer ported Xlib→SDL per the item's settled fork-over-shim
decision. Seeded as `/bin/sent` + `/bin/mgp` with demo decks, Demos menu
entries, and `.sent`/`.mgp` openwith associations. Image **v80**.

## Shape of the two ports

**sent** (`vendor/sent`, upstream @882d54c): ~700-line app, so the patch is
direct — `sent.c`'s X window/event code became SDL + the
`__setAnimationFrameFunc` frame loop, and `drw.c` was rewritten over
freetype2 (one face, a `Fnt` = a pixel size, UTF-8 decode, alpha blend into
the window surface) keeping the drw API so layout logic is untouched. The
upstream fork+`2ff`-filter farbfeld image pipeline became native loaders:
libpng's simplified API for `.png`, direct read for `.ff`.

**mgp** (`vendor/magicpoint`, upstream 1.13a tarball): the X vocabulary is
~40 calls across draw.c/mgp.c, so the fork centralizes it in **sdlx.h/c** —
Drawables are `0x00RRGGBB` canvases, `XFlush` converts+presents the window
canvas, events pump SDL→`XEvent` (window-close = synthetic `q`), colors are
truecolor bit-packs + a 140-name X11 color table. That file is PART OF THE
FORK, not an os/ veneer — the 0119 decision stands; it's just how a
5.7-kline draw.c is patched without rewriting every call site. Beyond it:

- **tfont.c rewritten FreeType 1 → 2** (upstream used the `TT_*` API with
  5-level gray pixmaps + a color ramp; now 8-bit coverage alpha-blended
  over the prefilled line image). Cache/struct/API kept.
- **The blocking main loop became a frame callback**: `draw_one()` grew a
  third return ("would block") replacing its select()-on-X-fd tail;
  `main_loop` seeds state and registers `frame_loop`; the per-event switch
  moved to `handle_xevent` with `goto reload/repaint` folded into
  functions. The old 2s idle tick (timebar, auto-reload) runs off
  `time(NULL)` checks in the would-block branch.
- **Descopes** (all recorded in the vendor README): X-server fonts, the
  page-list/guide UI (plist.c stubbed), `%system`/`%filter`/EPS/ghostscript,
  GIF/JPEG loaders, JIS/charset16, Xft/m17n/VFlib, html dump. Freetype is
  the only text engine; `freetypefont0` defaults to the baked mono.ttf so
  bare decks render.
- **Generated files committed**: `grammar.c`/`scanner.c`/`tokdefs.h`
  (bison/flex, `-l`/`-L` no-#line) and `ctlwords.h` — the directive parser
  is flex/bison, and we don't want those tools in the bake path.

## Compiler work the port forced

1. **`sizeof (expr)` lost postfix binding** — `sizeof(a)[0]`
   (= `sizeof((a)[0])`, the suckless `LEN` idiom) was a parse error. Fixed
   in compiler.js (parsePostfixTail after the parenthesized operand),
   test-first: `tests/unit/conformance/parse_sizeof_postfix/`.
2. **Implicit function decl across TUs → codegen ICE** ("emitExpr: function
   'yylex' not found"): links fine, then crashes. Worked around with an
   explicit extern in generated grammar.c; filed as **todos/0158** (P0).
3. **Unprototyped-call ABI holes → invalid wasm**: K&R `float` params
   (which are doubles after default promotion), empty-parens function
   POINTER calls with args, unprototyped externs — three flavors, all
   "emitted invalid WebAssembly" ICEs. Worked around by ANSI-fying
   `zoom()`/`gammacorrect()` (double + real prototypes) and prototyping
   `imagetypes.c`'s loader table; filed as **todos/0159** (P0).

## Gotchas for the next porter

- Standard C, easy to forget: a block comment ends at the FIRST `*/`, so
  header prose like `init_win*/get_color` truncates the comment and yields
  bizarre downstream errors ("invalid numeric literal"). Grep your prose.
- BSD `u_int`/`u_char` aren't in this libc's sys/types.h; sdlx.h typedefs
  them for the whole fork.
- libpng 1.6 renames vs 1.2-era code: `png_ptr->jmpbuf` → `png_jmpbuf()`,
  `png_set_gray_1_2_4_to_8` → `png_set_expand_gray_1_2_4_to_8`.
- `wmctl wait win <title>` + parsing `wmctl list` GEOMETRY beats hardcoding
  cascade positions in browser legs (second windows don't land at 12,36).

## Verification

- `tests/kernel/test_present_e2e.js` — 15 checks: window lifecycle for
  both, sent white-bg + glyph ink, mgp MidnightBlue `%default` bg + white
  glyphs + the green `%tab` box icons, paging on space, clean `q` quits.
- `tests/browser/os-present.mjs` — same content through the real
  compositor (PASS).
- Full unit/blockfs/projects/kernel suites re-run (compiler.js changed).
