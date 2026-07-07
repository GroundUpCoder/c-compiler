# busybox vi — the OS gets an editor (todos/0011)

The OS had no editor. busybox `vi` was the obvious candidate — real (daily
driver on embedded Linux), lightweight, and nearly free given 0005/0010:
the tree, the libbb slice, and the multicall infrastructure all exist.

## Why the port cost almost nothing

The investigation confirmed the tty stack needed **zero new work**: vi's
input machinery (`read_key.c`, `safe_poll.c`, `xfuncs.c`'s
`set_termios_to_raw`/`get_terminal_width_height`) is the SAME code hush's
interactive line editing already runs in os.html. `poll()` exists in the
libc (over `select()`), `TIOCGWINSZ` works, the kernel posts SIGWINCH to
the fg pgroup on resize (0002), and SIGTSTP/SIGCONT stop/continue are the
0003 job-control machinery. The only genuinely missing pieces:

- `editors/vi.c` itself (5053 lines) and `libbb/read_printf.c`
  (`xmalloc_open_read_close`) vendored in; `read_key.c` + `safe_poll.c`
  added to the coreutils link (they were only in hush's bin.json).
- **libc**: `sigjmp_buf`/`sigsetjmp`/`siglongjmp` added to `setjmp.h` — as
  macros over setjmp/longjmp, which is semantically *correct* here, not a
  shortcut: signals are cooperative and there is no blocked-signal mask to
  save. Macros (not wrappers) so the compiler's setjmp lowering sees the
  plain `setjmp` call post-preprocessing.

## Config

`CONFIG_VI=y` + upstream FEATURE_VI_* defaults (colon commands, search,
yank/mark, undo+queue, signals, win-resize, verbose status; MAX_LEN 4096).
Deliberately off:

- `FEATURE_VI_REGEX_SEARCH` — upstream default-off ("uses GNU regex, which
  may be unavailable. FIXME"); plain-text search. We *do* have a regex for
  sed/grep (`xregcomp`), so this could be revisited, but stock is stock.
- `FEATURE_ALLOW_EXEC` — `:!cmd` compiles out. Consequence: vi never
  spawns, so the multicall keeps `-DPV_NO_INTERCEPT` (no vfork journal).
  Enabling it later means auditing that flag first.

Regenerated `autoconf.h` via kconfig from `busybox.config` and re-applied
the two hand-patches (exec path, NOMMU block) per the vendor README. Bonus:
kconfig normalized the old hand-prepended `CONFIG_NOMMU=y` line into its
proper place in the config.

## The two vi.c patches (both compiler-dialect, not platform)

1. `sig = sigsetjmp(restart, 1); if (sig != 0)` → `if (sigsetjmp(...) != 0)`
   — this compiler's setjmp lowering only supports the if-form (same class
   as the 0005 `test.c` patch). Safe: `sig` was only ever tested against 0.
2. Six GNU `?:` (elvis) sites → plain ternary. All operands side-effect-free
   (`cmdcnt`, `col % tabstop`), so double evaluation is harmless. If a
   future port hits `?:` with side effects, that's a compiler feature
   decision, not a patch site.

## Testing an interactive full-screen editor for real

`tests/kernel/test_vi_e2e.js` (in the kernel suite): expect-style driver
over `boot.js --tty-out` — keystrokes go through the kernel tty's line
discipline into vi's raw mode; screen output (alternate screen, cursor
addressing) is observed on stdout. Seven scenarios: create+insert+`:wq`,
append (`A`), search+change (`/world` + `cw`), undo (`dd`+`u`), multi-line
insert (CR→NL through the raw-CRNL termios), `2G`+`dd`, `:q!` discard.

Two hard-won harness rules:

- **The file is the assertion, the screen is scenery.** After every `:wq`,
  a `cat`+unique-marker roundtrip in the same hush session asserts exact
  file bytes. Screen scraping only *synchronizes*.
- **Only full-line renders are expectable.** vi paints incrementally: an
  appended `!` arrives as `ESC[1;12H!` — the string `world!` never appears
  contiguously. Expect file-load renders and status-line messages
  (`Undo [1] restored …`); use short settles for incremental edits. ESC is
  sent alone with air on both sides (read_key resolves lone ESC by
  timeout; `ESC:`bundled would parse as an escape-sequence prefix).

`\x1b[?1049h` / `l` (alternate screen enter/leave) turn out to be perfect
vi-started / vi-exited markers.

**Browser half** (follow-up, same day): `tests/browser/os-boots.mjs` grew a
vi section — type/edit/`:wq`/`cat` through real Chromium + xterm. One
cross-path gotcha worth remembering: Playwright's `keyboard.type` delivers
one char per key event, so each char is its own tty read → own vi refresh
→ cursor-positioned single-char render (`ESC[4;16Hv ESC[4;17Hi …`) — typed
text NEVER appears contiguously in the output stream, unlike the kernel
e2e where the whole string lands in one tty buffer read and renders as a
line. So in the browser test the sync is time-based and the file bytes are
(as always) the assertion.

## Numbers

- Multicall grows to 28 applets, 219 KB wasm (from ~200 KB) — vi is ~26 KB
  as advertised by its Kconfig.
- `os/image.json` → v8 (`/bin/vi` symlink added).
