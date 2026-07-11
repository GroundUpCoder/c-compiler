# Handoff — start of thread (updated 2026-07-11; 0108 openwith test rot closed)

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Where the repo stands

**0108 (test_openwith_e2e rot) is CLOSED**; no image change (still
**v54** — the fix touched only tests/docs). Dev log
`logs/2026-07-11/0108-openwith-test-rot.md`; item at
`todos/done/0108-openwith-e2e-rot.md`. What landed:

- **Realigned the test to the seed** (`os/image.json` is the truth;
  `7f6d3c0` flipped `.gb`/`.gbc` → `/bin/sameboy` after 0075's initial
  keep-gameboy call): the `.gb` legs expect `SameBoy`-titled windows,
  conf1 carries `gb\t/bin/sameboy` + `gbc\t/bin/sameboy` forward. The
  test's minimal 0x150-byte cartridge works under SameBoy unchanged
  (logo + header checksum satisfy the embedded boot ROM; the 0xFF bank
  pad RST $38-loops forever, so the window stays up).
- **Registered it in the run.js MANIFEST** (`['test_openwith_e2e.js',
  IMG]`, after test_fileman_e2e) — it was the ONLY orphan in
  `tests/kernel/` (swept `ls test_*.js` vs the manifest).
- **Doc drift fixed at the durable copies**: run.js's test_sameboy_e2e
  comment (said "gameboy stays the .gb default" while that very test
  asserts sameboy) and CLAUDE.md's two spots (vendor list, openwith
  seed). Historical dev logs left as written.

**Verified**: baseline reproduced exactly the item's 3 failures;
post-fix standalone ALL OK (15 checks), `run.js --filter=openwith`
passes, **full kernel suite 50/50 green** (223.5s).

**Follow-up filed by 0108 — 0111** (slotted after 0106, the fileman
cluster): kernel32's `proc_info_init` quotes only cmdline args WITH
SPACES, so notepad's `lpCmdLine` gets a bare `/root/...`; ReactOS
`HandleCommandLine` eats `/r` as an option flag → **every openwith
`default.gui → /bin/notepad` open shows an "does not exist / create?"
ERROR box + an Untitled window** (verified in-source and in the window
list). Preferred fix in the item: quote EVERY arg (Windows-canonical),
audit CreateProcess's tokenizer round-trip, then tighten
test_openwith_e2e's deliberately-loose `/Notepad$/` check to
`readme.md - Notepad` + no-ERROR-window.

**Next in queue**: `node todos/queue.js list` — **0094 (sound scheme)**
leads, then 0095 (Aero Snap), 0096 (screensaver), 0098 (Start menu Win7
pane), 0101 (taskbar-strip menu), 0102 (window system menu), 0103
(desktop-icon rename), 0104, 0105, 0106 (fileman navigator v2), 0111
(win32 cmdline abs-path), 0107, … 0109 (after 0103), 0110 (after 0109).
**Do NOT pipe `queue.js list` through `head`** — EPIPE crash (known,
harmless, noisy).

**Still owed from 0039**: the pointer-lock HUMAN check — deferred by ALL
sweep rounds, a MUST for WM sweep round 3 (`0064`), which also carries
the 0063 aero aesthetics + glass perf eyeball.

## Gotchas carried forward (trimmed to the live ones)

- **0108 NEW: `queue.js add --help` really does add an "untitled" item**
  (I hit it this thread; undo = `git checkout todos/queue.json` + rm the
  scaffold BEFORE anything else touches the queue; the flag fix is 0099).
