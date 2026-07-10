# Handoff — start of thread (updated 2026-07-10; 0048 landed, close-out = 0074)

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Where the repo stands

**0048 (desktop apps wave 1) landed 2026-07-10, close-out pending
`0074`** — four commits (calc 189d956, notepad 74d7f24, fileman
fd85358, ctlpanel 1c3febc), dev log
`logs/2026-07-10/desktop-apps-wave1.md`. The Win95 organ set is in:
**calc, notepad, fileman, ctlpanel seeded + Start-menu entries for all
five wave-1 apps (winmine included — 0068's "no menu entry" call is
superseded)**. Image is **v42**. Veneer highlights: file-backed
clipboard (`$HOME/.clipboard`), keyboard translation, TrackPopupMenu
(standalone popups on the 0068 overlay, agent-visible), **WRES v2**
(RT_DIALOG carries a menuId — regenerate BOTH res packs after touching
win32rc.js), comdlg32 (real file dialogs + find/replace protocol),
comctl32 status bar, MB_YESNOCANCEL, kernel **AUDIO_GAIN (0x2003)**
master volume + host.js `__audio_gain`. All six PORTS.md targets now
`links`. Kernel suite: 39 files green at close.

**Sweep ledger at landing (the 0048 gate)**: 13/14 — os-shell and
os-drop hardcoded the pre-758dd6e desktop-icon grid, were repaired
in-place (geometry now DERIVES from entry lists) and PASS; **os-doom
fails deterministically** (identical region hash across runs — NOT the
known load-flake). Doom itself is fine: the manual browser drive
composites full frames and headless doom is green — the evidence
(sampled n=50032 where the region math says 61936) points at a
test-side canvas race with the VT2 re-mode. Full evidence + plan in
`todos/0074`, debug scratch `tests/browser/zz-doom-debug.mjs`. 0048
moves to done/ when 0074 lands.

**0069/0068** landed earlier the same day (see their dev logs); notepad/
calc's PORTS.md backlog is CLEARED — the next corpus demand would come
from a new port (metapad, PuTTY per WIN32.md).

**Follow-up items from this thread's dogfooding** (committed 8286183):
`0070` desktop-as-default-tab, `0071` tty VEOF transient (^D in a REPL
kills the GUI terminal today — root cause found, kernel.js sticky-EOF),
`0072` openwith associations (supersedes the hardcoded `term vi` in
wm.c AND fileman.c — two copies of the policy now), `0073` desktop-apps
behavior bug sweep (seeded findings listed in the item).

**Next in queue**: `0074` (the 0048 close-out), then `0061` (Cairo),
`0062` (zero-copy present) — run `node todos/queue.js list`.

**Still owed from 0039**: the pointer-lock HUMAN check was deferred by
ALL sweep rounds so far. It is a MUST for WM sweep round 3 (`0064`) —
first free moment with a human at the keys: quake lock on click, ESC
unlock, click re-lock, VT-switch release.

**Concurrent work note**: other sessions are active on this tree
(SS-INTEROP slices per `todos/SS-INTEROP.md`). If files show uncommitted
changes you didn't make, that's them — verify todos/ freshness and stage
ONLY your own files. **Cautionary tale from this thread**: 758dd6e (a
concurrent landing) `git add`-ed os/image.json wholesale and swept
0048's in-progress seeding + version bump into its commit, leaving HEAD
referencing a not-yet-committed calc.res. Check `git diff --cached`
against what you MEAN to land.

## The queue (todos/queue.json is authoritative)

Order + deps: `node todos/queue.js list` — do NOT copy the ordering into
this file.

## Gotchas carried forward

- **0048 menu/desktop geometry in tests**: test_wm_service_e2e.js and
  os-shell.mjs now DERIVE Start-menu and desktop-icon geometry from
  entry lists (`MENU_ENTRIES`/`DESK_ENTRIES`) — when image.json gains a
  menu entry or Desktop item, bump the LIST (sorted!), not coordinates.
- **0048 WRES v2**: the RT_DIALOG record grew `u16 menuId` after style.
  tools/win32rc.js is the spec, user32.c `res_*` re-declares (MUST
  MATCH). Regenerate winmine.res + calc.res + notepad.res together
  after ANY format change; packs are committed per-port and seeded next
  to the binaries.
