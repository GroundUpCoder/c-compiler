# 0254 — cfgstore.h cfg_set silently destroys large config files (R3)

- **Status**: done (2026-07-17)
- **Design**: —

## Goal

Adversarial-review finding R3: `cfg_set` (os/cfgstore.h) read the user-layer
file through ONE bounded `fread(text, 1, CFG_STORE_MAX-1, uf)` and rebuilt
the file from that snapshot — so a `~/.config/openwith` (or screensaver /
sounds) file larger than 8191 bytes lost EVERYTHING past the prefix the
moment any single key was set. Silent, persistent data loss. Same class on
the read side: `cfg_load3` silently truncated an over-cap merged store and
neither path checked `ferror`; the overflow `return -1` didn't set errno.

## Plan

- cfg_set: STREAM the rewrite (fgets chunk loop user → tmp, substitute the
  key's line at line starts, append if unseen, rename) — no size cap on the
  write path at all; fail loud (-1/errno) on read errors, an
  existing-but-unopenable user file, and every fs op, never renaming a bad
  snapshot over the original.
- cfg_load3: keep the load-side cap (cfg_find needs the concat in one
  caller-owned buffer) but make hitting it LOUD — -1/EFBIG + stderr line,
  text keeps the line-boundary-clean prefix so truthiness-only callers
  degrade to a valid partial overlay; check ferror/fopen errors the same way.
- errno on every -1 (ENAMETOOLONG for an over-buffer key).

## Acceptance

- tests/kernel/test_cfgstore_e2e.js (red→green): a 14,000-byte user
  openwith file survives `ow_set` with all 700 override lines intact
  (pre-fix: 291 lost, file truncated to 8207 bytes); mid-file key replace
  keeps the tail; cfg_load3 over-cap → -1/EFBIG with a resolvable prefix;
  small-store delta semantics unchanged; errno on the failure paths; a
  directory as the user file fails loud and writes nothing.
- Kernel suite + browser sweep green; image v114 (cfgstore.h bakes into
  wm.c/fileman/ctlpanel/open/winmm).
