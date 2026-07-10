# Handoff — start of thread (updated 2026-07-10, after 0069 landed)

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Where the repo stands

**0069 (WM map-on-placement — no first-frame teleport) landed
2026-07-10** — dev log `logs/2026-07-10/wm-map-on-placement.md`.
kernel.js + os/compositor.js only, ZERO wm.c change: with a WMP
subscriber, `SURFACE_CREATE` makes the surface UNMAPPED (skipped by
both compositor flavors + hit test; still listed/focusable/injectable/
SHOT-able) until the WM's first geometry/stacking op on the sid
(MOVE/RESIZE/SET_DST/SET_LAYER/RESTACK — wm.c's EV_CREATED MOVE is the
map ack). Foreign borderless maps at create (wm.c ignores those);
subscriber-owned borderless (the start menu, the worst repro) waits
for its self-park — `wmServe` conns now record the connecting pid.
Backstops: `WM_MAP_TIMEOUT_MS` (200ms) + last-subscriber-gone map all
pending. No subscriber → mapped at create (no-WM path byte-identical).
The WMP record is UNCHANGED (no protocol change; `wmList` grew a
`mapped` field). WM.md known-issues entry retired. NO image bump
(nothing seeded changed; still **v38**).

**0068 (win32 tail — winmine playable) landed earlier 2026-07-10** —
dev log `logs/2026-07-10/win32-winmine.md`; notepad 27 / calc 15
missing symbols (comdlg32/clipboard/printing next per PORTS.md).

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

- **0069 unmapped semantics in tests**: a surface created WHILE a WMP
  subscriber exists is invisible to composite/hit-test until a
  MOVE/SET_LAYER/… lands (or the 200ms backstop). A unit test that
  creates-then-screenshots must place first. Injection, `wmList`, and
  single-surface SHOT still work unmapped. FOCUS/MINIMIZE deliberately
  do NOT map; SURFACE_RESIZE (owner op) doesn't either.
- **0069 browser leg placement**: os-shell.mjs's no-teleport burst
  capture assumes nothing face-gray sits in the top-left cascade band
  at that point — keep it the FIRST menu interaction, right after boot.
- **os-winmine cell-reveal flake (pre-existing, seen this sweep)**: the
  `waitChange` at cell (1,1)'s CENTER can stall when the random board
  reveals a blank there (center pixel stays BTNFACE; only the 3D edge
  changes). Passed clean on re-run — same class as the os-doom load
  flake. A future hardening: probe the cell's top-left highlight pixel
  instead of the center.
- **0068 MAKEINTRESOURCE detection**: `value < 0x10000` is WRONG here —
  this wasm layout's C STACK is the low 64KB, so user32.c `is_intres`
  also requires the value ≤ a fresh local's address.
- **0068 WRES sidecar**: `tools/win32rc.js` is the format SPEC; user32.c
  `res_*` re-declares it (MUST MATCH). Regenerate
  `vendor/winmine/winmine.res` after touching the rc sources.
- **0068 SURFACE_RESIZE is owner-only and NOT resizable-gated**; a
  scaled (SET_DST) surface that self-resizes snaps back to dst==buffer
  at the configure ack — by design.
- **0068 menu geometry**: MENU_BAR_H 20 == SM_CYMENU; Beginner winmine
  surface = 154x202; test_winmine_e2e.js + os-winmine.mjs pin the
  numbers (main.h mirror — change together).
- **0068 wWinMain apps need the shim**: `os/win32/wwinmain.c` in the
  app's bin.json `sources` (NOT lib.json). "no 'main' function defined"
  at link = you forgot it.
- **0059 kernel32 is W-NATIVE** (no ANSI generics), unlike
  gdi32/user32/shell32/winmm (ANSI generic names, W wrappers).
- **0059 `__fd_action` DUP2 fields**: `fd` is the CHILD's target fd,
  `arg` is the source.
- **Block comments eat `*/` inside prose** (`_tcs*/_t*` in a comment).
- **0059 stubs fail loudly by design**: CreateThread/LoadLibrary →
  ERROR_CALL_NOT_IMPLEMENTED. Don't "fix" them into silent successes.
