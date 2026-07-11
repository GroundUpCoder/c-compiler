# 0119 — MagicPoint (mgp) + sent presentation tools, ported onto SDL (no Xlib shim)

- **Status**: open (META — multi-round; sent is the small first port, mgp the payoff)
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

## Decision: patch the apps to SDL, do NOT build an Xlib shim

**Settled (2026-07-11).** sent/mgp use only the *gentle* Xlib subset —
one window, one GC, text/rect/image drawing, KeyPress/Expose/Configure.
NONE of the hairy Xlib that a real toolkit needs: no selections, no
atoms/properties, no ICCCM WM handshake, no Xrm resource database, no
Xt. Their whole display vocabulary maps 1:1 onto SDL: `XOpenDisplay`/
`XCreateSimpleWindow` → `SDL_CreateWindow`; the GC draw calls → freetype
text (already have it) + rects into the `SDL_Surface`; `XftDraw*` →
freetype (Xft is client-side freetype anyway — see 0117-adjacent notes /
WIN32.md font discussion); images → libpng; `XNextEvent`/Expose →
`SDL_PollEvent` + a first paint on map.

So we **patch each app's display layer to call SDL directly** rather than
building a mini-Xlib veneer. Rationale (the fork-vs-shim call):

- A shim keeps the app pristine but is a THIRD GUI surface (SDL, Win32,
  Xlib) to build+maintain, justified ONLY by an ongoing raw-Xlib/suckless
  corpus we don't have.
- Patching forks the app (we carry a diff), but for 1–2 apps that is far
  less total work than a veneer — and the diff is small because the X
  usage is small.
- Broader principle (see WIN32.md / TOOLKIT.md): **Win32 owns widget
  apps; SDL owns raw-canvas apps.** Xlib as an API buys only
  source-compatibility, no capability the other two lack, so we don't
  carry it.

If a genuine suckless/Xlib CORPUS ever materializes (st, dmenu, tabbed,
xeyes… enough that per-app patching hurts), revisit and build the
`os/xlib/` veneer then — but not for this item.

## Plan (rounds)

**Round 1 — sent on SDL.** Vendor sent (or a minimal fork), swap its
Xlib/Xft/drw calls for SDL + freetype + libpng; seed `/bin/sent` + an
Accessories/Demos menu entry + a slide-file association. Fullscreen
present via the borderless surface path; keys next/prev/quit. This is
the small proof that the "patch X→SDL" recipe works.

**Round 2 — MagicPoint on SDL.** Vendor mgp (`vendor/magicpoint/bin.json`,
pin commit + patch table in a README), applying the same X→SDL patch at
larger scale: `.mgp` parser, multi-size/color text via freetype, images
(libpng; farbfeld/its converters swapped out), backgrounds, alignment/
indent. Seed `/bin/mgp` + `.mgp` openwith association → `/bin/mgp`, a
Demos deck under `/root` (or `/usr/share`), Accessories menu entry.

**Round 3+ (reassess).** Optional: a shared JSON slide model so a future
(bespoke, Win32) WYSIWYG editor and the mgp renderer agree on-disk.
Revisit the Xlib-veneer question ONLY if a real Xlib corpus appears.

## Acceptance

- R1: `sent deck.txt` opens fullscreen, arrows page through, q quits;
  `tests/browser/os-*.mjs` leg (canvas pixels on VT2, like os-doom).
- R2: `mgp sample.mgp` renders a multi-directive deck (sizes/colors/an
  image/a background); `.mgp` double-click launches it via openwith.
- Image version bumped; per-vendor README with upstream commit + patches;
  CLAUDE.md vendored-projects list updated.
