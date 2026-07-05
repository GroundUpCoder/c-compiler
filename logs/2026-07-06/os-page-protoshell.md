# os/ reference page + protoshell — the OS boots (todos/0004)

Same-day follow-on to Phase 4: with the kernel feature-complete, this item
turns it into a thing you can *open*. `node serve.js .` → `/os/os.html` →
a terminal over a persistent OPFS image, protoshell as pid 1, and
`cc hello.c && ./a.out` compiling and running inside the OS. Headless:
`echo 'ls /' | node os/boot.js`.

## Decisions

- **The image manifest maps to C sources, not wasm URLs.** The 0004 sketch
  said "path → fetch URL of built wasm", but this repo has no build step to
  produce those artifacts. Instead `os/image.json` entries are C sources
  (`protoshell.c`, `cc.c`) that the kernel worker compiles AT SEED TIME with
  its own cc driver — the OS literally compiles its userland on first boot
  (~1s, cached in the image thereafter). `/etc/.image-version` gates
  re-seeding; bump `image.json`'s `version` when editing seeded sources.
  `tools/mkimage.js` pre-baking stays a future distribution convenience.
- **One cc driver for /bin/cc and seeding** (`os-common.js`): a cc-argv
  subset (-o/-I/-D/-g) over the CompilerJS library API — `pp.fileReader`
  reads the kernel's BlockFS, `writeErr`/`fatalExit` are captured, output
  wasm written back to the image. Backs the `__compile` RPC, so `os/cc.c`
  is a 25-line shim that ships argv+cwd and writes the returned
  stdout/stderr to its own fds (redirection applies to compiler output).
- **compiler.js library etiquette**: `parseAllUnits` used to
  `process.exit(1)` on compile errors even for library callers — under
  headless boot that would take down the whole OS on any user typo. Now it
  throws (marked `compilationFailed: true`, diagnostics already delivered
  via `writeErr`) when `writeErr` is injected; CLI behavior unchanged. The
  unit runner learned the marker (it previously relied on its process.exit
  patch catching the exit).
- **Prompts and boot logs go to stderr** (protoshell prompts like `bash -i`;
  boot.js `[boot]`/`[kernel]` lines) so piped-stdin sessions have byte-clean
  stdout — that plus dropping tty echo under non-interactive stdin is what
  makes `echo 'ls /' | node os/boot.js` produce exactly `bin dev etc root`.

## Bugs found under the OS's weight

- **`openWorkspace` labeled every native-v4 mount 'fresh'** — worse than
  cosmetic: a natively-formatted v4 image never got the migration-complete
  superblock bit, so every mount re-entered the migrate-check path, and a
  legacy `workspace.img` appearing later in the same OPFS dir would
  `truncate(0)` the v4 image and "migrate" over it (data loss). Fixed at
  the one site where "fresh, no legacy" is decided — openWorkspace's fresh
  path sets the bit; deliberately NOT in `createV4` (migration formats its
  destination through createV4, and a crash mid-copy must stay visibly
  incomplete). Caught by the browser test's reload-reuses-image assertion.
- **Playwright default RAF polling stalls** in an unfocused headless page —
  `waitForFunction` needs `polling: <ms>` or updates that arrive between
  frames are missed. (The OS was fine; the test harness wasn't.)
- Program stdout is raw `\n` (the kernel stays out of the output data
  plane — no OPOST pass on the write path), so os.html sets xterm's
  `convertEol` rather than pretending there's a tty output filter.

## Shape

- `os/os.html` — dumb UI bridge (xterm + `window.__osOut`/`__osState`
  agent probe) → `os/kernel-worker.js` (openWorkspace on OPFS, seeding,
  Kernel + Tty + compile hook, nested process workers) →
  `os/process-worker.js` (browser twin of kernel.js's Node BOOT_SOURCE:
  KernelClient + RemoteFS + runModule).
- `os/boot.js` — the same OS headless: `NodeFileStore` (ByteStore over a
  plain file, SyncAccessHandleStore's twin), stdio tty bridge (raw mode
  when interactive), exit code = init's status. Image persists in
  `os/os.img` (gitignored).
- `os/protoshell.c` (~230 lines) — builtins (cd pwd ls cat echo help
  exit), `/bin` lookup + cwd-resolved paths, `&&` chaining, trailing `&`,
  and real foreground-job handoff: children spawn into their own pgroup
  (`POSIX_SPAWN_SETPGROUP`) and get the tty via `tcsetpgrp`, so Ctrl-C/
  Ctrl-Z hit the job; stops/signal deaths reported via WUNTRACED.

## Verification

- `tests/kernel/test_os_boot.js` (in the kernel suite): seed → session
  (`ls /`, `cc hello.c && ./a.out`, `exit 7` → exit code 7) → second boot
  reuses the image and sees `a.out` → failed `cc` and unknown commands
  (127 via `$?`) leave the OS alive.
- `tests/browser/os-boots.mjs` (manual, Playwright): boots the real page
  in headless Chromium, types through the real xterm path, reload
  persistence, halt propagation. All green.
- Suites: kernel 10/10 files, units 694/0, BlockFS 12/12, spawn parity.

Next: `todos/0005` — busybox ash onto `/bin/sh`, the kernel's acceptance
gate. The protoshell hands it a booted, persistent, compile-capable world.
