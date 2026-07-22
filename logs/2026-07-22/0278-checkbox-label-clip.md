# 0278 — check/radio label descender clip (retired 14px text height)

`btn_paint`'s check/radio branch still centered its label with the 5×7-era
constant: `(h->h - 14) / 2`. Under the v133 20px Noto retune (tmHeight 28,
ascent 22) a 28px checkbox drew the label at y=7, putting the baseline at
row 29 — one row past the control — so the bottom glyph row and every
descender clipped ("Install to Desktop" in the software center read like
"Deskto"). The push-button branch right below was retuned to measure via
`GetTextExtentPoint32`; the check/radio branch was simply missed.

Fix: mirror the push path — measure the label, `ty = max(0, (h-sz.cy)/2)`.
For a 28px control that's ty=0, baseline 22, descenders ending exactly at
the control's last row.

Test: the 0236 STATIC-descender pattern extended to checkboxes — ctldemo
grew a 28px `"No gyp"` BS_AUTOCHECKBOX (created LAST so existing BUTTON:n
agent indices don't shift), and `test_user32_e2e.js` measures its label's
descender extent (dj) against the tall unclipped reference STATIC from the
same shot. Red→green verified: pre-fix the leg fails with
`{cdj: {dj: 0}, ref: {dj: 5}}` (descenders fully clipped, ink riding the
bottom row); post-fix dj === ref.dj with the extent inside the control.
Look-confirmed on the ctldemo shot and on the software-center
"Install to Desktop" toggle (the 'p' tail renders).

Deliberately NOT taken: scaling the 13px check/radio box to the 20px text
(user32.c box geometry) — hit-rect + visual-baseline implications make it a
separate judgment call (noted in todos/0278 as the optional cosmetic).

Gate: kernel 100/102 in the -j4 run with both stragglers
(menubox, clang_pkgs — wait-win timeouts under a 520s os_boot neighbor)
passing isolated; os-user32 sweep green against a forced fresh bake;
user32_e2e stable 3/3 under load ×10.
