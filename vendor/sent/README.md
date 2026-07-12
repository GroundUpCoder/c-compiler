# sent — suckless presentation tool, on SDL (todos/0119)

Upstream: https://git.suckless.org/sent @ `882d54c225b83c762acf5bb3967f4890c3ecef86`
(2023-01-10, post-1.0). License: ISC (see `LICENSE`).

One paragraph per slide, plain-text decks (`.sent` in the openwith table);
`@file` first line makes an image slide. Seeded as `/bin/sent` with the demo
deck at `/usr/share/sent/demo.sent` (Start menu ▸ Demos ▸ slides).

## The port

Round 1 of the 0119 "patch X→SDL, no Xlib shim" recipe: the display layer is
patched to SDL directly, everything else is upstream.

| file | status |
|---|---|
| `LICENSE`, `arg.h`, `util.c`, `util.h` | verbatim upstream |
| `nyan.png`, `transparent_test.ff` | verbatim upstream (demo images) |
| `sent.c` | patched: Xlib window/event code → SDL window + `__setAnimationFrameFunc` frame loop; XImage scale/draw → RGBA buffers into the window surface; the fork+regex *filter → farbfeld* image pipeline → native loaders (libpng simplified API for `.png`, direct read for `.ff`), alpha blended against the configured background like upstream |
| `drw.c`, `drw.h` | rewritten over SDL + freetype2: one shared face (`/etc/fonts/mono.ttf`, fallback `/usr/share/fonts/mono.ttf`), a `Fnt` is a pixel size, UTF-8 decoded per glyph, alpha-blended into the surface. API shape kept so `sent.c`'s layout logic is untouched |
| `config.h` | from `config.def.h`: font paths instead of fontconfig names, SDL keycodes instead of `XK_*`, filters table dropped, `INIT_WIDTH/HEIGHT` 800×500 |
| `demo.sent` | ours (the seeded demo deck) |

Deliberate deviations:

- **Resizable window, not fullscreen-borderless.** There is no display-size
  query or fullscreen protocol in this world; a borderless window would have
  no chrome to move/close. The WM's maximize (double-click the title) is the
  "present" mode; slides re-fit on every resize.
- **Images are `.png`/`.ff` only** — the upstream design shells out to
  per-format `2ff` converters, which don't exist here.
- Upstream's `LEN(a) = sizeof(a) / sizeof(a)[0]` idiom exposed a compiler
  parse bug (`sizeof (expr)` losing postfix binding) — fixed in compiler.js,
  regression test `tests/unit/conformance/parse_sizeof_postfix/`.

Tests: `tests/kernel/test_present_e2e.js` (headless pixels via `wmctl shot`),
`tests/browser/os-present.mjs` (compositor pixels).
