# Handoff — start of thread (updated 2026-07-10, after 0068 landed)

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Where the repo stands

**0068 (win32: user32/resource tail — winmine playable) landed
2026-07-10** — dev log `logs/2026-07-10/win32-winmine.md`. Winmine went
29-missing → linked, seeded (`/bin/winmine` + `/bin/winmine.res`),
playable; notepad 64→27, calc 45→15. The pieces: `tools/win32rc.js` (tiny
rc compiler → sidecar WRES pack next to the binary — the PE-resource-
section analog, zero link coupling), user32.c grew W entries (per-window
A/W mark + the send_msg WM_SET/GETTEXT translation choke), menus (user32-
drawn bar in the surface's top 20px, client offset under it; popups
in-surface; items are AGENT targets — `wmctl click "Beginner"`),
accelerators, DialogBoxParamW over RT_DIALOG templates, SetTimer/WM_TIMER,
synthetic metrics/monitor; gdi32 W text wrappers; new `shell32.c` +
`winmm.c` (PlaySoundW success stub) + `wwinmain.c` (CRT entry shim, listed
in the app's bin.json sources, NOT lib.json). ONE kernel change:
`SURFACE_RESIZE` 0x1007 (owner-initiated resize, NOT resizable-gated) +
`SDL_SetWindowSize` through compiler.js/host.js — winmine's per-difficulty
MoveWindow rides the 0019 renegotiation. **Image bumped v37→v38** (SDL
libc change = full rebake; winmine deliberately has NO Start-menu entry
and NO Desktop icon — geometry-pinned tests, k32demo precedent).

**Next in queue**: `0048` (file browser), then 0061/0062… — run
`node todos/queue.js list`.

**Still owed from 0039**: the pointer-lock HUMAN check was deferred by
ALL sweep rounds so far. It is a MUST for WM sweep round 3 (`0064`) —
first free moment with a human at the keys: quake lock on click, ESC
unlock, click re-lock, VT-switch release.

**Concurrent work note**: other sessions are active on this tree
(SS-INTEROP slices per `todos/SS-INTEROP.md`). If files show uncommitted
changes you didn't make, that's them — verify todos/ freshness and stage
ONLY your own files.

## The queue (todos/queue.json is authoritative)

Order + deps: `node todos/queue.js list` — do NOT copy the ordering into
this file.

## Gotchas carried forward

- **0068 MAKEINTRESOURCE detection**: `value < 0x10000` is WRONG here —
  this wasm layout's C STACK is the low 64KB (static data above it), so
  a stack string looks like an intres id. user32.c `is_intres` also
  requires the value ≤ a fresh local's address (stack grows down).
  Any future Windows-heuristic port relying on "low memory is unmapped"
  will hit the same trap.
- **0068 WRES sidecar**: `tools/win32rc.js` is the format SPEC; user32.c
  `res_*` re-declares it (MUST MATCH). Regenerate
  `vendor/winmine/winmine.res` after touching the rc sources (command in
  vendor/winmine/README.md). The pack is found via argv0 + `.res`, with
  a `/bin/<name>.res` fallback for PATH-spawned bare names.
- **0068 SURFACE_RESIZE is owner-only and NOT resizable-gated** (the bit
  protects apps from the WM, not from themselves). Config through the
  0019 renegotiation; a scaled (SET_DST) surface that self-resizes snaps
  back to dst==buffer at the configure ack — by design.
- **0068 menu geometry**: MENU_BAR_H 20 == SM_CYMENU; client/GetDC/input/
  WM_SIZE all offset by it; AdjustWindowRect(menu) adds it back. Beginner
  winmine surface = 154x202; test_winmine_e2e.js + os-winmine.mjs pin
  the numbers (main.h mirror — change together).
- **0068 wWinMain apps need the shim**: `os/win32/wwinmain.c` in the
  app's bin.json `sources` (deliberately not in lib.json — main()-apps
  would collide). "no 'main' function defined" at link = you forgot it.
- **0059 kernel32 is W-NATIVE** — deliberate deviation from the 0060
  "implemented names are ANSI generics" convention (which still stands
  for gdi32/user32/shell32/winmm): no ANSI generic kernel32 entries.
  kernel32's converters return 0 on short buffers — user32 has
  truncating variants (a2w_trunc/w2a_trunc) for window-text semantics.
