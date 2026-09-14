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

## Second review and policy regression

The second review found show-before-placement and explicit popup reopening grab
races, hidden-window resize refitting and visible-table capacity loss. Commit
`a1ea95a5` fixes those. The next review found minimize/outside-click/restore also
needs grab restoration, and correctly rejected a placement test that did not
remove the dormant grab first. Both are now corrected, with 39 passing assertions.

The new lightweight compiled WM policy test builds real `os/wm.c` and replaces
only its socket read/send seam. It executes actual event handlers, title activation,
hide/show at full MAX_WIN capacity, geometry echoes, screen_changed and floating
restore. Eight checks pass. Replacing wm.c with `f5e517d1` yields four failures;
removing kernel map-time restoration yields the expected single lifecycle failure.
These red controls are intentional failures, not acceptance results. Logs are in
789-evidence (v4 kernel, compiled policy v1, and explicitly named red controls).

No browser/manual evidence has yet been produced: the initial browser launch was
refused by the shared heavy-test lock while the coordinator's callback mapped gate
runs. The coordinator reserved the following heavy slot for #789. Final compiled
SDL/User32 rerun, installed software/WebGPU screenshots, flake repetitions and
mapped acceptance remain pending, as does exact-tip independent approval.

## Final frozen acceptance

Implementation review approved `101912eb`; subsequent commits only improve the
browser test. Final capture/test source is `cf6c5175`. The compiled SDL/User32
probe passed once at `947f3c13` (same runtime bytes), then 3/3 under load at
`cf6c5175`. The kernel runner selected 1/209 files: this is focused integration
acceptance, not a full kernel or mapped-gate claim.

Installed Chromium 149.0.7827.55 acceptance passed 3/3 under ten CPU load
processes at `cf6c5175`. Each fresh OPFS install verified VERSION_ID=292 and
Small snapshot equality, fetched served files and compared their hashes, and
ran both software and GPU rendering. Each tier showed exactly 28,600 magenta
pixels after show, zero before show and after hide. Show retained focus in the
control window; explicit activation moved it to the target, and hide returned
it. Software bitmap shipments were zero; GPU shipments were 144, 102 and 104
across the three runs. All three page-error lists were empty. The browser
runner selected 1/75 files; this is not the whole browser sweep.

Versioned screenshots and per-run evidence are in
`789-evidence/browser-under-load-v1`, `v2`, and `v3`. The manifest
`browser-artifact-sha256-v1.json` hashes each PNG/JSON. Author visually inspected
the first run's software hidden and shown states, and the earlier diagnostic
GPU active screenshot. This was agent visual inspection of actual captures;
keyboard input was automated Playwright. No human/manual interaction or manual
input-session completion is claimed.

Capture provenance: ordinary Playwright page/element screenshots returned the
CSS canvas background for the transferred OffscreenCanvas. That is a documented
limitation in existing os-gcode.mjs and was reproduced here. A direct WebGPU copy
from the transferred HTML canvas was explicitly rejected by Chromium. The final
capture uses createImageBitmap(screen), WebGPU copy/readback, and the repository's
Node PNG encoder. It copies the actual composited screen; it does not reconstruct
UI, use Canvas2D, or render fonts in the browser. The initial failed capture and
logs are retained as diagnostic evidence. The successful v3 diagnostic used an
uncommitted capture-test change (runtime still 947f3c13); the three final runs
use committed cf6c5175 and hash the test and fixture as well as runtime files.

Hashes common to final installed-browser runs (SHA-256):
- host.js: `881fa3b31d11fca934684d3fdabfd30f7d7bcb801abeccdfc640b0abad6c31b5`
- kernel.js: `983e2c85fac695ffcea3c36be958eb5dff0ea989e053500ee4b55feee1aa5cf6`
- compiler.js: `bd117fcf838da9cb0c22e4e351c19b844c0d32bdc2cc71b5f3bbbd2538d0733b`
- served system image: `48b29eec218130eacc6517a19828f7e614f5c19dc1fc0c502d4e0937747ef446`
- Small snapshot: `aba6f88a4dd392b6e0c91d9a3253740b692b49a2bc4d28e20889a55f68a576a1`
- Small source compiler: `22152506e0c02f14939ab2c6f429f2927d9fb5a91324b83351005ed22869f591`

The image hash is of the served blob; installed metadata was checked separately.
This is not a claim of bytewise OPFS-volume hashing. Source fingerprints and
individual screenshot hashes are in the evidence JSON files.

At this record's writing the standard `tests/flake.js` tripwire is still running;
its outcome will be appended. Exact final capture review is also pending. The
coordinator retains combined mapped/full integration, merge/main push/deploy,
manual interaction acceptance, #794/#790 and later UI phases. No main change or
deployment was performed by this author. The two nonblocking WM observations
(launch ordering across show, and automatic visible-table capacity recovery)
were carried to #794 by the coordinator.

Final closure: independent reviewer approved capture/test commit `cf6c5175`
(no blocking findings); the full review record is retained in 789-evidence.
`node tests/flake.js` then completed successfully: 12/12 selected kernel runs
and 18/18 selected browser runs, all stable across three repetitions with ten
CPU load workers. Its 530.6-second log, summaries and individual run logs are
retained. Carried results in runner summaries are explicitly historical, not
additional executed tripwire runs. The author released the heavy slot to the
coordinator for #791 only after the flake process exited zero.

Runtime and Small source hashes were rechecked after acceptance and still match
the frozen inputs above. This completes the author's focused implementation,
independent code review, installed-browser evidence and required flake work.
Combined mapped/full gate, manual input acceptance and integration/deployment
remain coordinator gates. No main merge, main push or deployment is claimed.
