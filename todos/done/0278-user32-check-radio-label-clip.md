# 0278 — user32 check/radio label uses the retired 14px text height — descenders clip

- **Status**: done
- **Design**: os/win32/user32.c btn_paint; found by the bughunt-sc sweep (branch bughunt-sc, media/bughunt-sc)

## Goal
btn_paint's check/radio branch draws the label at `(h->h - 14) / 2`
(user32.c:3052) — a 5×7-era constant. With the 20px Noto system font
(tmHeight 28, ascent 22) the baseline lands below a 28px control, clipping
the bottom glyph row + descenders ("Install to Desktop" in the software
center, and every checkbox/radio OS-wide). The push-button branch measures
via GetTextExtentPoint32; check/radio must too.

## Plan
- Measure the label (GetTextExtentPoint32 → sz.cy), center with
  `ty = max(0, (h->h - sz.cy) / 2)`.
- Optional cosmetic (decide at fix time): scale the 13px check/radio box
  (user32.c:3024) to cap height so it doesn't read tiny next to 20px text —
  if taken, re-verify BM_SETCHECK hit rects and any goldens.
- Screenshot-verify the software center toggle + ctlpanel Sounds/Screen
  Saver; gate: kernel user32/ctlpanel/software e2es + os-user32 sweep.

## Acceptance
Descenders render inside the control on a 28px checkbox; existing e2es green.
