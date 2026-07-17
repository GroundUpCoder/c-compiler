# 0244 — per-key three-layer config overlay (openwith / saver / sounds)

- **Status**: open
- **Design**: arch-debt scan CS3

## Goal

The three text config stores (os/openwith.h, os/saver.h, os/sounds.h) all
implemented "first existing file wins, WHOLE FILE, no per-key merge" across
their three layers (`~/.config/X` > `/etc/X` > `/usr/share/X`), and every
`*_set` snapshotted the merged effective table into the user file. Once a
user wrote ANY customization, the admin and baked layers were never
consulted again — no future image could add a new association, screensaver
default, or sound mapping for that user. Compounds with every release.

Fix the whole class generally:

1. **Load = per-key overlay.** A key's value comes from the
   highest-precedence layer that defines it. Mechanism: concatenate the
   existing layers in precedence order; the line-oriented `*_find`
   first-match then yields per-key precedence for free.
2. **Set = delta-write.** `*_set`/`snd_set_mute` read ONLY the user-layer
   file, replace/add just the changed key, tmp+rename back. The user file
   holds nothing but genuine user overrides.

One shared header (`os/cfgstore.h` — `cfg_load3`/`cfg_find`/`cfg_set`),
with the three stores as thin wrappers; consumer call shapes unchanged
(the headers are shared by textual inclusion: wm.c, fileman.c, open.c,
ctlpanel.c, winmm.c).

## Plan

- os/cfgstore.h: `cfg_home`/`cfg_user_path`, `cfg_load3` (precedence-order
  concat, '\n' separators, per-layer line-boundary truncation so a partial
  line can never mis-resolve a key), `cfg_find` (the old ow_find body),
  `cfg_set` (user-file-only rewrite of one key).
- openwith.h / saver.h / sounds.h delegate; `OW/SV/SND_STORE_MAX` =
  `CFG_STORE_MAX` (8192 — three layers). Preserve: '#' comments,
  case-insensitive keys, "no store at all" outcomes (snd → silent -1,
  ow → hardcoded fallbacks), the reserved `mute` / `default.*` keys.
- image.json: `cfgstore.h` in the wm/open `hdrs`, seed-file comments
  updated, version v111 → v112.
- Red→green: test_sounds_e2e P15-P18 (baked-only alias reaches through a
  user-override-only store; override wins over baked `none`),
  test_openwith_e2e (user file is a pure delta; an /etc-layer key reaches
  through a customized user store), test_ctlpanel_e2e (mute toggle writes
  ONLY the mute key), test_saver_e2e (sv_set preserves the other USER key).

## Acceptance

- All three stores overlay per key; no `*_set` snapshots the merged table.
- The red→green tests above pass; kernel suite + browser sweep green.

## Open follow-up (surfaced, deliberately NOT absorbed here)

The arch-debt scan's FOURTH member of this class — **os/wm.c `menu_toggle`**,
`/etc/menu` vs `/usr/share/menu` "first-existing-DIR wins, no union merge"
(todos/0040) — is a different shape (a directory-ENTRY union, not a
key-value-file overlay) and lives in menu code with a pending redesign
(kernel-anchored menu subsurfaces). It is SEQUENCED with that redesign to
avoid rework, not dropped: whoever lands the menu redesign owns the
/etc-menu ∪ /usr/share-menu union question. Related: todos/0130 (Default
Programs applet) was written against the old whole-file model — its
`ow_each` enumeration must dedup keys against the merged store, and its
"Remove" semantics change under the delta model (deleting a user override
reverts to the lower layer; masking a baked key needs an explicit tombstone
if ever wanted) — amendment noted in that item.
