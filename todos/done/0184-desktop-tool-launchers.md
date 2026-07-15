# 0184 — Desktop launchers for the everyday tools (fileman/calc/paint/ctlpanel)

- **Status**: done (2026-07-15; image.json v93 desktop links — code deliberately left off; log: logs/2026-07-15/desktop-content-0184-0185.md)
- **Design**: —

## Goal

The seeded desktop is games-heavy (doom, quake, gameboy, the three sameboy
scripts) plus term and notepad; the everyday productivity tools — the file
manager, the calculator, paint, the Control Panel — exist as binaries and
Accessories menu entries but not as desktop icons. Give a fresh boot a
genuinely useful default desktop.

## Plan

- `os/image.json` user section grows four `link` entries, the exact shape of
  the existing notepad one:
  - `/root/Desktop/fileman` → `/usr/bin/fileman`
  - `/root/Desktop/calc` → `/usr/bin/calc`
  - `/root/Desktop/paint` → `/usr/bin/paint`
  - `/root/Desktop/ctlpanel` → `/usr/bin/ctlpanel`
- **`code` is deliberately left off** (the "use judgment" carve-out): it is a
  line-oriented tty app (no fullscreen ANSI, no SDL window) that needs
  `ANTHROPIC_API_KEY` from `~/.profile` — a bare `link` launcher would spawn
  it windowless and broken, and even a `term code` wrapper lands on a missing
  API key for a fresh user. It has no menu entry today either; keeping it
  shell-only is consistent.
- All four are GUI apps (win32 veneer), so plain links spawn correctly
  through the shared `activate()`.
- User-section seeding happens ONCE on a fresh root volume, so this rides the
  shared image-version bump with 0185 (one bump covers both).
- Desktop layout consequences: `entcmp` sorts alpha with the Recycle Bin
  pinned to the tail (and dirs first — see 0185), so the new icons interleave
  (calc, ctlpanel, fileman, paint slot between the games). Every test that
  does desktop-grid index math or icon counts against the seeded set needs a
  matching update — that's the shared golden pass with 0185.

## Acceptance

- A fresh boot shows fileman/calc/paint/ctlpanel icons on the desktop;
  double-clicking each launches the app (they are links to wasm binaries, so
  the existing runnable-link path covers them).
- os-shell/wm desktop goldens (icon count/layout) updated and green; the
  kernel e2e suites that touch the seeded desktop stay green.
