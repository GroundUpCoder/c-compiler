# Batch K — #9 comdlg32 honesty, #99 listdir fold, #101 boot guard, #546 sweep ports, #40 clang browser boot

Five light P2 tickets, one lane, one full gate. The batch's theme turned out
to be *stale premises*: three of the five tickets described a tree that had
since moved, and the real work was the measured delta.

## #9 — comdlg32 silent no-ops (0145)

Most of the ticket's 2026-07-12 premise had already been fixed by later work
it predates:

- **Format→Font is REAL ChooseFontW** (todos/0223) — not a stub. Untouched
  here (and #330's style axis deliberately NOT absorbed).
- **The win32rc `\r` escape bug is fixed** (`tools/win32rc.js` tokenizer
  handles `\r` + normalizes `\r\n`; `test_notepad_menu_e2e.js` pins
  'Palamarchuk' intact).
- **Print/Page Setup already report loudly** via `WIN32_UNSUPPORTED` (0211).

The genuine remaining delta, landed here:

- `WIN32_UNSUPPORTED` writes to **stderr, which a GUI user clicking a menu
  cannot see** — the click was still a silent no-op *for the user*. Print /
  Page Setup now raise a "There is no printing subsystem in this build."
  MessageBox before the honest FALSE. `PD_RETURNDEFAULT`/`PSD_RETURNDEFAULT`
  (new defines) keep the promised no-UI query forms quiet — popping UI from
  a call that promised none would be worse than the silence.
- The folded-in gap-inventory items got their report-once treatment:
  SND_RESOURCE silent success (winmm.c, gap #13), OFN hook/template not run,
  Find/Replace forced-down direction, CommDlgExtendedError always 0
  (gap #14). Decisions unchanged; they are now *named at runtime*.
- Tests: notepad menu e2e drives both notice boxes and asserts them + the
  Save-As-has-no-COMBOBOX guard (a future hook impl must arrive with tests)
  + the OFN/FR report lines; winmine e2e enables Options▸Sound so the first
  reveal hits SND_RESOURCE and asserts the report. WIN32.md updated.

## #99 — CD34 fold (0291)

Premise verified true: 0250/0259 are closed, `listdir.h` still deferred to
them. Equivalence audit of `wm.c load_entries` vs `list_dir`: dotfile policy
(always hide) == `LIST_HIDE_DOTFILES`; link-to-dir cascade == the exact case
`LIST_FOLLOW_LINKS` + separate `is_link` were designed for; two real
differences handled at the call site — unopenable dir must stay **empty,
not error** (the menu union reads /etc/menu's absence that way), and
`list_dir` counts past the cap while wm.c clips (clamped). Sort stays
caller policy (`entcmp`, the Recycle-Bin tail pin). L10 removed from the
liability register (gap closed). wm_service + desk_icons e2es green.

## #101 — boot.js single-instance guard (0293)

A sidecar lockfile beside the **writable root image** (`<root>.img.lock`),
O_EXCL create, pid + argv + start time recorded, stale-steal on a dead
holder, released on exit/SIGINT/SIGTERM/SIGHUP. Exit **5** = image pair
busy (1 boot-fail, 2 args, 3 heavy lock, 4 cross-tree). Taken BEFORE the
machine-wide heavy lock: refuse over the narrow resource before contending
for the wide one. The estate already treats boot.js as SIGTERM-trapping
(the heavy-lock handlers; kill paths force SIGKILL), so the new handlers
add no new expectations. `test_boot_guard_e2e.js` points two boots at ONE
store deliberately — the exact shape drive.js's per-boot mkdtemp isolation
can never catch — under a private-TMPDIR heavy-lock scope; registered in
the kernel suite (167 → 168). CLAUDE.md updated; L12 removed.

## #546 — sweep port collisions

The ticket's census (12 members / 4 ports) was an UNDERCOUNT: the option
form (`port: N`) hides two more pairs. Measured: **16 members on 6 ports**
(3197×4, 3199×4, 3207×2, 3226×2, 3231×2 fileman+keybind, 3280×2
rust+undo). The Batch I "os-doompage share 3176/3177" claim is REFUTED:
each doompage wrapper drives its own inner file on its own distinct port.

Design call — static unique ports, NOT dynamic allocation, because the
maintenance objection dies to a guard: os-harness-unit.mjs (a sweep member)
scans every member for pairwise port uniqueness, so a new member landing on
a taken port fails the sweep by name. Dynamic ports would have rewritten
~50 members' URL plumbing for no additional safety.

But unique ports alone do NOT close the fake-green: the same member re-run
against its own stale server still takes a wrong-tree 200. The class-closer
is the **identity handshake**: serve.js answers `/__serve-id` with its pid;
`startServer` records the child per port; `waitForServer` holds any 200 on
an owned port to that pid. A mismatched 200 is NOT success (keeps polling
through the strict-port teardown race); exhaustion or child-exit throws
naming the squatter / replaying serve.js's stderr (where the strict-port
refusal was previously lost to an unread pipe). Red control measured: a
live decoy squatting a port turns the pre-fix silent PASS into
"the serve.js this test spawned EXITED … port … still in use". 10 members
renumbered (3330–3339); `-j1` untouched.

## #40 — serve.js --clang browser boot (0152)

Landed as a regression member, `os-clang.mjs` (port 3341): skips loudly
when `../clang-simplified/out-image/overlay.json` is absent (the artifact
is optional by 0141 design), else boots the --clang serve in real Chromium
and asserts os-release names the overlay, the clang apps are baked into
/usr, and a clang-built SDL app **renders** (region stats, no goldens).

**Finding (the reason doom-clang is not the render subject):** the
published artifact's `doom-clang` (clang-simplified @a1a2a6b) **SEGVs at
startup — in the browser AND under headless
`boot.js --overlay=clang-apps`** (exit 139, no output, WAD present). Same
boot, `sdldemo` opens a window and pumps frames — so the serve/overlay
path is healthy and the crash is the artifact (or platform ABI drift since
it was built). The member runs doom-clang anyway and prints its exit
status loudly; promote that leg to a render assert once the artifact is
rebuilt. Reported out-of-fence for a ticket against the sibling.

## Estate deltas

- kernel suite 167 → 168 (`test_boot_guard_e2e.js`)
- browser sweep 53 → 54 (`os-clang.mjs`)
- image.json 240 → 241 (baked inputs changed: wm.c, comdlg32.c, winmm.c,
  commdlg.h)
