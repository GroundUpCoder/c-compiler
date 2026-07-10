# Handoff — start of thread (updated 2026-07-10, after 0060 landed)

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Where the repo stands

**0060 (Win32 port corpus + compile-test harness) landed 2026-07-10** —
dev log `logs/2026-07-10/win32-port-corpus.md`. Vendored ReactOS
winmine/notepad/calc (@1a706d7, UNICODE builds; per-dir READMEs pin the
commit + patch tables — only `L"…"`→`u"…"`). `tools/win32ports.js`
compile-tests every `os/win32/ports.json` target against the veneer and
writes `os/win32/PORTS.md` — 175 distinct missing symbols, THE
authoritative 0059+ backlog (implement to it, not to speculation). The
trio deliberately stops at the link stage and is NOT seeded into the OS
image; gdidemo/ctldemo are the harness's zero-missing control targets.
sol excluded (C++); metapad/PuTTY are future corpus rungs. The A/W split
landed as header architecture (see below). Control-app wasm verified
byte-identical → **no image bump, v36 stands**, no browser sweep needed.

**Suites this session**: `tools/win32ports.js --check` green (also
negative-tested), new `tests/kernel/test_win32_ports.js` wired into the
kernel runner; test_gdi32_e2e / test_user32_e2e / test_os_boot PASS; full
kernel suite run at the end.

**Next in queue**: `0059` (kernel32 over POSIX — PORTS.md's aggregate
table is its order of attack) and `0048` (file browser) both unblocked.

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

- **0060 A/W architecture** (windows.h header comment is the canonical
  text): implemented functions ARE the ANSI generic names; gdi32.c/
  user32.c `#undef UNICODE` at the top — keep that in any new veneer .c;
  W variants are declared; generic→W `#define`s sit at the END of
  windows.h (after all generic-token uses — order is load-bearing); the
  A-alias block is `#ifndef UNICODE`-guarded (else TextOutA chains to
  TextOutW). `VOID` is a MACRO, not a typedef (ReactOS `Fn(VOID)` needs
  the (void) special case). WCHAR = 2-byte UTF-16: `u"…"` literals /
  TEXT() pastes the u prefix; bare `L"…"` fails to typecheck BY DESIGN
  (libc wchar_t is 4-byte) — patch corpus occurrences to `u"…"` and log
  them in the vendor README patch table. 16-bit wide CRT = the `_tcs*`
  names as REAL symbols (tchar.h explains why not wcslen).
- **0060 harness**: PORTS.md is generated — never hand-edit; regenerate
  with `node tools/win32ports.js` after touching os/win32 headers, the
  veneer, or a vendored port (the kernel suite's test_win32_ports.js
  fails on a stale report). Growing the corpus = vendor dir + bin.json
  (UNICODE/_UNICODE/__REACTOS__ defines; calc also needs __GNUC__=4 for
  ULL-vs-UI64 literal arms) + a ports.json entry with expect:
  missing-symbols. Implicit-decl logging does NOT work (zero-arg typed) —
  declare the surface properly in headers instead.
