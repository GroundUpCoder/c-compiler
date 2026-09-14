# #789 shared UI lifecycle author record

Author branch `ui-lifecycle-batch1`, isolated worktree
`/Users/jku/git/c-compiler-ui-lifecycle`, baseline `16cb5333`.
User authorization and coordinator: Small thread
`01a09e1d-f40d-7f0e-8149-13d71ed4636f`; author thread
`01a09ebf-cb43-78e3-b125-cd3c5464f0db`.

Gamedev justification: desktop tools/editors used to develop inside gucOS need
invisible construction, reusable windows and reliable popup/focus behavior.
This is infrastructure for the build/debug/iterate loop. No Swing implementation
or new drawing/font backend is part of this author batch.

## Prerequisite

Existing callback commit `3bb96c0a` was cherry-picked onto current main as
`b1853235`. Two conflicts with newer Objective-C callback export wrappers were
resolved by retaining that lookup in registration-time `captureTableCallback`.
The callback test passed with real C table mutation and Small direct refs in
both JSPI and synchronous modes. Original historical evidence remains historical;
it does not certify this new source tree.

## Protocol and adapters

Additive kernel opcodes: SET_VISIBLE 0x1009, ACTIVATE 0x100a, GET_STATE 0x100b.
Creation flag bit 8 (256) requests initially hidden storage; CREATE replies with
`lifecycle: 1`. A hidden request against an older kernel is refused by the host
and its allocation destroyed, rather than silently appearing. Existing visible
creation keeps its legacy focus behavior; low-level `activate:false` suppresses
it. SDL clients can create hidden then show without activation.

`requestedVisible` is independent of one-way placement `mapped` and WM
`minimized`. Mapping, timers and subscriber loss never change visibility intent.
Show/hide retain sid/backing store and renderer. Hide removes the subtree from
composition/input/overview and revokes drag/relative-lock/popup grab authority;
focus falls to another eligible window. Descendant requested visibility remains
intact. WMEV SHOWN/HIDDEN are best-effort ordered ring events under the existing
bounded-ring contract; GET_STATE is authoritative even if an event was dropped.
No new guarantee of lossless input or frame-buffer ownership is asserted.

WMP record bit 256 identifies application-hidden windows. EV_VISIBILITY 0x95
carries a complete record; `/bin/wm` removes/reinserts taskbar/cycle membership
without re-placing on show. ACTIVATE emits EV_ACTIVATION_REQUEST 0x96 for WM
policy (current policy grants via FOCUS). FOCUS rechecks visibility so a late
policy response cannot undo hide. Without a WM the existing kernel focus policy
serves the request. Wrong-owner operations return EPERM; stale ids EINVAL;
hidden activation EACCES. All paths reuse the existing CPU/WebGPU transport.

User32 now honors WS_VISIBLE at construction and uses SDL show/hide. SW_SHOWNA
and SW_SHOWNOACTIVATE preserve activation; ordinary show requests activation.
Visibility style bits and WM_SHOWWINDOW transitions stay consistent. Hide closes
its menu and releases capture; SDL focus events maintain active-top bookkeeping.
Previously declared minimize/maximize limitations remain outside this batch.

Contracts: https://wiki.libsdl.org/SDL3/SDL_ShowWindow,
https://wiki.libsdl.org/SDL3/SDL_HideWindow,
https://wiki.libsdl.org/SDL3/SDL_RaiseWindow,
https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-showwindow.
The Small proposal remains the scope reference; final non-anchored owner
relationships, distinct popup-dismiss records, capture/IME, frame identities,
fonts and semantic inspection belong to coordinator-managed later work.

## Validation scope (in progress)

Executed focused fake-worker kernel lifecycle assertions, existing anchored-popup,
WM policy and core WM tests passed. The new test injects actual registered mapping
callbacks deterministically; it does not approximate a timer race with sleeps.
Callback regression passed in both modes after synchronizing the new event layout.
Compiled SDL/User32 and browser tests have been added; their results, exact source
pins, independent review and mapped-gate result are pending at this checkpoint.

The browser fixture is automated Playwright keyboard input against a real browser
boot and installed OPFS image, for both software and WebGPU SDL rendering. It uses
browser screenshots, no Canvas2D readback helper. This is NOT human/manual evidence.
Versioned artifacts go to a fresh `build/test-browser/ui-lifecycle-<timestamp>/`.
Image manifest 292 is an author candidate, not a deployment. No main merge, main
push, deployment or completed manual test is claimed.


## Independent review fixes

External reviewer `01a09ecd-a80c-78e3-b4da-c443469da62a` was created via cc-meta;
metadata verified executor codex/model gpt-6-astra. Review found popup-grab
restoration, saved WM restore geometry, stale activation after hide/show, stale
overview membership and forbidden SDL popup raising cases. The corrective pass
retains hidden WM policy records until show/destruction, restores only surviving
undismissed popup grabs, and rejects popup activation. Activation requests and
WM FOCUS grants now echo a visibility serial, so a hide/show cycle invalidates
an old grant. Legacy one-word FOCUS remains an explicit WM/agent action. Overview
snapshots filter application-hidden sids even when the WM snapshot is stale.

The coordinator independently fixed the callback wrapper identity defect as
`0ae66dc8` (reviewed there). This author integrated that change with its preceding
Objective-C regression test `27c19208`; no independent authorship is claimed.

At checkpoint 37b9752f, the compiled SDL/User32 probe passed in the kernel runner
(1/208 selected, not a broad gate); evidence is retained under 789-evidence.
The earlier mixed-source failure's attribution to version mismatch is an inference
from boot/load timing and the capability check, not a traced runtime observation.
A main-kernel red control failed 20 lifecycle assertions; focused expanded tests
pass with the review fixes. Final re-review, browser evidence and mapped gate
remain pending.
