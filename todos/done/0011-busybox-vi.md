# 0011 — busybox vi (the OS's editor)

- **Status**: done (2026-07-07 — /bin/vi in the coreutils multicall (28 applets);
  libc grew sigsetjmp/siglongjmp; vi e2e test drives real edit sessions
  through the kernel tty. Dev log: `logs/2026-07-07/busybox-vi.md`)
- **Depends**: 0010 (coreutils multicall — vi joins that binary), 0002/0003
  (tty raw mode, SIGWINCH, job control)
- **Design**: `vendor/busybox/README.md` (port conventions);
  `todos/OS.md` Phase 1 userland

## Goal

A real editor in the OS: busybox `vi` as `/bin/vi`, joining the coreutils
multicall. The platform already has every primitive vi needs — full-struct
termios raw mode, `TIOCGWINSZ`, SIGWINCH-on-resize to the fg pgroup,
cooperative SIGTSTP/SIGCONT — and hush's interactive line editing already
exercises the same libbb input machinery (`read_key.c`, `safe_poll.c`,
`xfuncs.c` raw-mode helpers) in os.html today.

## Investigation results (2026-07-07)

- **New sources to vendor**: `editors/vi.c` (5053 lines),
  `libbb/read_printf.c` (`xmalloc_open_read_close`). Everything else vi
  calls is vendored already; `read_key.c` + `safe_poll.c` just need adding
  to the coreutils link (today only hush's bin.json lists them).
- **Config**: `CONFIG_VI=y` + upstream FEATURE_VI_* defaults
  (colon/search/yankmark/undo/signals/winresize on;
  `FEATURE_VI_REGEX_SEARCH` off — upstream default, plain-text search).
  `FEATURE_ALLOW_EXEC` stays off, so `:!cmd` compiles out → vi never
  spawns → the multicall's `-DPV_NO_INTERCEPT` stays valid.
- Regenerate `autoconf.h` via kconfig from `busybox.config`, re-apply the
  two hand-patches (exec path, NOMMU block) per the vendor README.

## Acceptance

- `/bin/vi` symlink → coreutils multicall; `os/image.json` version bumped.
- **A dedicated automated test** driving vi through the tty in raw mode
  (kernel suite): feed real keystrokes (insert, ESC, `:wq`, `dd`, search),
  assert the resulting file bytes; screen-output sanity (cursor addressing
  escapes present). Not just "it starts" — edit sessions end-to-end.
- Full suites green (unit, blockfs, kernel incl. OS acceptance) + manual
  `tests/browser/os-boots.mjs` (busybox port touched).
- Vendor README applet list + patch table updated; dev log.