- **0048 wmctl click**: ONE argument = label form ALWAYS (numeric labels
  are calc's keypad); pixel clicks carry `SID X Y`.
- **0048 clipboard**: `$HOME/.clipboard`, UTF-8 bytes, tmp+rename. The
  EDIT control and the user32 API both use it; cross-process by
  construction. GetClipboardData handles are clipboard-owned.
- **0048 EM_GETHANDLE**: the external HLOCAL view is WCHARs at
  (utf8len+1) capacity, tail-zeroed; the APP frees replaced handles.
  Non-ASCII saves can carry NUL padding (documented, unfixed).
- **notepad normalizes to CRLF internally** — e2e content assertions
  expect `\r\n` (and `.trim()` eats a trailing `\r`).
- **0048 argv0**: kernel32 proc_info_init PATH-resolves a BARE argv0
  (GetModuleFileNameW answers /bin/notepad for a PATH spawn, not
  cwd-joined fiction). New Window/ShellExecuteW depend on it.
- **0048 AUDIO_GAIN**: percent 0..200, gain<0 queries, system-wide by
  design; applied in audioPump pre-clamp. KERNEL.md opcode table + WM.md
  mixing paragraph are updated — keep in sync.
- **TrackPopupMenu coords are SURFACE space** (== what WM_CONTEXTMENU
  hands out); open standalone popups appear in the agent tree as
  `popupmenu` and fire by label. FOCUS stays modal-per-surface only.
- **comdlg32 OFN hooks/templates are deliberately not run** — notepad's
  Save As encoding combo degrades to the current value. Growing hooks
  means the explorer-dialog notify protocol; check demand first.
- **os-winmine cell-reveal flake (pre-existing)**: the `waitChange` at
  cell (1,1)'s CENTER can stall when the random board reveals a blank
  there. Same class as the os-doom load flake — re-run the leg alone.
- **0069 unmapped semantics in tests**: a surface created WHILE a WMP
  subscriber exists is invisible to composite/hit-test until a
  MOVE/SET_LAYER/… lands (or the 200ms backstop). Injection, `wmList`,
  and single-surface SHOT still work unmapped.
- **0069 browser leg placement**: os-shell.mjs's no-teleport burst
  capture assumes nothing face-gray sits in the top-left cascade band —
  keep it the FIRST menu interaction, right after boot.
- **0068 MAKEINTRESOURCE detection**: `value < 0x10000` is WRONG here —
  the wasm STACK is the low 64KB; user32.c `is_intres` also requires the
  value ≤ a fresh local's address.
- **0068 SURFACE_RESIZE is owner-only and NOT resizable-gated**; a
  scaled (SET_DST) surface that self-resizes snaps back at the ack.
- **0068 menu geometry**: MENU_BAR_H 20 == SM_CYMENU; winmine surface
  numbers pinned in test_winmine_e2e.js + os-winmine.mjs (main.h
  mirror); calc standard surface is 338x324 (test_calc_e2e.js).
- **0068 wWinMain apps need the shim** in bin.json `sources`; `_tWinMain`
  now aliases to wWinMain in tchar.h (calc/notepad define it).
- **0059 kernel32 is W-NATIVE** (no ANSI generics), unlike gdi32/user32/
  shell32/winmm/comctl32/comdlg32 (ANSI generic names, W wrappers).
- **0059 stubs fail loudly by design**: CreateThread/LoadLibrary →
  ERROR_CALL_NOT_IMPLEMENTED; 0048 added the StartDoc print family.
  Don't "fix" them into silent successes. ChooseFont/PrintDlg/
  PageSetupDlg return FALSE = "cancelled" (an app-visible non-crash).
- **0060 A/W architecture** (windows.h header comment is canonical):
  veneer sources `#undef UNICODE`; `u"…"` not `L"…"` (WCHAR is 2-byte).
- **0060 harness**: PORTS.md is generated — `node tools/win32ports.js`.
- **0067**: kernel-worker's `kfs` is a WORKER GLOBAL assigned in
  `boot()` — don't re-`var` it there.
- **0066**: `activate()`'s runnable peek must keep matching kernel.js
  `_spawnBytes` — wm.c AND os/win32/fileman.c carry copies now.
- **0065**: shebang optarg is ONE argument; os_boot asserts `loop-rc=2`.
- **0058**: agent protocol is one request per connection; MSG keysym
  rides a side slot — don't reorder GetMessage/TranslateMessage.
- **0057**: `os/win32/lib.json` include ORDER is load-bearing; every
  gdi32 write forces alpha 0xFF.
- **Editing seeded sources or coreutils.json/bin.json/lib.json requires
  bumping `os/image.json` `version`** (now 42) — rebake with
  `node tools/mkimage.js`; boot.js `--fresh-system` forces headless.
  A LIBC change in compiler.js counts.
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
  wm.c/fileman.c is_runnable ↔ kernel.js _spawnBytes (0066);
  os/win32/ports.json ↔ PORTS.md ↔ the harness (0060 — regenerate,
  don't hand-sync); kernel32.c DUP2 action fields ↔ <spawn.h> (0059);
  WRES v2 format tools/win32rc.js ↔ user32.c res_* (0048); winmine
  geometry vendor/winmine/main.h ↔ test_winmine_e2e.js ↔ os-winmine.mjs
  (0068); menu/desktop entry lists image.json ↔ test_wm_service_e2e.js ↔
  os-shell.mjs (0048).
- `tests/browser/os-*.mjs` are manual — run the full sweep serially
  after touching os/, kernel.js, host.js SDL/webgpu/fd/audio/input/tty
  paths, or anything that rebakes every binary. (0048 touched all of the
  above — the full 14-leg serial sweep ran at landing: see the sweep
  note below.)
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
  synthetic GetSystemMetrics), 0069's calls (map ack =
  geometry/stacking ops only; borderless dispatch on subscriber
  ownership; 200ms backstop), and 0048's calls (clipboard-as-a-file,
  system-wide-not-per-process gain, honest-cancel common dialogs,
  no-OFN-hooks, no-DnD-into-surfaces, EM_GETHANDLE's oversized-WCHAR
  materialization, always-label one-arg wmctl click).

## Suggested opening for the new thread

"Read HANDOFF.md, then give me a one-paragraph status and ask what I want
to tackle: 0061 Cairo, 0062 zero-copy present, 0046 strace, 0064 WM sweep
round 3 (the pointer-lock human check is owed), or something else."
