# Handoff — start of thread (updated 2026-07-10, after 0066 landed)

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Where the repo stands

**0066 (unified run/activate) landed 2026-07-10** — dev log
`logs/2026-07-10/unified-activate.md`. ONE `activate(path)` in `os/wm.c`
now serves the Start menu AND the desktop double-click (and any future
file browser — 0048): symlink → spawn its target; regular file that is
runnable → spawn directly ("runnable" = the kernel can exec it — wasm
`\0asm` or a `#!` script (0065), decided by peeking the first bytes,
mirroring `kernel.js _spawnBytes`' own dispatch; content decides, NOT
mode bits — the kernel checks no X bit); anything else → `term vi`. The
old first-line-argv menu format is DELETED (no compat branch); launchers
are ordinary `#!/bin/sh` scripts. Its one seeded user,
`/usr/share/menu/snake`, became `#!/bin/sh\nterm snake\n` in image.json.

**Image bumped v35 → v36** (menu/snake content + the wm binary changed);
`os/os-system.img` rebaked via `node tools/mkimage.js`.

**Suites this session**: kernel — ALL files pass (test_wm_service_e2e.js
grew a 0066 section: a runtime-dropped `#!/bin/sh` desktop launcher
spawns winbox +1, notes.txt still opens the viewer (term +1), an
/etc/menu launcher script launches identically from the Start menu, and
seeded menu/snake starts `#!`); blockfs 12/12; browser subset serial —
os-boots / os-shell / os-wm PASS (menu still 9 entries, same names —
the 150x188+0+552 constants hold). Unit suite not re-run:
compiler.js/host.js/kernel.js untouched (os/wm.c + image.json + tests +
docs only).

**Concurrent landing mid-thread**: `dec3424` (todos queue
single-sourcing — per-item `- **Depends**:` lines stripped, README
*Next up* enumeration deleted; queue.json is the ONLY order/dep source,
`queue.js list` the view). Leftover spotted, NOT fixed (their scope):
`todos/README.md` "Conventions" still tells you to keep "this README's
*Next up* list" in sync — that list no longer exists.

**Still owed from 0039**: the pointer-lock HUMAN check was deferred by
ALL sweep rounds so far. It is a MUST for WM sweep round 3 (`0064`) —
first free moment with a human at the keys: quake lock on click, ESC
unlock, click re-lock, VT-switch release.

**Concurrent work note**: other sessions are active on this tree
(SS-INTEROP slices per `todos/SS-INTEROP.md`; the queue tooling landed
mid-thread here). If files show uncommitted changes you didn't make,
that's them — verify todos/ freshness and stage ONLY your own files.

## The queue (todos/queue.json is authoritative)

Order + deps: `node todos/queue.js list` — do NOT copy the ordering into
this file (hand-copied roadmaps drift; the 2026-07-10 single-source
change deleted the README's for exactly that). Immediate context only:
`0066` is done; `0067` desktop drag-drop is now unblocked (dropping a
file onto the desktop = putting a file in /root/Desktop, and 0066's
activate() already runs whatever lands there).

## Gotchas carried forward

- **0066**: `activate()` does its own lstat (the entry array is a stale
  UI snapshot; `menu_ent.is_link` survives for icon drawing only). The
  runnable peek is fopen/fread of the first 4 bytes — keep it matching
  kernel.js `_spawnBytes` (`#!` on ≥2 bytes, `\0asm` on ≥4). The e2e's
  window-count deltas cross-check the peek direction (a misfire flips
  which window type appears) — don't weaken them to `>=`. The 0066 legs
  hardcode /root/Desktop icon indices (alauncher=0 y=48, notes.txt=3
  y=240 — sorted against the four seeded links) and reuse `$TSID`/`$DSID`
  captured much earlier in the script.
- **0065**: shebang optarg is ONE argument (no word splitting) — don't
  "fix" that; it's Linux semantics and the -e leg depends on it. Depth
  rides a `_spawn` parameter, NOT the spec (RPC specs are
  process-supplied input). hush in our build has NO ENOEXEC
  run-as-script fallback (`execvp_or_die` perrors + exit 2); the
  os_boot shebang leg asserts `loop-rc=2` as the tripwire for busybox
  bumps.
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
  entry indices AND the box — NINE entries (ctldemo sorts first),
  150x188+0+552, winbox click row y=174. `test_wm_service_e2e.js` +
  `os-shell.mjs` hardcode both; update them with any future entry.
- **0057**: `os/win32/lib.json` include ORDER is load-bearing —
  `vendor/freetype/demo` must precede `vendor/freetype/include`. Every
  gdi32 write forces alpha 0xFF. COLORREF needs no swizzle against the
  surface; DIBs do (B,G,R,X). `test_gdi32_e2e.js` probe coordinates
  MIRROR `gdidemo.c draw_scene`; `test_user32_e2e.js` + `os-user32.mjs`
  MIRROR `ctldemo.c` WM_CREATE layout — change together.
- **Editing seeded sources or coreutils.json/bin.json/lib.json requires
  bumping `os/image.json` `version`** (now 36) — a same-version blob is
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
  (0066 touched no libc.)
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
  (0058); wm.c is_runnable ↔ kernel.js _spawnBytes dispatch (0066).
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
  gold-plate), 0065's ENOEXEC-not-ELOOP + one-optarg calls, and 0066's
  no-compat-branch call (launchers are ordinary `#!` scripts; the
  first-line-argv menu format is gone for good).

## Suggested opening for the new thread

"Read HANDOFF.md, then give me a one-paragraph status and ask what I want
to tackle: 0067 desktop drag-drop, standing up 0060's port harness early,
0046 strace, or something else."
