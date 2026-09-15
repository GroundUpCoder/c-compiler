# #794 — owned top-levels, distinct popup dismissal, WM launch-order residuals

Author: Fable 5.1 coordinator thread (01a0a0c9-5fb6-79fc-adec-fcef1cfc35e5),
branch `author/794-owned-windows`, worktree `~/git/c-compiler-794`, based on
main 6a9277d5 (#791 landed). Gamedev justification: the editors and tools of
the in-gucOS dev loop are dialog-heavy — owned Find/Goto/Properties windows,
menus and popups — and toolkits (Win32 today, Swing next) need the owner
relation and a dismissal that is not a close request, or every menu dismissal
looks like the user closing a window. Contract anchors: SDL3 SDL_SetWindowParent
(https://wiki.libsdl.org/SDL3/SDL_SetWindowParent — stays above the parent,
hidden/minimized with it, destroyed with it), SDL_DestroyWindow ("any child
windows owned by the window will be recursively destroyed"), Win32
DestroyWindow ("first destroys child or owned windows") and GetParent (owner
for a WS_POPUP top-level), and `small/GUCOS-UI-CONTRACT.md` "Window state and
ordering" (owner ≠ popup anchor; PopupDismissed ≠ CloseRequested; never arms
the watchdog). SDL_SetWindowModal is deliberately NOT implemented (absence is
honest; Win32 modality stays app-side EnableWindow, unchanged).

## Kernel (kernel.js)

- `SURFACE_SET_OWNER 0x100c` `{sid, ownerSid}`: same-process owner link
  (foreign owner → EPERM, self/unknown/anchored/cycle → EINVAL, 0 clears).
  Surface record gains `ownerSid` + `owned[]`; `_wmOwnedN` gates the
  normalize post-pass like `_wmAnchoredN`.
- Effective visibility: `_wmUp` steps to the anchor parent OR the owner;
  `_wmRequestedHidden` and `_wmAnchorHidden` walk it (an unmapped OWNER does
  not hide its owned windows — mapping is per-surface placement — an unmapped
  anchor parent still does). `_wmViewable` is the one predicate behind the
  compositor/hit-test guards, `GET_STATE.viewable`, `wmList().viewable` and
  `WMP_F_VIEWABLE`. `WMP_F_OWNED 1024` marks owned records.
- Owner hide/minimize: the owned subtree loses effective visibility, its
  grabs/drags/focus are revoked, and each owned window whose effective
  visibility flipped gets its own WINDOW_HIDDEN/SHOWN ring record (snapshot
  before, notify after — `_wmOwnedEffSnapshot/_wmOwnedEffNotify`). Its
  requestedVisible is untouched, so the owner's show restores it and an
  explicitly hidden owned window stays hidden.
- Focus: `wmFocus` on an owned window restores every minimized owner above
  it and raises the ROOT owner; `_wmZNormalize` emits owned windows right
  after their owner's anchored subtree (same layer), so the group stacks as
  one with owned above owner.
- Destroy cascade: owned first (deepest first), then anchored children, then
  the surface; process exit reclaims chains through the same path.
- `_wmGrabConsume` now sends `WMEV.POPUP_DISMISSED 0x7101` (reason 1) instead
  of QUIT. gucOS extension records live in 0x71xx (above every SDL3 event
  number the veneer interprets, below SDL_EVENT_USER). It still never touches
  `wmCloseRequest`, so the hung-app watchdog (#486) is never armed by a
  dismissal — now provable on the wire, not only by code reading.
- CREATE replies `lifecycle: 2`.

## SDL veneer (compiler.js) + host.js

`SDL_SetWindowParent`/`SDL_GetWindowParent` (popups refuse: their parent is
fixed at creation), `SDL_GetWindowFromID`, recursive `SDL_DestroyWindow`, and
two gucOS-named queries: `guc_window_close_reason` (GUC_CLOSE_REASON_REQUEST
0 / POPUP_DISMISS 1, latched per window when the close event is queued) and
`guc_window_viewable` (the kernel's effective answer; -1 without a window
system). host.js maps POPUP_DISMISSED onto the legacy per-window
SDL_EVENT_WINDOW_CLOSE_REQUESTED after recording the reason; a binary
compiled before #794 has no `__sdl_push_popup_dismissed` export and keeps
receiving the QUIT it always saw. `__sdl_set_window_parent` refuses unless the
create reply advertised lifecycle ≥ 2. Both no-window-system host stubs return
-1. `os/doc/sdl-api-index.md` regenerated (`guc_window_*` joins the Window
group; `GUC_CLOSE_REASON_*` is its own cluster).

## user32.c + wm.c

- `hw->owner` (hWndParent's top for a non-child window), linked via
  SDL_SetWindowParent right after SDL_CreateWindow — a refused link fails
  creation loud. `GetParent` returns the owner for a top-level (every top-level
  here is WS_POPUP), new `GetWindow` (GW_OWNER/GW_CHILD/sibling walks for
  children; top-level z walks refused loud). `DestroyWindow` destroys owned
  top-levels first. The close-event handler treats a reason-1 close as a
  popup dismissal (chain close, never WM_CLOSE) whichever window it names.
- wm.c: `win_t.order` (creation counter) keys the taskbar slot, so a hidden→
  shown window returns to its launch-order slot (A/B/C stays A/B/C); a
  duplicate show stashes and re-admits with history intact; a show refused at
  `MAX_WIN` is kept PENDING on its stash entry with the record and
  `EV_DESTROYED` readmits the earliest-launched pending one automatically —
  the two #789 residuals the reviewer classified non-blocking there.

## Tests and evidence (`794-evidence/`, sha256 `manifest-sha256.json`)

- `tests/kernel/test_wm_owned.js` (LIGHT, fake workers, registered): 63
  checks — ownership rules incl. cross-process EPERM, stacking/group raise,
  owner hide/show/minimize/restore with ring records and pixels, explicit
  owned hide surviving the owner's show, depth-2 trees, cascade order,
  relink/clear, POPUP_DISMISSED never QUIT and no watchdog, a pumped-but-
  vetoed close never force-quits, process-exit reclaim. RED CONTROL against
  kernel.js @6a130848: 41 FAIL / 22 ok (`red-control-kernel-owned.txt`).
- `wm_lifecycle_policy_probe.c` (compiled real wm.c, socket seam stubbed):
  +9 checks (pending readmission, launch order). RED CONTROL against wm.c
  @6a130848 with the two `hidden_find` lines stripped (symbol absent
  pre-#794): 5 FAIL (`red-control-wm-policy.txt`); green run
  `green-wm-policy.txt`.
- `test_wm_anchored.js`: the three legs that pinned QUIT-on-dismiss now pin
  POPUP_DISMISSED + reason 1 and assert "never a QUIT" (the two-sided edit).
- `user32_lifecycle_policy_probe.c`: SDL_SetWindowParent stubbed like the
  other SDL seams; passes.
- `ui_lifecycle_probe.c` (compiled in-OS, real boot): +14 legs — Win32 owner
  facts (GetParent/GW_OWNER, owner hide preserves the owned WS_VISIBLE,
  DestroyWindow cascade = 3 WM_DESTROY), SDL owner link/cycle/self refusals,
  viewable 1→0→1 across owner hide/show with the owned HIDDEN flag clear,
  owned activation refused under a hidden owner, popup parent fixed,
  reason 0 before any close, owner destroy takes owned + popup
  (`compiled-e2e-legs.txt`). Viewability legs wait on the authoritative
  query (map-on-placement is async under /bin/wm), never on a nap.
- Browser `os-ui-lifecycle.mjs` + `ui-lifecycle.c` (installed OPFS image
  294, software AND WebGPU, automated Playwright keyboard/mouse — NOT manual):
  after the #789 phases, re-show, link owner, hide OWNER → target pixels 0
  with `TARGET-VIEWABLE 0 hidden=0`, show owner → 28600 with
  `TARGET-VIEWABLE 1 hidden=0`; popup (3200 yellow px) dismissed by a desktop
  click → `CLOSE-REASON 1 popup`, pixels 0; `wmctl close` on the target →
  `CLOSE-REASON 0 target`, the app vetoes, and after the 5 s grace it still
  answers `a` with 28600 px and `TARGET-FOCUS 1`; quitting destroys the owner
  and `OWNER-CASCADE 1` confirms the owned window went with it. An always-
  visible helper window keeps keyboard focus reachable while the owner group
  is hidden (focus falls to it — itself the behavior under test). 3/3 stable
  under ten CPU load workers, both drivers (`browser-under-load/`,
  `load-verdicts.txt`). One hardening step is recorded: a single
  post-activation screenshot caught a transient composite (660–4166 px) and
  now settles on pixels like every other phase.
- Kernel `--repeat 3 --under-load` over the four #794 files: 12/12
  (`load-verdicts.txt`).

## Not in this batch

Semantic inspection/theme, capture/IME (#790-adjacent phases), SDL modal
windows, wmctl `list` columns for the new flag (the 9-char FLAGS width is
kept; `viewable`/`owner` ride `wmList()` and GET_STATE). Independent review,
the mapped gate on the exact tip and integration follow below.

## Independent review round 1 → counter-pass

Reviewer thread 01a0a256-3dbd-7211-b78c-21c7f5a587b5 (claude-code /
claude-fable-5-1 — disclosed switch, Codex capped until 2026-09-19) REJECTED
31b9e96f with two blocking findings and four minor ones. Author response:

1. **Focus fall onto a non-viewable owned window (BLOCK) — fixed.**
   `_wmFocusFall` skipped minimized/requested-hidden/anchored surfaces but
   not an owned window under a MINIMIZED owner, which normalize slots as the
   topmost layer-0 surface; the reviewer's probe showed `_focusSid` staying
   on it (`focused:true, viewable:false`). Fix: the fall skips
   `t.ownerSid && _wmAnchorHidden(t)`. The test's minimize leg was vacuous
   (focus had already fallen to `foreign`): it now focuses the owned window
   first, asserts the fall lands on a VIEWABLE surface, adds a later fall
   (destroy a focused bait window) that must skip the owned window, and
   pins "GET_STATE never reports focused + not viewable" (67 checks now).
2. **GetParent returning the owner broke fileman's picker key routing
   (BLOCK) — fixed at the caller, semantics kept.** `GetParent` returning
   the owner for a WS_POPUP top-level IS the Win32 contract (and what the
   ReactOS calc stats dialog relies on: its `PostMessage(GetParent(hWnd),
   WM_LOAD_STAT…)` went to NULL before #794 and now reaches the main window —
   `test_calc_e2e.js` green). fileman's `while (GetParent(top))` climb was
   an idiom that only worked because the veneer used to answer NULL for
   every top-level. Added the real `GetAncestor` (GA_PARENT / GA_ROOT /
   GA_ROOTOWNER; GA_ROOT climbs WS_CHILD parents only, never an owner link)
   and fileman uses `GetAncestor(m.hwnd, GA_ROOT)`. Audit of every other
   `GetParent(` outside user32 (comctl32.c:85, listview.c:173/637/655,
   ctldemo.c:713): all on child controls, unaffected.
   `test_fileman_ops_e2e.js` (incl. "Enter commits (loop path)") and
   `test_calc_e2e.js` pass against a freshly baked image
   (`build/794-counterpass-e2e.log`).
3. Owned windows keep taskbar/cycle membership under a hidden owner
   (non-blocking) — filed as **#795** (P2, light, quality-gap) with the
   concrete plan (EV_VISIBILITY for owned flips + wm.c treating
   OWNED∧¬VIEWABLE∧¬MINIMIZED like HIDDEN).
4. SDL_WINDOW_HIDDEN deviation from upstream — recorded explicitly in the
   `SDL_SetWindowParent` header comment (regenerated into the API index).
5. `lifecycleBySid` now deleted on destroy in both host flavours.
6. Owned windows not riding the owner's minimize fly animation — accepted
   as cosmetic, not changed (rebuttal: the anchored-child `animRootSid`
   mechanism is scene-side and would need its own review; no correctness
   effect).

## Re-review APPROVED; mapped gate on exact 53dfbcde — GREEN (sliced)

Reviewer thread 01a0a256-3dbd-7211-b78c-21c7f5a587b5 re-reviewed the
counter-pass and APPROVED exact 53dfbcde (range 6a9277d5..53dfbcde), all six
findings closed (1–2 fixed, 3 → #795, 4–5 fixed, 6 rebuttal accepted).

`node tests/run.js --diff 6a9277d5` on this tip maps to all 25 suites
(compiler.js changed; only `netsurf-patch` omitted). Executed as foreground
slices under the tool cap, one heavy suite at a time, with the kernel and
browser records PURGED first so every row below is this tip's own:

- `todos` 3/3, `unit` 850/0/3, `host` all files — exit 0; `blockfs` 15/15;
  run.py categories 904 passed / 0 failed / 111 skipped — exit 0.
- `kernel`: 211/211 recorded (test_wm_owned.js is the 211th), 0 failed,
  `resumed: 0`; slices in `gate-53dfbcde/kernel-slices.json`;
  `test_os_boot.js` solo 731 s; sibling members last.
- `sweep`: 77/77 recorded, 0 failed, `resumed: 0`; seven slices
  (`sweep-slices.json`), `os-ui-lifecycle.mjs` included.

Records: `gate-53dfbcde/kernel-summary.json`, `browser-summary.json`
(`done: true`, `recorded == total`, zero non-pass), `slice-verdicts.txt`.
No single run-level summary exists for a sliced gate; these merged per-suite
records are the evidence. Integration: fast-forward of main to this tip.
Not deployed (live edge v291; main now carries image 294).