- **0059 `__fd_action` DUP2 fields**: `fd` is the CHILD's target fd,
  `arg` is the source — swapping them makes redirects silently not apply.
- **Block comments eat `*/` inside prose**: `_tcs*/_t*` in a comment
  terminates it and the lexer error points at a later innocent line.
- **0059 stubs fail loudly by design**: CreateThread/LoadLibrary →
  ERROR_CALL_NOT_IMPLEMENTED. Don't "fix" them into silent successes.
  (0068 adds: SetTimer with a TIMERPROC returns 0 — corpus passes NULL.)
- **0060 A/W architecture** (windows.h header comment is canonical):
  implemented functions ARE the ANSI generic names; veneer sources
  `#undef UNICODE`; W variants at the END of windows.h; `u"…"` not
  `L"…"` (WCHAR is 2-byte UTF-16, libc wchar_t is 4-byte). Since 0068
  the user32/gdi32 W variants are IMPLEMENTED (translation at the
  boundary / send_msg), not just declared.
- **0060 harness**: PORTS.md is generated — never hand-edit; regenerate
  with `node tools/win32ports.js` (kernel suite --check fails stale).
  winmine is `expect: links` now — breaking its link is a test failure.
- **Start-menu geometry**: NINE entries (ctldemo sorts first),
  150x188+0+552 — `test_wm_service_e2e.js` + `os-shell.mjs` hardcode
  both; winmine/k32demo deliberately have NO menu entry. os-drop.mjs
  icon-cell indexes shift with any new /root/Desktop seed.
- **0067**: kernel-worker's `kfs` is a WORKER GLOBAL assigned in
  `boot()` — don't re-`var` it there.
- **0066**: `activate()`'s runnable peek must keep matching kernel.js
  `_spawnBytes` (`#!` on ≥2 bytes, `\0asm` on ≥4).
- **0065**: shebang optarg is ONE argument; depth rides a `_spawn`
  parameter; os_boot asserts `loop-rc=2` as the busybox-bump tripwire.
- **0058**: agent protocol is one request per connection; scrollbar is
  notify-only; MSG keysym rides a side slot — don't reorder GetMessage/
  TranslateMessage. Kernel close lands on the FIRST live top-level.
- **0057**: `os/win32/lib.json` include ORDER is load-bearing
  (freetype/demo before freetype/include). Every gdi32 write forces
  alpha 0xFF.
