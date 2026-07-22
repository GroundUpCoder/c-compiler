# 0277 — fontcore: ONE header-only glyph-pipeline core for gdi32/term/ksvc

- **Status**: open
- **Design**: filed from todos/done/0275-kernel-text-service-design.md §14.4

## Goal

The estate now carries THREE copies of the chain-probe/tofu/cache glyph
discipline: gdi32 `font_glyph` (os/win32/gdi32.c), term `cp_glyph`
(os/term/term.c), and ksvc's pipeline (os/ksvc/ksvc.c). They agree by
convention (face 0 = mono.ttf pair, fc_load order, lazy chain opens, ASCII
pinned to face 0, tofu = cell × wcwidth, per-size caches) — consolidate the
convention into ONE header-only core (the fontchain.h / fileops.h /
openwith.h precedent) so it agrees by construction.

## Plan

- Extract the shared shape: face-set state (face 0 + chain, lazy open,
  dead-face marking), codepoint→face probe, tofu synthesis, the
  flat-[95]+side-cache glyph cache, the UTF-8 stepper (win32_internal.h's
  `__u8_next` is a 4th copy of that piece).
- Parameterize the per-consumer differences explicitly: gdi32's mono
  threshold + per-HFONT sizing, term's cell metrics, ksvc's per-(px,flags)
  slots + embolden.
- NOT smuggled into 0275: it refactors two SHIPPED consumers (gdi32, term)
  — land with the full text e2e surface green (gdi32/user32/term/fontpkg/
  ksvc kernel e2es + os-term/os-user32 sweeps).

## Acceptance

- One header (e.g. os/fontcore.h) holds the pipeline; gdi32/term/ksvc are
  thin adapters over it; the duplicated blocks are deleted.
- Byte-identical rendering before/after for each consumer (the fontpkg +
  ksvc same-bytes e2es are the oracle for two of the three; term's golden
  shots cover the third).
