# Handoff — start of thread (updated 2026-07-10, after 0065 landed)

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Where the repo stands

**0065 (shebang `#!` exec) landed 2026-07-10** — dev log
`logs/2026-07-10/shebang-exec.md`, design note in `todos/KERNEL.md`
"The spawn path: shebang exec". `kernel.js _spawnBytes` peeks the image
before the wasm compile; `#!` bytes re-dispatch via the new
`_spawnShebang` with execve(2) semantics: interpreter + at most ONE
optional arg (rest of line verbatim, 256-byte budget), argv =
`[interp, optarg?, scriptPath, ...origArgv[1:]]` (script path replaces
the caller's argv[0]), envp/cwd/fd-actions/pgroup carry over, relative
interpreter resolves against the child's cwd, depth-4 chain cap →
**ENOEXEC** (deliberate: the libc has no ELOOP and host.js's errnoMap
throws on unknown names). The check runs BEFORE the module cache, so
scripts never allocate cache entries; non-`#!` bytes take the exact old
path. `./foo` on a `#!/bin/sh` script now just runs — the 0066 launcher
primitive.

**No image bump** (kernel-side JS only; image stays **v35**).

**Suites this session**: kernel — ALL files pass (test_kernel.js grew a
shebang section; test_os_boot.js grew a hush acceptance leg: `./foo`,
`#!/bin/sh -e`, cycle → rc 2); blockfs 12/12; unit 699/0/3 (no compiler
change); browser subset serial — os-boots / os-shell / os-wm PASS (only
the spawn path changed; the two-byte peek can't affect wasm binaries, so
the full sweep wasn't re-run).

**Gotcha recorded for busybox bumps**: hush in our build has NO ENOEXEC
run-as-script fallback (`execvp_or_die` just perrors + exit 2). The
os_boot shebang leg asserts `loop-rc=2`; if a busybox upgrade grows the
fallback, that leg is the tripwire.

**Still owed from 0039**: the pointer-lock HUMAN check was deferred by
ALL sweep rounds so far. It is a MUST for WM sweep round 3 (`0064`) —
first free moment with a human at the keys: quake lock on click, ESC
unlock, click re-lock, VT-switch release.

**Concurrent work note**: another session may be landing SS-INTEROP
slices (`todos/SS-INTEROP.md`, host.js .ss-module support). If host.js
shows uncommitted changes you didn't make, that's them — stage only your
own files.

## The queue (todos/queue.json is authoritative)

Order + deps: `node todos/queue.js list` — do NOT copy the ordering into
this file (hand-copied roadmaps drift; the 2026-07-10 single-source
change deleted the README's for exactly that). Immediate context only:
`0066` unified run/activate is in flight, unblocked by 0065's shebang
exec (ONE `activate(path)` in wm.c for desktop dbl-click + Start menu;
peek `\0asm`/`#!` to decide runnable; launchers = executable scripts).

## Gotchas carried forward

- **0065**: shebang optarg is ONE argument (no word splitting) — don't
  "fix" that; it's Linux semantics and the -e leg depends on it. Depth
  rides a `_spawn` parameter, NOT the spec (RPC specs are
  process-supplied input).
- **0058**: the agent protocol is one request per connection (the app
  closes after replying — wmctl must not hold the socket open). The
  scrollbar control NEVER moves itself: it notifies WM_V/HSCROLL and the
  app calls SetScrollPos (ported apps double-step otherwise). MSG has no
  spare field, so the SDL keysym rides a side slot in user32's queue;
  GetMessage stashes it for the NEXT TranslateMessage — fine for the
  sequential loop, don't reorder. `wmctl click <label>` vs
  `click SID X Y` disambiguates on argc==3 + non-numeric argv[2].
  Kernel close lands on the FIRST live top-level (the ring QUIT record
  is process-wide — per-window routing = push-export ABI change = libc
  rebake; 0060 item). Test sections in test_user32_e2e.js cut at
  explicit `==cut` echoes because tree dumps contain `== pid` lines.
- **Start-menu geometry** (again): a new `/usr/share/menu` entry changes
  entry indices AND the box — now NINE entries (ctldemo sorts first),
  150x188+0+552, winbox click row y=174. `test_wm_service_e2e.js` +
  `os-shell.mjs` hardcode both; update them with any future entry.
- **0057**: `os/win32/lib.json` include ORDER is load-bearing —
  `vendor/freetype/demo` must precede `vendor/freetype/include`. Every
  gdi32 write forces alpha 0xFF. COLORREF needs no swizzle against the
  surface; DIBs do (B,G,R,X). `test_gdi32_e2e.js` probe coordinates
  MIRROR `gdidemo.c draw_scene`; `test_user32_e2e.js` + `os-user32.mjs`
  MIRROR `ctldemo.c` WM_CREATE layout — change together.
- **Editing seeded sources or coreutils.json/bin.json/lib.json requires
  bumping `os/image.json` `version`** (now 35) — a same-version blob is
  reused, and a LIBC change in compiler.js counts (baked binaries) —
  rebake `os/os-system.img` with `node tools/mkimage.js` after.
- Queue changes go through `node todos/queue.js` ONLY (`done`, `add`,
  `reorder`); `check` must pass before committing (pre-commit hook
  enforces it once `git config core.hooksPath todos/githooks` is set).
- **0055**: `copyExternalImageToTexture` destinations need
  `RENDER_ATTACHMENT` usage besides COPY_DST/TEXTURE_BINDING. WebGPU
  needs a secure context; boot REQUIRES worker WebGPU: browser os tests
  launch Chromium with `--enable-unsafe-webgpu --enable-features=Vulkan`.
- **`ls /` goldens include `proc`** (test_os_boot.js, os-boots.mjs):
  `bin dev etc proc root run tmp usr var`.
- 0043: ProcFS must implement the FULL MountFS op surface — a new fs op
  added to MountFS needs a ProcFS twin (EROFS for mutators). procps
  parsers are single-read (1023 bytes) — keep per-file content < 1 KiB.
- 0037: when touching the spawn path, remember exactly ONE of
  `procSpec.image`/`procSpec.module` is non-null; compile options MUST
  MATCH between host.js runModule and kernel.js `_moduleFor`.
- REPL-over-pty framing (0036): micropython emits `\r\n` itself and
  ONLCR doubles the `\r`; sqlite3 on a tty defaults to box-drawn tables;
  don't anchor pty markers on `\r\n` seams across multi-line writes.
- 0034/0035/0043 busybox config decisions are recorded in
  `vendor/busybox/README.md` — don't re-litigate casually.
- 0034's three known limitations are TRACKED FIX-WORTHY in
  `todos/MISC.md` "libc / host follow-ups".
- Two unit goldens encode libc internals and move when libc changes:
  `switch_br_table` expected.compiler.stderr and `printf`'s
  pointer-address line. Verify the tests' OWN asserts before updating.
  (0065 touched no libc — suite stayed 699/0/3.)
- **0040 layout in tests**: headless images pair as `foo-system.img` +
  `foo-root.img`; OPFS names `os-system.v5.img`/`os-root.v5.img` — those
  names are ALSO the Web Lock name (0045): renaming the images renames
  the lock with them (kernel-worker.js consts, single point).
- Browser pixel tests: "empty desktop" asserts must tolerate the icon
  grid; desktop teal == compositor teal; SETTLE after VT switch; derive
  geometry from `__osScreen`/live canvas rect; keep the sweep serial;
  `cmd &; echo` is a hush parse error; `__osScreen` only tracks the
  viewport while VT2 is visible. A SECOND page needs a fresh
  context/browser (the 0045 boot lock).
- hush `kill` is cooperative SIGTERM: barrier on surfaces vanishing
  before asserting no-WM behavior.
- The IDE's clangd flags os/*.c, os/win32/*.c and vendor busybox/SDL
  sources — noise; those headers are compiler.js built-ins or
  project-include-path resolved.

## Conventions to keep

- Queue discipline: work = `todos/NNNN`, done → `todos/done/` via
  `node todos/queue.js done NNNN`, dev log per landing. Order and dep
  ids live ONLY in queue.json (`queue.js add/reorder/block`): no
  hand-written roadmap lists anywhere, no `- **Depends**:` lines in open
  items (`queue.js check` lints against them; rationale = body prose).
- compiler.js must stay browser-clean (no bare `process.*`).
- Fix bugs test-first: failing test commit, then the fix.
- MUST-MATCH blocks: WM protocol kernel.js ↔ os/wm_proto.h ↔
  test_wm_policy.js; the agent protocol os/wm_agent.h ↔
  os/win32/user32.c ↔ os/wmctl.c (0058); surface/ring layout kernel.js
  ↔ host.js (incl. the IR_WPOS notify contract, 0058); WMEV ↔ <SDL3> ↔
  host.js; audio ring kernel.js ↔ host.js; SDL audio format words ↔
  <SDL3/SDL_audio.h>; SI_* tty header kernel.js ↔ host.js; sealed-blob
  superblock fields host.js ↔ tests/blockfs/fsck_v4.js; wasm compile
  options host.js runModule ↔ kernel.js _moduleFor (0037);
  <sys/time.h> ITIMER_* ↔ kernel.js ITIMER_REAL (0044);
  test_gdi32_e2e.js/os-gdi.mjs probes ↔ os/win32/gdidemo.c draw_scene
  (0057); test_user32_e2e.js/os-user32.mjs ↔ os/win32/ctldemo.c layout
  (0058).
- `tests/browser/os-*.mjs` are manual — run the full sweep serially
  after touching os/, kernel.js, host.js SDL/webgpu/fd/audio/input/tty
  paths, or anything that rebakes every binary (a libc/codegen change
  does). The sweep now includes `os-gdi.mjs` + `os-user32.mjs`.
- Don't re-litigate: posix_spawn-not-fork, kernel-owned fds, WM.md's
  invariants, 0013–0058's decisions, DISK-IMAGE.md's settled layout,
  0045's no-steal/no-SharedWorker calls, 0036's minimal-port-mp scope,
  0037's RO-volume-only cache policy, 0043's synthetic-values-by-design,
  0044's no-VIRTUAL/PROF and cooperative-SIGALRM calls, 0055's
  no-fallback calls, WIN32.md's Win32-as-primary-toolkit decision
  (microui/MVU are DROPPED), 0057's recorded simplifications, 0058's
  (scrollbar notify-only, one-request-per-connection agent protocol,
  process-wide kernel close — grow via 0060's missing-symbol log, don't
  gold-plate), and 0065's ENOEXEC-not-ELOOP + one-optarg calls.

## Suggested opening for the new thread

"Read HANDOFF.md, then give me a one-paragraph status and ask what I want
to tackle: 0066 unified run/activate, standing up 0060's port harness
early, 0046 strace, or something else."
