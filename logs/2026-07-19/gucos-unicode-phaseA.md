# gucOS Unicode Phase A — VT2 terminal Unicode (kills W1/W2/W5)

Branch `unicode-phaseA`, image v130. First increment of the greenlit
Unicode arc (design: the ITEM B design pass, D1–D5 locked). Phase A =
the VT2 terminal accepts and renders everything the baked face covers
(Latin/Latin-Ext/Greek/Cyrillic), matching VT1. Files: `os/term/term.c`
+ `host.js`. compiler.js untouched (no SameBoy exposure).

## What changed and why

**host.js astral keysym (W5).** `keysym()` only handled `e.key.length
=== 1`, so an astral char from a host IME (one surrogate PAIR, length
2) fell through to a garbage scancode keysym. Now a high-surrogate
2-length key returns `e.key.codePointAt(0)` — the ring's keysym word is
Int32, so code points to U+10FFFF fit without any kernel/ring change.
Benefits every SDL app, not just term.

**term.c input encode (W1).** The old gate `if (sym < 32 || sym > 126)
return;` dropped every non-ASCII keysym. The keysym IS a Unicode code
point (host.js has carried BMP chars this way all along — é arrived as
233 and was thrown away at the last hop). The fall-through now UTF-8
encodes the sym (1–4 bytes, inline ~15-line encoder shared with the
selection re-encode) onto the pty master. Named keys (>= 0x40000000),
the Ctrl fold (ASCII by nature), and Alt-as-ESC-prefix compose
unchanged. The 0149 chord tables are safe: `key_action` is only called
for syms 32..126 and its table holds ASCII keys, so a high sym can
never mis-fire a chord.

**term.c cells + decoder + glyphs (W2).** Three connected moves, all
shapes the tree already proves out in gdi32 (0211):

- `Cell.ch` (one `unsigned char`, high bytes stamped `'?'`) became
  `uint32_t cp`. One code point per cell; cell grows 4→8 bytes (80×24×2
  grids — trivial). The reflow/resize memcpy paths are struct-size
  generic and needed zero changes.
- A **stateful** UTF-8 accumulator in front of ST_GROUND
  (`ground_utf8`): lead byte latches expected-continuation count +
  minimum code point, continuation bytes accumulate, completion
  validates overlong/surrogate/>U+10FFFF → U+FFFD. Malformed input
  (stray continuation, 0xC0/0xC1, 0xF5+, interrupted sequence) becomes
  U+FFFD, with the interrupting byte reprocessed from ground. Stateful
  across `term_putc` calls because pty reads split sequences
  arbitrarily (the drain loop feeds byte-at-a-time). The accumulator is
  consulted only in ST_GROUND — escape sequences are pure ASCII, and
  OSC title bytes pass through raw (still UTF-8, straight into
  `SDL_SetWindowTitle`).
- `glyphs[95]` grew gdi32's two-tier cache: the flat ASCII array stays
  (eagerly rendered at startup, exactly as before), everything else
  lands in a lazily-grown linear-scan side cache (`cp_glyph`, the
  `font_glyph` port). A code point the face lacks renders a synthesized
  **tofu box** (`glyph_tofu` — Roboto Mono's .notdef is EMPTY, so
  rendering glyph 0 would be invisible), never a `'?'` that reads as
  data corruption. Ported rather than adopting gdi32 DCs: term renders
  into its own SDL surface spans with per-cell bg/reverse — the ~40-line
  pattern was the right altitude, DC ceremony was not.

**Selection copy (the W2 tail).** `copy_selection` re-encodes cell code
points to UTF-8 (buffer sized 4×cells worst case). The trailing-blank
trim still compares raw 0x20 bytes — safe, since 0x20 never occurs
inside a multi-byte sequence. Paste was already byte-clean.

## Honest partial state (deliberate, per the locked decisions)

- **Double-width (CJK) → Phase D.** No wcwidth, no width-2 cells: the
  baked face's repertoire is width-1 and CJK isn't installable until the
  Phase D font packages, so CJK renders tofu at (single) width until
  then. Adding width-2 now would be machinery with nothing to display.
- **Combining marks render as their OWN spacing cell (D5)** — visible,
  not composed. Early-xterm behavior, for the whole arc.
- **The baked face stays Roboto Mono.** Phase A is face-agnostic (it
  renders through the glyph cache over whatever is baked); the Noto
  Sans Mono swap is Phase C/D territory.
- **tty ERASE (W3) is Phase B**: backspacing over a multi-byte char in
  canonical mode still pops one byte and echoes a one-cell erase. The
  kernel line discipline was deliberately not touched here.

## Caveats found / documented

- **Dead keys / host IME on VT2**: browsers deliver composed accents
  inconsistently — some as a plain `é` keydown (works via `e.key`, this
  phase), some only via `composition*` events, which nothing captures
  until Phase E (W6). European input via ordinary and AltGr keys works;
  IME-composed input is invisible until the TEXT_INPUT plumbing.
- **Playwright can't type non-US chars as keydowns** (`keyboard.type`
  falls back to `insertText`, which produces no key events). The
  browser leg dispatches synthetic `KeyboardEvent`s at the `#screen`
  canvas — the same listener hardware keys hit — so the whole page →
  host.js keysym (incl. the surrogate-pair path) → ring → term →
  pty pipeline is exercised for real; only the physical-keyboard hop is
  synthesized.
- **Selection drag in tests**: term extends the selection on
  MOUSE_MOTION only — BUTTON_UP does not extend. A `wmctl drag` ends
  its motion at the midpoint, so the e2e uses explicit
  `down`/`hover`/`up` to land the extent on the intended cell.

## Tests

- `tests/kernel/test_term_e2e.js` session U: typed é (2-byte), €
  (3-byte), 😀 (4-byte astral) reach hush as exact UTF-8 bytes
  (file-redirect + system-shell cat); a multi-script stream renders
  real glyphs (fg-pixel growth); CJK 汉 renders a tofu box and
  malformed bytes (FF, stray 80) become U+FFFD; selection-copy of
  `héllo` puts exactly those UTF-8 bytes in the kernel clipboard slot
  (`clip -o`). 8 new checks, all green; old code fails the input leg by
  construction (the ASCII gate literally `return`ed).
- `tests/browser/os-term.mjs`: synthetic-KeyboardEvent leg — é/€/😀
  typed on VT2, byte round-trip proven by a VT1 `cat` (xterm renders
  UTF-8 natively), plus a VT2 glyph-pixel growth check.
- Gate: host pass, blockfs 15/15, kernel 94/94, browser sweep 32/33
  with the one failure (`os-boots` VT1-vi leg — a path this diff does
  not touch) green on two isolated reruns; flake gate on the term files
  3× under load ×10 — stable, 0%.