- **0060 vendor deps direction**: the corpus bin.jsons dep on
  `../../os/win32/lib.json` — vendor→os is fine (it's the toolkit), and
  buildProject's normalize handles the ../.. hop.
- **0067**: kernel-worker's `kfs` is a WORKER GLOBAL assigned in
  `boot()` — don't re-`var` it there. os-drop.mjs derives icon-cell rows
  from sort order — a new seeded /root/Desktop entry shifts every cell
  index in that test.
- **0066**: `activate()` does its own lstat; the runnable peek is
  fopen/fread of the first 4 bytes — keep it matching kernel.js
  `_spawnBytes` (`#!` on ≥2 bytes, `\0asm` on ≥4). The e2e's window-count
  deltas cross-check the peek direction — don't weaken to `>=`. The 0066
  legs hardcode /root/Desktop icon indices and reuse `$TSID`/`$DSID`.
- **0065**: shebang optarg is ONE argument (Linux semantics; the -e leg
  depends on it). Depth rides a `_spawn` parameter, NOT the spec. hush
  has NO ENOEXEC run-as-script fallback; os_boot asserts `loop-rc=2` as
  the busybox-bump tripwire.
- **0058**: agent protocol is one request per connection. The scrollbar
  control NEVER moves itself (notify-only). MSG has no spare field —
  the SDL keysym rides a side slot; don't reorder GetMessage/
  TranslateMessage. Kernel close lands on the FIRST live top-level.
  test_user32_e2e.js sections cut at explicit `==cut` echoes.
- **Start-menu geometry**: NINE entries (ctldemo sorts first),
  150x188+0+552, winbox click row y=174 — `test_wm_service_e2e.js` +
  `os-shell.mjs` hardcode both; update with any new menu entry.
- **0057**: `os/win32/lib.json` include ORDER is load-bearing
  (freetype/demo before freetype/include). Every gdi32 write forces
  alpha 0xFF. test_gdi32_e2e.js probes MIRROR gdidemo.c draw_scene;
  test_user32_e2e.js + os-user32.mjs MIRROR ctldemo.c layout.
- **Editing seeded sources or coreutils.json/bin.json/lib.json requires
  bumping `os/image.json` `version`** (still 36 — 0060 verified its
  binaries byte-identical, so no bump) — rebake `os/os-system.img` with
  `node tools/mkimage.js` after a real change. A LIBC change in
  compiler.js counts (baked binaries).
- Queue changes go through `node todos/queue.js` ONLY; `check` must pass
  before committing. After `queue.js done`, check `git status` — the
  internal git-mv can stage a pre-edit blob (re-`git add` the done file).
- **0055**: WebGPU needs a secure context; boot REQUIRES worker WebGPU:
  browser os tests launch Chromium with `--enable-unsafe-webgpu
  --enable-features=Vulkan`.
- **`ls /` goldens include `proc`**: `bin dev etc proc root run tmp usr
  var`.
- 0043: ProcFS must implement the FULL MountFS op surface; keep per-file
  /proc content < 1 KiB (single-read parsers).
- 0037: exactly ONE of `procSpec.image`/`procSpec.module` is non-null;
  compile options MUST MATCH host.js runModule ↔ kernel.js `_moduleFor`.
- REPL-over-pty framing (0036): micropython emits `\r\n` itself and
  ONLCR doubles the `\r`; don't anchor pty markers on `\r\n` seams.
- Two unit goldens encode libc internals and move when libc changes:
  `switch_br_table` expected.compiler.stderr and `printf`'s
  pointer-address line. (0060 touched no libc.)
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
- The IDE's clangd flags os/*.c, os/win32/*.c (incl. the new headers)
  and vendor busybox/SDL/ReactOS sources — noise; those headers are
  compiler.js built-ins or project-include-path resolved.

## Conventions to keep

- Queue discipline: work = `todos/NNNN`, done → `todos/done/` via
  `node todos/queue.js done NNNN`, dev log per landing. Order and dep
  ids live ONLY in queue.json: no hand-written roadmap lists, no
  `- **Depends**:` lines in open items (rationale = body prose).
- compiler.js must stay browser-clean (no bare `process.*`).
- Fix bugs test-first: failing test commit, then the fix.
- MUST-MATCH blocks: WM protocol kernel.js ↔ os/wm_proto.h ↔
  test_wm_policy.js; agent protocol os/wm_agent.h ↔ os/win32/user32.c ↔
  os/wmctl.c; surface/ring layout kernel.js ↔ host.js (incl. IR_WPOS
  notify); WMEV ↔ <SDL3> ↔ host.js; audio ring kernel.js ↔ host.js;
  SI_* tty header kernel.js ↔ host.js; sealed-blob superblock host.js ↔
  fsck_v4.js; wasm compile options host.js runModule ↔ kernel.js
  _moduleFor; <sys/time.h> ITIMER_* ↔ kernel.js; test_gdi32_e2e.js/
  os-gdi.mjs ↔ gdidemo.c draw_scene; test_user32_e2e.js/os-user32.mjs ↔
  ctldemo.c layout; wm.c is_runnable ↔ kernel.js _spawnBytes (0066);
  NEW: os/win32/ports.json expects ↔ PORTS.md ↔ the harness (0060 —
  regenerate, don't hand-sync).
- `tests/browser/os-*.mjs` are manual — run the full sweep serially
  after touching os/, kernel.js, host.js SDL/webgpu/fd/audio/input/tty
  paths, or anything that rebakes every binary. (0060 did none of these
  — byte-identical binaries, sweep skipped deliberately.)
- Don't re-litigate: posix_spawn-not-fork, kernel-owned fds, WM.md's
  invariants, 0013–0058's decisions, DISK-IMAGE.md's settled layout,
  0045's no-steal/no-SharedWorker calls, 0036's minimal-port-mp scope,
  0037's RO-volume-only cache policy, 0043's synthetic-values-by-design,
  0044's no-VIRTUAL/PROF and cooperative-SIGALRM calls, 0055's
  no-fallback calls, WIN32.md's Win32-as-primary-toolkit decision
  (microui/MVU are DROPPED), 0057's recorded simplifications, 0058's
  calls (scrollbar notify-only, one-request-per-connection agent
  protocol, process-wide kernel close), 0065's ENOEXEC-not-ELOOP +
  one-optarg calls, 0066's no-compat-branch call, 0067's calls
  (never-overwrite `-N` suffix, status-line-not-tty feedback), and
  0060's calls (declaration-surface-not-implicit-decls, ANSI-generic
  implemented names + `#undef UNICODE` in veneer sources, `u"…"`-not-
  `L"…"`, `_tcs*`-as-real-symbols, corpus-stops-at-link-stage —
  implement strictly to PORTS.md demand).

## Suggested opening for the new thread

"Read HANDOFF.md, then give me a one-paragraph status and ask what I want
to tackle: 0059 kernel32 (PORTS.md is the order of attack), 0048 file
browser, 0046 strace, 0061/0062, or something else."
