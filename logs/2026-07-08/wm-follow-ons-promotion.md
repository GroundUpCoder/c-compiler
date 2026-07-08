# Promoting the WM.md screen/scaling follow-ons (0023–0025)

The three unpromoted blocks of WM.md's "Screen, VTs, and scaling
fixed-size clients" section became numbered queue items today: **0023**
dynamic screen resolution, **0024** scaling fixed-size clients, **0025**
maximize. This entry records the sequencing rationale and the design
decisions sharpened during the promotion discussion (the blocks
themselves stay in WM.md; the items are thin, per queue convention).

## Order of attack: 0023 → 0024 → 0025

- **0023 first** because it's independent, mostly-existing mechanism
  (`wmSetScreen` is already re-callable; the compositor reads
  `canvas.width/height` every frame — the gaps are just the resize event
  chain and that /bin/wm learns dims once, in the SUBSCRIBE reply), and
  it unlocks the visible payoff: a full-viewport desktop on VT2. It also
  makes "work area" meaningful for maximize on a screen that isn't
  800×500.
- **0024 second** — the mechanism-heavy one, and DOOM-fills-the-screen
  is much better a demo on a full-viewport screen. Assessed as *less*
  fiddly than 0019's resize (no buffer renegotiation, no in-flight-frame
  races — the state is one pair of ints, dstW/dstH); the cost is
  coverage, not depth: hit-test, chrome, both composites, and the input
  inverse-map must agree pixel-for-click.
- **0025 last** — by then it's nearly pure /bin/wm policy. The only new
  kernel mechanism is the gesture (double-click-on-title → WMP event;
  title clicks are consumed by kernel chrome, so only the kernel can see
  the gesture — mechanism in kernel, policy in WM, as always). Both
  branches dispatch on 0021's resizable flag: configure-to-work-area for
  resizable windows, 0024's letterboxed SET_DST for fixed-size ones —
  the WM.md observation that maximize and scaling "pair naturally with
  0021" held up.

Estimates: ~1 session + 1–2 sessions + ~½–1 session ≈ 3–4 total. None
touch the compiler, BlockFS, or pty surface area; image bumps only for
seeded wm.c/wmctl.c changes.

## Decisions captured in the items (so they don't get re-decided)

- **DPR**: 1 CSS px = 1 screen px for 0023 — devicePixelRatio support
  would put a scale factor on every coordinate path; not worth it yet.
  The os.html natural-size-canvas invariant (event offsets == screen
  coords) survives by resizing the canvas's *natural* size, never CSS.
- **Shrink policy**: clamp title bars reachable, don't re-cascade
  (placement churn is user-hostile; Windows clamps on display change, X
  WMs mostly don't even do that). Kernel does a minimal clamp too so the
  no-WM fallback stays usable.
- **Taskbar re-lay**: destroy + recreate the bar window — there is no
  client-initiated resize (0019 made resize kernel-initiated;
  deliberate), and inventing SDL_SetWindowSize for one consumer isn't
  worth it.
- **Injection coordinate space** (0024): `wmInjectPointer`/WMP INJECT
  stay in buffer coords, post-hit-test — headless tests remain
  resolution-independent regardless of dst rect.
- **Scaled-drag mechanism/policy split** (0024): kernel re-enables the
  rubber band on non-resizable surfaces but at release emits the request
  to the WM; wm answers with an aspect-preserving letterboxed SET_DST
  (SURFACE_CONFIGURE never sent). No-WM fallback applies the raw dst.
- **Compositor scaling path** (0024): the shm ImageData cache becomes a
  per-surface scratch OffscreenCanvas + `drawImage` src→dst with
  `imageSmoothingEnabled=false` — putImageData can't scale, and nearest
  is what pixel-art wants anyway (integer-snap nicety for gameboy).

## Real-OS precedents leaned on

RandR / `wl_output` events for 0023 (display server owns the mode,
everyone gets an event); `wp_viewport` + DWM DPI virtualization + SDL3
logical presentation for 0024 (X11's lack of an answer here is exactly
the postage-stamp-DOOM problem we have today); EWMH maximized state /
Windows work area / `xdg_toplevel.set_maximized`→configure→ack for 0025
— the Wayland shape maps 1:1 onto 0019's kernel-initiated resize
protocol, which is reassuring about the protocol's design.

Docs touched: the three new items, todos/README.md *Next up*, WM.md
(status bullet, open-questions line, section intro + block headers),
OS.md's WM pillar row (was stale at "Next: 0018 quake, 0019 resize"),
HANDOFF.md queue.
