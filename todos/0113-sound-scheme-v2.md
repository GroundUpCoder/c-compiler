# 0113 — Sound scheme v2 — preset schemes, per-event applet UI, SND_LOOP

- **Status**: open
- **Design**: `todos/WIN32.md` (the 0094 landing paragraph records v1's
  deliberate cuts), `os/sounds.h` (the ONE policy core — everything here
  extends it, nothing forks it)

## Goal

0094 shipped the event-sound scheme v1: ONE baked scheme, a whole-scheme
mute toggle in the Control Panel Sounds applet, and PlaySound with
SND_LOOP playing once. This item is the residue owner — the polish that
was descoped:

- **Preset schemes**: the 0094 item's applet goal was "pick the scheme /
  mute events"; v1 shipped only mute because exactly one scheme exists.
  Ship a second synthesized set (tools/mksounds.js grows variants, e.g.
  a softer "Utopia-ish" theme) under /usr/share/sounds/<scheme>/, and a
  picker in the Sounds applet (writes ~/.config/sounds with the chosen
  table — the store format already carries it; no new mechanism).
- **Per-event UI**: a LISTBOX of events with per-event enable/Test
  (writes `EVENT<tab>none` lines — the store supports it today, only the
  UI is missing).
- **SND_LOOP**: plays once in v1 (fire-and-forget has no process-side
  refill pump). Options recorded in winmm.c: a refill hook off the
  message loop's idle path (user32 apps only), or kernel-side loop
  support (a `loop` flag on the stream — the mixer re-reads the ring
  instead of consuming). No corpus consumer loops today, so this waits
  for one.
- **More emitters** (the 0094 plan's "optional empty-trash / menu blips
  later"): an EmptyRecycleBin event from fileman/wm.c's empty flows and
  a MenuPopup blip from wm.c's Start/context menus — each is one
  `snd_play_event` call plus a scheme line + clip; keep the set small
  (Win95 restraint, not a per-click noise machine).
- **Aesthetics retune**: whatever the 0064 sound listen (the operator
  human check) finds grating — regenerate + recommit the wavs.

## Plan

Applet first (preset picker + per-event list are pure ctlpanel.c +
sounds.h work), SND_LOOP only when a consumer shows up.

## Acceptance

- Sounds applet lists events; toggling one writes `none` for it and the
  e2e proves the event stays silent while others play.
- A second preset selectable in the applet; `cat ~/.config/sounds` shows
  its table; the chime differs audibly (freq-assert headless).
- SND_LOOP: a looped play keeps the stream queued past 2x the clip
  duration (or the item re-records the cut with a consumer named).