- **Editing seeded sources or coreutils.json/bin.json/lib.json requires
  bumping `os/image.json` `version`** (now 38) — rebake `os/os-system.img`
  with `node tools/mkimage.js`. A LIBC change in compiler.js counts
  (0068's SDL_SetWindowSize did).
- Queue changes go through `node todos/queue.js` ONLY; `check` must pass
  before committing. After `queue.js done`, check `git status` — the
  internal git-mv can stage a pre-edit blob (re-`git add` the done file).
- **0055**: boot REQUIRES worker WebGPU: browser os tests launch Chromium
  with `--enable-unsafe-webgpu --enable-features=Vulkan`.
- **`ls /` goldens include `proc`**: `bin dev etc proc root run tmp usr
  var`.
- 0043: ProcFS must implement the FULL MountFS op surface; kernel32's
  GetModuleFileName/GetCommandLine read /proc/<pid>/cmdline — keep the
  Linux NUL-separated format.
- 0037: exactly ONE of `procSpec.image`/`procSpec.module` is non-null;
  compile options MUST MATCH host.js runModule ↔ kernel.js `_moduleFor`.
- REPL-over-pty framing (0036): don't anchor pty markers on `\r\n` seams.
- Two unit goldens encode libc internals and move when libc changes:
  `switch_br_table` expected.compiler.stderr and `printf`'s
  pointer-address line. (0068 added SDL API but no libc-internal moves —
  verified by the unit suite.)
- **0040 layout in tests**: headless images pair as `foo-system.img` +
  `foo-root.img`; OPFS `os-system.v5.img`/`os-root.v5.img` are ALSO the
  Web Lock name (0045).
- Browser pixel tests: tolerate the icon grid in "empty desktop"
  asserts; desktop teal == compositor teal; SETTLE after VT switch;
  derive geometry from `__osScreen`; keep the sweep serial; a SECOND
  page needs a fresh context/browser (the 0045 boot lock) EXCEPT when
  the test closes the first page.
- hush `kill` is cooperative SIGTERM: barrier on surfaces vanishing
  before asserting no-WM behavior.
- The IDE's clangd flags os/*.c, os/win32/*.c and vendor sources —
  noise; those headers are compiler.js built-ins or project-include-path
  resolved.

## Conventions to keep

- Queue discipline: work = `todos/NNNN`, done → `todos/done/` via
  `node todos/queue.js done NNNN`, dev log per landing. Order and dep
  ids live ONLY in queue.json.
- compiler.js must stay browser-clean (no bare `process.*`).
- Fix bugs test-first: failing test commit, then the fix.
- MUST-MATCH blocks: WM protocol kernel.js ↔ os/wm_proto.h ↔
  test_wm_policy.js; agent protocol os/wm_agent.h ↔ os/win32/user32.c ↔
  os/wmctl.c; surface/ring layout kernel.js ↔ host.js; WMEV ↔ <SDL3> ↔
  host.js; audio ring kernel.js ↔ host.js; SI_* tty header kernel.js ↔
  host.js; sealed-blob superblock host.js ↔ fsck_v4.js; wasm compile
  options host.js runModule ↔ kernel.js _moduleFor; <sys/time.h>
  ITIMER_* ↔ kernel.js; test_gdi32_e2e.js/os-gdi.mjs ↔ gdidemo.c
  draw_scene; test_user32_e2e.js/os-user32.mjs ↔ ctldemo.c layout;
  wm.c is_runnable ↔ kernel.js _spawnBytes (0066); os/win32/ports.json ↔
  PORTS.md ↔ the harness (0060 — regenerate, don't hand-sync);
  kernel32.c DUP2 action fields ↔ <spawn.h> (0059); **WRES format
  tools/win32rc.js ↔ user32.c res_* (0068); winmine geometry
  vendor/winmine/main.h ↔ test_winmine_e2e.js ↔ os-winmine.mjs (0068)**.
- `tests/browser/os-*.mjs` are manual — run the full sweep serially
  after touching os/, kernel.js, host.js SDL/webgpu/fd/audio/input/tty
  paths, or anything that rebakes every binary. (0068 touched all three
  AND rebaked everything — the full 14-leg serial sweep incl. the new
  os-winmine.mjs ran at landing: all green; os-doom flaked once
  in-sweep ("no frame", load-timing) and passed clean alone — same
  class as the WM.md-noted gpubox adapter flake, not a regression.)
- Don't re-litigate: posix_spawn-not-fork, kernel-owned fds, WM.md's
  invariants, 0013–0058's decisions, DISK-IMAGE.md's settled layout,
  0045's no-steal/no-SharedWorker calls, 0036's minimal-port-mp scope,
  0037's RO-volume-only cache policy, 0043's synthetic-values-by-design,
  0044's no-VIRTUAL/PROF and cooperative-SIGALRM calls, 0055's
  no-fallback calls, WIN32.md's Win32-as-primary-toolkit decision,
  0057's recorded simplifications, 0058's calls, 0065's
  ENOEXEC-not-ELOOP + one-optarg calls, 0066's no-compat-branch call,
  0067's calls, 0060's calls (declaration-surface-not-implicit-decls,
  ANSI-generic implemented names + `#undef UNICODE` in veneer sources,
  `u"…"`-not-`L"…"`, `_tcs*`-as-real-symbols, implement strictly to
  PORTS.md demand), 0059's calls (kernel32 W-native, loud-failure
  stubs, mapping-views-are-copies, one-headered-malloc,
  registry-as-text-hive), and 0068's calls (sidecar-resource-pack — not
  linked-in tables, not Microsoft .res; in-surface clipped popups;
  stub icon/cursor handles; PlaySoundW-success-stub-until-waves-vendored;
  SURFACE_RESIZE not resizable-gated; synthetic GetSystemMetrics;
  no menu/desktop entry for winmine).

## Suggested opening for the new thread

"Read HANDOFF.md, then give me a one-paragraph status and ask what I want
to tackle: 0048 file browser, 0061 Cairo, 0062 zero-copy present, 0046
strace, 0064 WM sweep round 3 (the pointer-lock human check is owed), or
something else."
