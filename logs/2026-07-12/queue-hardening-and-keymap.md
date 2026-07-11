# 2026-07-12 — queue reprioritization: testing pulled up, keyboard scheme designed

A planning/assessment session (owner-driven): survey the queue, widen the
debugging surface, tighten the testing story, and design a system keyboard
scheme. Two background investigations grounded it.

## Investigation 1 — notepad menu audit (headless, executed)

Drove every `/bin/notepad` menu item via `os/boot.js` + `wmctl`. Verdict:
**most items work**; the exceptions are all silent, none crash:

- **Silent no-ops** (comdlg32 stubs return FALSE → read as "user cancelled",
  no feedback): File → Print (`comdlg32.c:437`), File → Page Setup (`:438`),
  Format → Font (`:436`). This is the "some menu items don't seem to do
  anything" the owner noticed — confirmed.
- **Save As** works but the Encoding/EOLN comboboxes never render (OFN
  hook/template path dead, `comdlg32.c:13`).
- **Undo** permanent no-op (no undo buffer; EM_CANUNDO always FALSE).
- **Help → View Help** grayed by design.
- **About box** renders `\r\n` as a literal `r` — a `tools/win32rc.js`
  STRINGTABLE escape bug.
- **Stale bug retired**: 0073 listed "notepad shows an ERROR dialog opening an
  existing file" as live — it no longer reproduces; the file loads cleanly.
  Someone fixed it and 0073 wasn't updated.

→ Landed as `todos/0145` (comdlg32 no-op feedback + the `\r\n` + Save-As
combos), and 0073's seeded-findings block updated.

## Investigation 2 — test-infra health (read-only)

- **Core runner is good** — `tests/lib/suite-runner.js` (worker pool,
  process-group kills, checkpointed `--resume`) and `image-fixture.js` (shared
  prebake, the 0082 win) need no rework.
- **Sleep debt is ~3× the 0083 estimate**: **~445 kernel `sleep N` lines**
  (~573s), not 145; **~104 browser fixed-delay sites** (~41s). Worst:
  `test_wm_service_e2e.js` (111). `os-recycle.mjs` is 48.5s of which ~44s is
  fixed delay (boot is ~4.5s). → 0083's inventory corrected.
- **The debt is in the per-test layer**, not the core: no shared per-test
  helper, so `waitForServer`/Chromium-launch/`mkdtemp`+boot are copy-pasted
  across ~15 browser + ~37 kernel files. → new item `todos/0146` (extract a
  browser harness + a kernel boot-driver); it's the seam the 0083 event-waits
  land in ONCE.
- **No flake/under-load gate** exists to enforce 0083's "passes under
  contention" acceptance. → new item `todos/0147` (`--repeat N` + contention).
- **Entrypoint fragmentation** (unit/blockfs have two paths; kernel+browser
  orphaned from run.py) is exactly 0084's target — confirmed still open.

## Decisions

1. **Pull testing up.** Testing sat mid-queue behind ~10 feature items. Moved
   the test-infra cluster to the front of the P1 bucket (behind the one P0):
   `0146` (harness extract) → `0083` (retire sleeps) → `0084` (diff-aware
   entrypoint) → `0147` (flake gate). Dropped 0083's stale `after 0079` gate;
   it's now soft-`after 0146`. Rationale: sleep debt compounds — every new e2e
   copies the pattern, so fix the infra before adding more apps to test.
2. **Widen the debugging surface via the built-in `--manual-ux` cadence.** The
   `queue.js add --manual-ux` scaffold already IS the "launch apps, click
   menus, take screenshots and LOOK, keep the repros that catch bugs,
   self-perpetuating" mechanism the owner described. Seeded 3 (`0142/0143/0144`,
   P2) rather than inventing a parallel item.
3. **Recurring test-tightness cadence.** New `todos/0148` (P2, self-reseeding
   like manual-ux): audit test weight, kill infra-caused slowness (e.g.
   `test_term_e2e.js` boots 5×), close headless-counterpart gaps
   (os-scale/screen/vt/aero/drop have browser legs only).
4. **System keyboard scheme.** Windows (Ctrl) default; opt-in macOS (⌘) mode.
   The point isn't cosmetics — moving edit verbs to ⌘ frees the Ctrl row for
   emacs line-editing in GUI text fields (Cocoa-style). Two grounding facts:
   the "toolkit" IS Win32 (TOOLKIT.md superseded), so the integration is
   user32 EDIT reading the scheme; and terminal readline already works (hush
   `FEATURE_EDITING=y`), so term only changes the copy/paste chord. Design in
   `todos/KEYMAP.md`; items `0149` (scheme + verb remap + ctlpanel applet) and
   `0150` (the GUI emacs bindings, `after 0149`). A ⌘-passthrough spike (which
   chords Chrome/macOS swallow) is the first step.

## Note

Heavy concurrent-agent activity this session — the open queue grew from 28 to
55 items (0117–0141 added by others) while this ran. All queue mutations went
through `queue.js`; `check` passes (55 open, 93 done).
