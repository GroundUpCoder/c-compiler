# 0119 — MagicPoint (mgp) presentation tool over a mini-Xlib veneer (sent = shim round)

- **Status**: open (META — multi-round; sent proves the shim, mgp is the payoff)
- **Design**: this file. Toolkit context: `todos/WIN32.md` (Win32 is the
  primary *widget* toolkit; this is deliberately a **canvas** app, like
  doom/quake — no HWND tree, no by-label agent-drivability needed for a
  slideshow). Port-over-build preference drives target choice.

## Goal

We want a presentation tool, and the port-over-build preference rules out
writing a PowerPoint clone from scratch (no good simple-C GUI presentation
app exists — the famous ones, Harvard Graphics / Lotus Freelance / Aldus
Persuasion, are closed-source DOS/Win binaries, emulate-only). The open,
portable, text-data-format, C answer is the Unix/academic lineage:

- **sent** (suckless, ~600 LOC, raw Xlib + Xft): one paragraph per slide.
  Tiny — the perfect app to *prove the mini-Xlib shim*.
- **MagicPoint / `mgp`** (WIDE project, ~1997, X11/Xlib, C, free/BSD-ish):
  one tier up — font sizes, colors, per-page backgrounds, images,
  alignment/indent levels, a documented `%`-directive **plain-text**
  slide format (`.mgp`). Text data = trivial to generate/manipulate
  programmatically (an agent-driven OS can *author* decks by emitting
  `.mgp`), and it's historically the Unix way to give a talk.

Both are raw Xlib/C, so they share ONE substrate. `.pptx` interop is a
recorded non-goal (OOXML tar pit) — our on-disk format is the `.mgp` text
(and/or a JSON slide model a future editor could share).

## Key decision (settle in Round 1)

**mini-Xlib veneer vs. render-over-SDL.** sent/mgp are raw Xlib + Xft +
images with ZERO widgets, so a ~20–40-function **Xlib shim** over the
existing kernel surfaces + input ring + freetype path covers them (the
async/socket model collapses to synchronous local calls: `XFlush`→present,
`XNextEvent`→drain the ring, reply-calls answer from local state; hardcode
one TrueColor visual, implement `Xft`, skip colormaps/core server fonts;
synthesize `Expose` on map/resize since our compositor already retains
buffers). gucOS's kernel is already X-server-shaped (owner brokers
surfaces, clients draw into shared buffers), so the shim is a natural fit.

BUT a shim is a THIRD GUI surface (SDL, Win32, Xlib) — justified only by
**appetite for a suckless/Xlib corpus** (st, dmenu, tabbed, xcalc,
xeyes…). If mgp is the only Xlib app we'll ever want, porting its render
loop directly over SDL (already present) is less total setup. **Round 1
picks a lane**; if we build the shim, it lands as `os/xlib/` lib.json
(the user32/gdi32 precedent) and sent is its acceptance app.

## Plan (rounds)

**Round 1 — the substrate + sent.** Decide shim-vs-SDL. If shim: bring up
the mini-Xlib veneer (`os/xlib/`), port **sent** as the acceptance app,
seed `/bin/sent` + an Accessories/Demos menu entry + a slide-file
association. Fullscreen present via the borderless surface path; keys
next/prev/quit.

**Round 2 — MagicPoint.** Vendor mgp (`vendor/magicpoint/bin.json`, pin
commit + patch table in a README), port over the shim: `.mgp` parser,
multi-size/color text via freetype, images (reuse libpng; farbfeld/its
converters swapped out), backgrounds, alignment/indent. Seed
`/bin/mgp` + `.mgp` openwith association → `/bin/mgp`, a Demos deck under
`/root` (or `/usr/share`), Accessories menu entry.

**Round 3+ (reassess) — corpus + polish.** If the shim earned its keep,
add more suckless/Xlib apps as demand appears. Optional: a shared JSON
slide model so a future (bespoke, Win32) WYSIWYG editor and the mgp
renderer agree on-disk.

## Acceptance

- R1: `sent deck.txt` opens fullscreen, arrows page through, q quits;
  `tests/browser/os-*.mjs` leg (canvas pixels on VT2, like os-doom).
- R2: `mgp sample.mgp` renders a multi-directive deck (sizes/colors/an
  image/a background); `.mgp` double-click launches it via openwith.
- Image version bumped; per-vendor README with upstream commit + patches;
  CLAUDE.md vendored-projects list updated.