- **0060 A/W architecture** (windows.h header comment is canonical):
  veneer sources `#undef UNICODE`; `u"…"` not `L"…"` (WCHAR is 2-byte).
- **0060 harness**: PORTS.md is generated — regenerate with
  `node tools/win32ports.js`; winmine is `expect: links`.
- **Start-menu geometry**: NINE entries, 150x188+0+552 —
  `test_wm_service_e2e.js` + `os-shell.mjs` hardcode both;
  winmine/k32demo deliberately have NO menu entry.
- **0067**: kernel-worker's `kfs` is a WORKER GLOBAL assigned in
  `boot()` — don't re-`var` it there.
- **0066**: `activate()`'s runnable peek must keep matching kernel.js
  `_spawnBytes` (`#!` on ≥2 bytes, `\0asm` on ≥4).
- **0065**: shebang optarg is ONE argument; os_boot asserts `loop-rc=2`
  as the busybox-bump tripwire.
- **0058**: agent protocol is one request per connection; MSG keysym
  rides a side slot — don't reorder GetMessage/TranslateMessage.
- **0057**: `os/win32/lib.json` include ORDER is load-bearing; every
  gdi32 write forces alpha 0xFF.
- **Editing seeded sources or coreutils.json/bin.json/lib.json requires
  bumping `os/image.json` `version`** (now 38) — rebake with
  `node tools/mkimage.js`. A LIBC change in compiler.js counts. (0069
  needed NO bump — kernel.js/compositor.js aren't baked.)
- Queue changes go through `node todos/queue.js` ONLY; `check` must pass
  before committing. After `queue.js done`, check `git status` — the
  internal git-mv can stage a pre-edit blob (re-`git add` the done file).
- **0055**: boot REQUIRES worker WebGPU: browser os tests launch Chromium
  with `--enable-unsafe-webgpu --enable-features=Vulkan`.
- **`ls /` goldens include `proc`**: `bin dev etc proc root run tmp usr
  var`.
- 0043: ProcFS must implement the FULL MountFS op surface; keep
  /proc/<pid>/cmdline's Linux NUL-separated format.
- 0037: exactly ONE of `procSpec.image`/`procSpec.module` is non-null;
  compile options MUST MATCH host.js runModule ↔ kernel.js `_moduleFor`.
- REPL-over-pty framing (0036): don't anchor pty markers on `\r\n` seams.
- Two unit goldens encode libc internals and move when libc changes:
  `switch_br_table` expected.compiler.stderr and `printf`'s
  pointer-address line.
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
  kernel32.c DUP2 action fields ↔ <spawn.h> (0059); WRES format
  tools/win32rc.js ↔ user32.c res_* (0068); winmine geometry
  vendor/winmine/main.h ↔ test_winmine_e2e.js ↔ os-winmine.mjs (0068).
- `tests/browser/os-*.mjs` are manual — run the full sweep serially
  after touching os/, kernel.js, host.js SDL/webgpu/fd/audio/input/tty
  paths, or anything that rebakes every binary. (0069 touched kernel.js
  WM paths + compositor.js — the full 14-leg serial sweep ran at
  landing: 13 green; os-winmine failed once on the known-class
  cell-reveal randomness above and passed clean alone.)
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
  registry-as-text-hive), 0068's calls (sidecar-resource-pack,
  in-surface clipped popups, stub icon/cursor handles,
  PlaySoundW-success-stub, SURFACE_RESIZE not resizable-gated,
  synthetic GetSystemMetrics, no menu/desktop entry for winmine), and
  0069's calls (map ack = geometry/stacking ops only — FOCUS/MINIMIZE
  don't map; borderless dispatch on subscriber ownership; record
  format unchanged — `mapped` rides wmList only; 200ms backstop).

## Suggested opening for the new thread

"Read HANDOFF.md, then give me a one-paragraph status and ask what I want
to tackle: 0048 file browser, 0061 Cairo, 0062 zero-copy present, 0046
strace, 0064 WM sweep round 3 (the pointer-lock human check is owed), or
something else."
