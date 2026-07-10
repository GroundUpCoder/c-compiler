# Handoff — start of thread (updated 2026-07-10; 0048 + 0074 closed, sweep 14/14)

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Where the repo stands

**0048 (desktop apps wave 1) is CLOSED** — all five wave-1 apps (calc,
notepad, fileman, ctlpanel, winmine) seeded with Start-menu entries,
image **v42**, kernel suite 39 files green, and the browser sweep now a
real **14/14** (dev logs `logs/2026-07-10/desktop-apps-wave1.md` +
`0048-closeout.md`).

**0074 (the close-out) resolved the "deterministic os-doom failure" —
it was never doom.** The blocking `waitFrame` stats (`n=50032`) match
GB_REGION (472·424/4), not DOOM_REGION (61936): the failing check was
gameboy's "desktop restored" assert, whose hardcoded 2%-of-region icon
allowance (1000.6 samples) was outgrown by the desktop icon grid when
758dd6e added three ROM launcher icons (1022 static samples). Same
class as the os-shell/os-drop repairs at landing. Fix is test-side:
os-doom.mjs baselines the idle desktop (per-region signature, settled
via two identical snapshots) before launching anything, and each
restore assert is now `hash === baseline` — strictly stronger, no
tolerance constant to outgrow. Full story:
`logs/2026-07-10/0048-closeout.md`.

**The os-winmine cell-reveal flake is FIXED** (same session): the check
sampled cell (1,1)'s center pixel, which doesn't change when the reveal
flood-fills a blank (~⅓ of random boards — it fired twice in a row this
round). It now diffs a 16×16 cell-rect FNV signature, matching the
headless twin's `cellRect` diff; 3/3 green. The old "re-run the leg
alone" advice for THIS flake is retired (the os-doom load flake class
may still exist).

**Follow-up items from 0048's dogfooding** (committed 8286183): `0070`
desktop-as-default-tab, `0071` tty VEOF transient, `0072` openwith
associations, `0073` desktop-apps behavior bug sweep.

**Next in queue**: `0061` (Cairo), `0062` (zero-copy present) — run
`node todos/queue.js list`.

**Still owed from 0039**: the pointer-lock HUMAN check was deferred by
ALL sweep rounds so far. It is a MUST for WM sweep round 3 (`0064`) —
first free moment with a human at the keys: quake lock on click, ESC
unlock, click re-lock, VT-switch release.

**Concurrent work note**: other sessions are active on this tree
(SS-INTEROP slices per `todos/SS-INTEROP.md`). If files show uncommitted
changes you didn't make, that's them — verify todos/ freshness and stage
ONLY your own files. **Cautionary tale**: 758dd6e (a concurrent landing)
`git add`-ed os/image.json wholesale and swept 0048's in-progress
seeding + version bump into its commit. Check `git diff --cached`
against what you MEAN to land.

## The queue (todos/queue.json is authoritative)

Order + deps: `node todos/queue.js list` — do NOT copy the ordering into
this file.

## Gotchas carried forward

- **Desktop-pixel asserts must derive, not hardcode** (the 0048/0074
  lesson, three tests deep): test_wm_service_e2e.js + os-shell.mjs
  derive Start-menu/desktop-icon geometry from entry lists
  (`MENU_ENTRIES`/`DESK_ENTRIES` — when image.json gains an entry, bump
  the sorted LIST, not coordinates); os-doom.mjs derives "desktop
  restored" from pre-launch baseline signatures. os-quake still carries
  a hardcoded 5% icon allowance — has margin, owned by 0064's standing
  checklist.
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
  paths, or anything that rebakes every binary. (Last full sweep:
  2026-07-10 at the 0074 close, 14/14.)
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
