# 0237 — 0234 follow-up: fail-loud class gaps (wm.c exit(2) recreate paths, advapi32 hive_load unchecked malloc)

- **Status**: done (2026-07-17 — image v108; kernel 75/0, browser sweep 27/27;
  dev log: logs/2026-07-17/os-fail-loud-gaps.md)
- **Design**: —

## Goal

The 0234 fail-loud batch fixed the named instances but missed two members of
the same classes (found by a post-landing completeness audit):

- **CD6 gap**: the `die()` helper only replaced `exit(1)` sites because it
  hardcodes exit(1). The two `exit(2)` fatal paths in `screen_changed()`
  (`make_desk()`/`make_bar()` failing on a screen-resize recreate) still died
  with ZERO diagnostic — the exact failure mode CD6 claimed to eliminate.
- **CD3 gap**: `hive_load`'s `data` malloc (advapi32.c) was unchecked and then
  written (`data[i]`) — a NULL-deref on OOM inside the very function the CD3
  commit said it NULL-checked.

## Plan

- wm.c: generalize the helper — `fatal(int code, const char *what)` (stderr:
  what + strerror(errno), exit(code)); `die(what)` = `fatal(1, what)`. Route
  the two screen_changed() exits through it, mirroring main()'s wording.
- advapi32.c: `if (!data) break;` after the malloc (the RegVal-malloc partial-
  load discipline three lines down).
- Class re-grep both files: no bare fatal `exit()` in wm.c beyond the normal
  `exit(0)` on SDL_EVENT_QUIT; no unchecked written malloc/strdup left in
  advapi32.c (key_add / handle_new / RegSetValueExW / hive_load all verified).

## Acceptance

- `grep -nE "exit\(" os/wm.c` shows only fatal()'s exit(code) and the
  SDL_EVENT_QUIT exit(0).
- Every malloc/strdup in advapi32.c whose result is written is NULL-checked.
- Full gate: mkimage bake (image v108), kernel suite green, browser sweep 27/27.
