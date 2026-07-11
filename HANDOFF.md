# Handoff — start of thread (updated 2026-07-11; 0106 navigator v2 closed)

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Where the repo stands

**0106 (fileman navigator v2) is CLOSED.** fileman is now an Explorer-shaped
navigator: details columns, a status strip, real multi-select, Enter/
Backspace, F5, the View toggles, and Alt+Left back history. Dev log
`logs/2026-07-11/0106-fileman-navigator-v2.md`; item at
`todos/done/0106-fileman-navigator-v2.md`. **Not yet committed** — commit +
push are the next action (see below).

One breath: the LISTBOX in the user32 veneer grew **LBS_EXTENDEDSEL** (a
selection SET alongside the caret — Ctrl-click / Shift-range / Ctrl+A, the
`LB_GETSEL/SETSEL/GETSELCOUNT/GETSELITEMS` surface); fileman's cut/copy/
delete now act on the whole set. The details rows come off the same
`refill` stat (size/`<DIR>` + mtime, mono space-padded), a bottom STATIC
strip counts objects + the selection, and the message loop handles the
navigator chords.

- `os/win32/user32.c` — the extended-select LISTBOX (marks array + anchor;
  single-select consumers untouched — they return `LB_ERR` for the new
  messages and their e2es pass).
- `os/win32/fileman.c` — `g_ents[]` details model (row ops resolve through
  it, NOT the display string), status strip, multi-aware ops, Enter/
  Backspace/F5/Alt+Left, and the View toggles (Sort by Name/Size/Date +
  Reverse + Show Hidden) as **pane-context-menu items**.
- `os/win32/include/windows.h` — the new LBS_/LB_ constants.
- `os/image.json` — `version` → **66** (fileman.c/user32.c/windows.h are
  bake inputs).

**Design call worth knowing**: the View controls are context-menu items,
NOT a window menu bar. A real menu bar (`MENU_BAR_H = 20`) shifts the
top-level client origin and would break the 0092/0093 tests' hardcoded
right-click surface coords (`100 30` = row 0). Context-menu items are
equally agent-drivable and v1-honest.

**Verified** (all headless kernel e2es PASS): new
`tests/kernel/test_fileman_nav_e2e.js` (17 checks — columns, Ctrl-click +
Shift-range multi-select, multi-delete, Enter/Backspace, F5-after-touch,
Sort by Size, Show Hidden, Alt+Left) + regression on
`test_fileman_e2e` (listing regex relaxed for the columns),
`test_fileman_ops_e2e`, `test_recycle_e2e`, `test_user32_e2e`,
`test_openwith_e2e`, `test_ctlpanel_e2e`, `test_winmine_e2e`,
`test_notepad_e2e` (the comdlg single-select listbox). `node
todos/queue.js check` passes.

**Follow-up filed** (named in 0106's Status): **0123** (P3) — the *optional*
unprompted auto-refresh (poll the cwd mtime off the 500ms reap timer), the
one deliberately-optional half of 0106 left unbuilt (F5 covers the need).

## To commit (this thread's work, uncommitted in the tree)

`os/image.json`, `os/win32/fileman.c`, `os/win32/include/windows.h`,
`os/win32/user32.c`, `tests/browser/os-fileman.mjs`, `tests/kernel/run.js`,
`tests/kernel/test_fileman_e2e.js`, `tests/kernel/test_fileman_nav_e2e.js`
(new), the 0106 done-file move + Status edit (**already re-staged** —
`queue.js done` staged the pre-edit blob), `todos/queue.json` (0106
dropped), `todos/0123-*.md` (new), `logs/2026-07-11/0106-fileman-navigator-
v2.md` (new). Then push to main (user asked to commit + push if testing
looked good — it did).

## Operator-owed (browser)

`os-fileman.mjs` grew a **Ctrl-click multi-select + Del** leg, but Playwright
isn't installed in-repo, so it's UNRUN here — run it in the browser sweep
(`node tests/browser/os-sweep.mjs --filter=fileman`). This joins the standing
0064 browser-leg debt (0094 sound listen, 0095 snap feel, 0096 saver eyeball,
0101–0105 legs, the pointer-lock human check).

## Gotchas carried forward (trimmed to the live ones)

- **fileman details rows put NAME first**: agent tests read the LISTBOX via
  WM_GETTEXT and `includes()` name substrings — those survive the columns.
  Only `test_fileman_e2e`'s ONE contiguous listing regex needed relaxing.
  The tree dump CAPS item text, so column-widened rows truncate earlier —
  anchor assertions on the first few rows, not deep ones.
- **user32 LISTBOX caret vs. SET**: `LB_SETCURSEL` in extended mode moves
  only the caret; the selection lives in `marks` (`LB_SETSEL`). Don't
  "fix" SETCURSEL to also select — fileman's right-click relies on the
  split to keep a multi-selection when you right-click inside it.
- **Modifiers on injected input**: `wmctl click` (INJECT_POINTER) doesn't
  carry mods — set `g_mod` first with `wmctl keydown $SID 224 1073742048 64`
  (LCTRL) / release after. `wmctl key` DOES take a trailing mod arg (pass it
  on the key itself, e.g. Alt+Left = `wmctl key $SID 80 1073741904 256`).
- **`queue.js done` can stage a PRE-EDIT blob** of the done file — after
  `done`, `git add todos/done/<file>` again (hit + fixed this session).
  **Concurrent sessions exist: stage ONLY your own files.**
- **Don't edit bake inputs while a suite runs** (0082): `.md`/`tests/` are
  NOT inputs; `os/*.c/.h/.json/.rc`, `compiler.js`, `host.js`, `vendor/`
  are. Bump `image.json` `version` (now **66**) when seeded-source edits
  must reach a persistent browser OPFS image.
- **New kernel test files must be added to `tests` in run.js** (did so for
  test_fileman_nav_e2e.js). Check `build/test-*/summary.json` + per-file
  logs after an interrupted run; `--resume` picks up.
- Queue changes via `node todos/queue.js` ONLY; `check` must pass before
  committing. List order is PRIORITY-BUCKETED (P0–P3).
- **0055**: boot REQUIRES worker WebGPU; browser os tests launch Chromium
  with `--enable-unsafe-webgpu --enable-features=Vulkan`.

## Next in queue

`node todos/queue.js list` — after 0106: **0107** (desktop-icon
details/multi-select tail — the wm.c half), **0112**, then the P1 body
(0088, 0079/0080, 0052/0053, …). This thread's follow-up **0123** (P3) trails
at the end. The 0064 WM sweep round 3 still owes the operator the pointer-lock
human check and the 0094/0095/0096/0101–0105 + 0106 browser legs.

## Don't re-litigate

posix_spawn-not-fork; kernel-owned fds; WM.md invariants; DISK-IMAGE.md's
settled layout; 0013–0105's recorded decisions (see todos/done/); **0106's
calls (details columns store name-first for agent readback; extended-sel
caret/SET split in user32; View as context-menu items not a menu bar —
geometry coupling; multi-delete singular wording kept byte-identical for
n==1)**.

## Suggested opening for the new thread

"Read HANDOFF.md, then give me a one-paragraph status and ask what I want to
tackle — `node todos/queue.js list` for the order (0106 fileman navigator v2
just landed — commit + push it first if not already done; then 0107
desktop-icon details/multi-select, 0112). 0064 WM sweep round 3 still owes the
operator the pointer-lock check and the 0094/0095/0096/0101–0106 browser legs."
