# CS3: per-key three-layer config overlay (todos/0244) — stop forking users from future baked defaults

## The defect

openwith.h, saver.h and sounds.h all implemented the same rule, copy-pasted
"verbatim" (their own comments said so): three store layers
(`~/.config/X` > `/etc/X` > `/usr/share/X`), **first existing file wins,
whole file**, and every `*_set` rewrote the merged *effective* table into
the user file. The carry-forward write was the original 0072 attempt to
soften the whole-file rule — and it's exactly what made the bug compound:
the first user customization snapshots that release's baked table into
`~/.config`, and from then on the /etc and /usr/share layers are dead for
that user. A v113 image adding `pdf → /bin/viewer` to the baked openwith
seed would never reach anyone who had ever ticked "Always" in the fileman
picker or toggled the Sounds checkbox.

## The mechanism (os/cfgstore.h)

One shared header, three thin wrappers — the stores were already
line-for-line identical, so the honest factoring was extraction, not
another copy:

- **Load = precedence-order concat.** `cfg_load3` concatenates the
  EXISTING layers user-first ('\n'-separated). The `*_find` functions are
  line-oriented and return the FIRST matching line, so first-match over
  the concat *is* per-key precedence — no table parse, no new data
  structure, and duplicate keys within one layer keep their old
  first-line-wins meaning. A layer that doesn't fit the remaining buffer
  truncates at a LINE boundary (a partial line could return a truncated
  value for a valid key); `CFG_STORE_MAX` is 8192 (three layers of
  few-hundred-byte files — the truncation is the general backstop, not
  the plan).
- **Set = delta-write.** `cfg_set` reads ONLY the user file, replaces or
  appends the one key, tmp+renames back. `ow_set`, `sv_set` and
  `snd_set_mute` are now one-liners over it. Existing pre-CS3 snapshot
  user files stay valid — their lines simply shadow identical baked ones.
- Preserved semantics, verified per consumer: '#' comments,
  case-insensitive keys, `default.gui`/`default.term` fallthrough,
  sounds' "no store at all = silent -1" (cfg_load3 returns 0 only when NO
  layer exists — same observable), the `mute`/`none` reserved values
  (per-key precedence means the user's `mute off` now correctly overrides
  an admin `mute on`, which the whole-file rule got right only by
  accident of the snapshot).

## Red→green

Pre-fix (os/ stashed at 737c936), post-fix identical test files:

- `test_sounds_e2e` P15: user store holding ONLY one override key →
  `PlaySoundA("SystemStart", SND_ALIAS|SND_NODEFAULT)` returns **0**
  pre-fix (baked alias invisible), **1** + a live 22050 stream post-fix.
  P17: the user's `SystemQuestion → c.wav` beats the baked `none` (11025
  plays) — override-wins.
- `test_openwith_e2e`: pre-fix `~/.config/openwith` after `open --set`
  contains the full baked snapshot (gb/gbc/default.gui lines) and an
  /etc-only key resolves to the USER default.term probe (`opened:`) —
  post-fix the user file is a pure two-line delta and `/etc/openwith`'s
  key fires its own probe (`openedB:`). The existing probe2 leg doubles
  as override-wins (user default.term shadows baked `vi`); the fileman
  `.gb → SameBoy` + picker-prefill legs now run against a delta user file,
  proving the /usr/share layer reaches a customized user.
- `test_ctlpanel_e2e`: mute toggle writes ONLY `mute on` (pre-fix: the
  whole baked table).
- `test_saver_e2e`: sv_set preserves the OTHER user key (delta keeps
  genuine user overrides, drops nothing).

## Surfaced, not absorbed

The scan's fourth member — wm.c `menu_toggle`'s `/etc/menu` vs
`/usr/share/menu` first-existing-DIR — is a directory-entry union (a
different shape) inside menu code with a pending kernel-anchored-subsurface
redesign; sequenced with that redesign, recorded as the open follow-up in
todos/0244. todos/0130 (Default Programs applet) was written against the
whole-file model; amended in place (`ow_each` must dedup over the merge;
"Remove" reverts to lower layers under the delta model).

Image v111 → v112. compiler.js untouched.