- **0108 NEW: the openwith default.gui leg is loose on purpose** —
  `/Notepad$/` only guards launch; the file-load half is broken until
  0111 (don't "fix" the test to pass differently, fix the veneer).
- **0093: the Recycle Bin icon sorts LAST on the desktop** (entcmp
  special case) — tests asserting the LAST cell or a full grid must
  count the bin (os-drop.mjs's `BIN` const). Seeded desktop = 8 icons.
- **0093: fileman listings hide dotfiles** — drive tests into dot dirs
  by `wmctl settext EDIT:0 <path>` + Go, never by clicking rows.
- **0093: trash-vs-permanent is told by confirm WORDING** ("send 'x' to
  the Recycle Bin?" vs "delete 'x'?"); titles stay "Confirm File/Folder
  Delete".
- **0092: the fileman ops core is `os/fileops.h`** — a new file op goes
  THERE. Clipboard file list = format 2 on the 0090 slot;
  last-write-wins across formats.
- **0092: AQ_CLICK prefers an ENABLED match** — modal-over-modal is
  drivable; gettext/settext still find disabled controls.
- **0092: real-browser right-click row selection is imprecise** — drive
  row-precise ops through `wmctl click $SID x y 3`, verify fs via VT1.
- **0091: `wmctl list` is Z-ORDERED** — pick rows by sid. `wmctl tree`
  lists menu BARS before the `popupmenu` section.
- **0091: browser popup tests must quiesce ~1.5s after the VT2 settle** —
  a late EV_SCREEN dismisses popups.
- **0090: browser keyboard pacing** — type with `{delay: 50-60}`; chords
  as explicit down/gap/press/gap/up. Headless `wmctl key` is immune.
- **0089 browser-test traps:** (1) `waitForFunction(__osOut.includes(…))`
  fires on the TYPED COMMAND'S ECHO — emit markers with a split quote
  (`echo CP-U""P`). (2) Typing right after a `&` job races hush's job
  notice — `waitForTimeout(800)` first. (3) Typing right after ANY
  `$(wmctl …)` substitution races the prompt the same way — pause ~800ms
  after every typed shell line that runs a command.
- **0077: icon tile white ring is 6px; probe `(ix+2, iy+2)`**. Successive
  same-icon `wmctl click`s pair into a double-click — `sleep 0.6` between.
- **`queue.js done` can stage a PRE-EDIT blob** of the done file — after
  `done`, `git add todos/done/<file>` again (`git show :todos/done/<file>`
  to confirm). Stage ONLY your own files; concurrent sessions exist.
- **0041: all global imports before any defined global** — register new
  imported-global features in generateCode's pre-scan region.
- **Don't edit bake inputs while a suite runs** (0082): `.md` and `tests/`
  are NOT inputs; `os/*.c/.h/.json`, `compiler.js`, `host.js`, `vendor/`
  are. Bump `image.json` `version` (now **54**) when an interactive
  browser tab must pick up seeded-source edits. Delete `os/os-system.img`
  + `os/os-root.img` to force a rebake after a shared-source change
  (user32, fileops.h, etc.) or the fixture serves a stale binary.
- **New-runner habits**: check `build/test-*/summary.json` (`status:
  'pass'`) + per-file logs after an interrupted run; `--resume` picks up.
  Sweep is serial by design (0045). The kernel runner is a MANIFEST —
  new test files must be added to `tests` in run.js or they silently
  never run (0108 was exactly this; the orphan sweep is now part of any
  new-test review).
- Queue changes via `node todos/queue.js` ONLY; `check` must pass before
  committing.
- **0055**: boot REQUIRES worker WebGPU; browser os tests launch Chromium
  with `--enable-unsafe-webgpu --enable-features=Vulkan`.
- The IDE's clangd flags os/*.c, os/win32/*.c and vendor sources — noise;
  headers are compiler.js built-ins or include-path resolved.
- For the long tail (WRES v2, argv0, TrackPopupMenu coords, 0069 unmapped
  semantics, MAKEINTRESOURCE stack caveat, shebang one-optarg, 0040 image
  pairing, MUST-MATCH block list): see `todos/done/0048`'s Status,
  `logs/2026-07-10/0048-closeout.md`, and the CLAUDE.md sections — the
  durable copies.

## Don't re-litigate

posix_spawn-not-fork; kernel-owned fds; WM.md invariants; 0013–0093's
recorded decisions (see todos/done/); DISK-IMAGE.md's settled layout;
0090's calls (the clipboard is a KERNEL slot — one slot, no history,
last-write-wins, format-tagged); 0091's calls (fixed item lists NOT
directory scans; ONE flyout depth; gray rows never fire); 0092's calls
(ops core header-only + shared; format-2 textual CF_HDROP; SHFile*
veneer-local; move refuses EEXIST; DnD = non-goal); 0093's calls (trash
store = `/root/.recycle` files/+info/ textual sidecars; delete-in-store
is PERMANENT; the bin icon is a real launcher pinned to the grid TAIL;
no quota/auto-purge; no /usr trashing; wm.c confirms → 0110, fileman
dotfile toggle → 0106); **0108's call (sameboy IS the baked .gb/.gbc
default — `os/image.json` is the truth over any stale prose; gameboy
stays installed as the lighter alternate core)**.

## Suggested opening for the new thread

"Read HANDOFF.md, then give me a one-paragraph status and ask what I want
to tackle — `node todos/queue.js list` for the order (0094 sound scheme
leads, then 0095/0096/0098, 0101–0106, 0111, 0107, 0109–0110; 0064 WM
sweep round 3 still owes the pointer-lock human check)."
