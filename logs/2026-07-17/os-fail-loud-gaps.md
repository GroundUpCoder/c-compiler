# 0234 follow-up: the fail-loud batch missed class members (todos/0237, 0238)

A post-landing completeness audit of the 0234 fail-loud batch found it had
fixed the NAMED instances of CD6 and CD3 but left same-class siblings silently
failing — the "fix the easy instances, miss the class" shortcut. Two gaps:

## CD6 gap — wm.c still had silent fatal paths (os/wm.c)

The 0234 `die()` helper hardcodes `exit(1)`, so the mechanical sweep only
caught `exit(1)` sites. The two `exit(2)` fatal paths in `screen_changed()` —
`make_desk()`/`make_bar()` failing while recreating the desktop/taskbar
windows on a screen resize — still killed the desktop's central service with
zero diagnostic, the exact failure mode CD6 claimed to eliminate ("every
fatal path says why").

Fix is the general one, not two fprintf patches: `fatal(int code, const char
*what)` (stderr: what + strerror(errno), then exit(code)); `die(what)` is now
`fatal(1, what)`. The two recreate exits route through `fatal(2, ...)` with
wording mirroring main()'s create-failure messages. Class re-grep: the only
`exit(` left in wm.c besides fatal()'s own is the normal `exit(0)` on
SDL_EVENT_QUIT.

## CD3 gap — advapi32.c unchecked malloc the CD3 commit claimed it checked

`hive_load`'s `data = malloc(len ? len : 1)` was unchecked and then written
(`data[i]`) — a NULL-deref on OOM inside the very function the CD3 commit
said it NULL-checked. Fix: `if (!data) break;` (the same keep-the-partial-load
discipline as the RegVal malloc three lines down). Class re-grep: every other
malloc/strdup in advapi32.c whose result is written is checked (key_add,
handle_new + both callers, RegSetValueExW, hive_load's RegVal/strdups).

## Bycatch: os-wm.mjs keyboard-Move flake (todos/0238, pre-existing)

Gating the above, `os-wm.mjs` flaked 33% under `--repeat 3` on "keyboard Move
relocated C (+40,+16)" — reproduced IDENTICALLY at origin/main on the v107
image (stash + rebake + repeat), so pre-existing, filed P0 per policy. Root
cause is the 0171 anti-pattern on the test side: the "move committed" gate
`waitPixel(CX+240, CY+116, GREEN)` sits inside C's PRE-move footprint, so it
passes before the move composites, and the move proof was an instant
`sample()` racing the frame (the FAIL line printing exactly ORANGE — the
diagnostic re-sample landing after the composite — was the tell). Fix: one
true marker wait, `waitPixel(CX+5, CY+5, ORANGE)` — B's orange appearing at
C's vacated corner IS the post-move composite. Stable 3/3 plain and 3/3
`--under-load` after.

## Gate

Image v108 (mkimage, sealed). Kernel suite 75/0. Browser sweep 27/27. No
injection seam exists to force SDL window creation to fail mid-resize, so the
recreate-path diagnostic is covered by construction (fatal() is the same
code path die() exercises) and non-regression via test_wm_service_e2e +
the os-wm/os-screen sweep legs.
