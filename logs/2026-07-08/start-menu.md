# 0028 — the Start menu (Start button + /etc/menu launcher)

Landed `todos/0028`: a Win95 Start button at the taskbar's left; clicking
it pops a borderless menu surface listing `/etc/menu`, selecting an entry
spawns it. All wm.c policy — zero kernel changes, exactly as designed
(`todos/WM.md` "The desktop shell").

## Decisions / findings

- **The child-stdio open question resolved as "harmless, and better than
  expected"**: parentless services get the SYSTEM std OFDs at spawn
  (`kernel.js _stdOfds` — fd 0 the tty, fd 1/2 out/tty), and posix_spawn
  children inherit the parent's fd table. So menu-launched apps have real
  fd 0/1/2 and their startup printf's land on the console. No file
  actions needed.
- **But wm children need reaping.** Only ppid-0 processes auto-reap; a
  child of the wm would zombie. wm.c keeps an `nkids` counter and polls
  `waitpid(-1, WNOHANG)` off the frame tick — no extra RPC when no
  children are live. If the wm dies first, orphans reparent to pid 1
  (hush), which reaps.
- **Two windows, one SDL queue**: the menu is a second borderless SDL
  window in the wm process, dispatched per event by `e.*.windowID`
  (the design's verified substrate fact — held up in practice). Own
  EV_CREATED frames dispatch by title ("taskbar" parks at the bottom,
  "startmenu" parks above the bar).
- **Dismiss-on-focus ordering**: creating the menu emits EV_FOCUS for the
  menu itself (create steals focus, deliberately — Win95 agrees). The
  dismiss rule is "any EV_FOCUS whose sid isn't the menu's"; the menu's
  own create-focus echo always arrives AFTER the EV_CREATED that told us
  its sid (same socket, ordered), so the exemption can't race.
- **Entry semantics**: symlink → spawned via its `/etc/menu/<name>` path
  (the fs resolves links — same mechanism as the /bin coreutils applets);
  regular file → first line tokenized as argv, bare argv[0] resolved in
  /bin (`term snake` is the seeded example). Children spawn in their own
  pgroup with `PATH=/bin HOME=/root`, cwd `/root` (the wm chdir's at
  startup; doom finds its WAD by cwd).
- **image.json grew a `content` entry kind** (inline string) for the
  one-line `/etc/menu/snake` command file — no point making a repo asset
  of ten bytes. Seeded menu: doom, gameboy, gpubox, quake, snake, term,
  winbox. **Image version is v22.**
- The taskbar window buttons shifted right by START_W+gap; the
  `os-wm.mjs` button-0 coordinates moved with them (50 → 100).

## Tests

- `tests/kernel/test_wm_service_e2e.js` grew menu legs (real /bin/wm over
  boot.js): Start click → borderless `startmenu` surface at the exact
  computed slot (150x148+0+592 on the 1024x768 headless screen); entry
  click → a second winbox appears and the menu is gone; Start re-opens;
  a focus change dismisses.
- New `tests/browser/os-shell.mjs` (manual tier, the 0028+0029 home):
  Start button pixels, menu open, navy hover highlight, launch winbox
  from the menu, dismiss on selection/focus-change/toggle, VT1 shell
  round-trip after.
