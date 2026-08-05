# #423 — WMP screen-path keyboard verb (INJECT_WMKEY, `wmctl skey`)

Real keyboard **chord traversal** through the WM was the last WM test class
that required a Chromium: per-window `WMP_INJECT_KEY` (0x20) delivers straight
to one window and bypasses `kernel.wmKey` by design, so the grab table —
Alt+Tab, Ctrl+Esc, Win+arrow, wm.c user grabs — was unreachable headlessly.
The pointer half of this problem was solved by todos/0095's
`WMP_INJECT_SCREEN` (0x22); this is the keyboard analogue.

## What landed

- `WMP_INJECT_WMKEY = 0x23` `{down, scancode, keysym, mod, repeat}`: feeds
  `kernel.wmKey` — the same entry `os/compositor.js` feeds from browser key
  events. Always replies R_OK (the 0x22 rule: wmKey always reports what
  happened via events/delivery; the reply is a sequencing barrier).
- `wmctl skey|skeydown|skeyup SCANCODE [KEYSYM [MOD]]` — sid-less, beside
  `sdown/smove/sup`; argument shape mirrors the existing `key/keydown/keyup`
  trio, edge selection reuses its `cmd[N]` idiom.
- Idle-clock semantics follow the 0096 rule: INJECT_WMKEY enters wmKey so it
  stamps `_wmLastInput` (real input), per-window injection still doesn't.

## Design calls (and the roads not taken)

- **New verb names over a `--screen` flag on `wmctl key`**: 0095 chose new
  names for the screen path; the two paths are deliberately NOT
  interchangeable, and a flag would imply they are.
- **`INJECT_WMKEY`, not `INJECT_SCREEN_KEY`**: 0x22 is named for its
  coordinate space; keys have none. This op is named for its entry point.
  Calling it "screen" would claim a property the op doesn't have (the API
  honesty rule).
- **`repeat` rides the wire even though wmctl doesn't expose it**: it is part
  of wmKey's surface (EV_HOTKEY bit1, repeat re-fires grabs) and the protocol
  op should cover the whole entry; scripted WMP clients drive it directly
  (test_wm_policy pins the pass-through).

## Tests (red-then-green, #97 standard)

Red control `16e7e135` (tests only, product files untouched): both fail loud —
the opcode answers ENOSYS, `wmctl skey` hits usage() and the startmenu wait
times out via driveBoot's 0171 gate. Fix `cca97727` turns both green.

- `test_wm_policy.js` new legs: chord → EV_MENU + both-edge swallow (app ring
  empty), unmatched key → focused-window delivery with the repeat flag,
  **the INJECT_KEY bypass twin pinned** (same chord bytes, raw pair to the
  app, no EV_MENU), idle-clock stamp vs per-window non-stamp (backdated
  clock, no tight timing).
- `test_skey_e2e.js` (new, registry 165→166): real /bin/wm + wmctl through
  os/boot.js — Ctrl+Esc `skey 41 27 64` opens the Start menu, toggles away;
  `skeydown`/`skeyup` single edges; Alt+Tab `skey 43 9 256` cycles focus
  between two real windows. The bypass control (`wmctl key` with the same
  chord bytes) runs FIRST, so a regression routing INJECT_KEY through wmKey
  inverts the toggle sequence and fails the startmenu wait — no nap, no
  expected-timeout wait.

`os/keys.h` untouched — the #404 serialisation constraint never activated
(this is a pass-through of raw key words; including keys.h ≠ editing it).
