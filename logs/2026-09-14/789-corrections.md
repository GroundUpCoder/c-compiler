# #789 integration corrections

Base: immutable coordinator candidate 4e534f88, tree identical to author
7e5b1971. Corrections are in a new worktree, c-compiler-ui-lifecycle-fix,
branch ui-lifecycle-789-corrections. The original integration worktree and
its running dispatcher 86785/evidence are untouched.

The mapped integration gate exposed startup and input cases missed by the
focused acceptance. Notepad creates without WS_VISIBLE, then restores with
SetWindowPlacement; that function ignored showCmd. SameBoy and GPU-box also
created hidden windows and never explicitly showed them. Calculator explicitly
focuses a hidden child, which the new keyboard visibility guard rejected.
These are regressions affecting desktop tools and the in-guCOS gamedev loop.

SetWindowPlacement now validates the structure length and applies showCmd via
the shared ShowWindow lifecycle regardless of geometry changes. This retains
normal-show activation requests versus nonactivating shows. SameBoy and GPU-box
explicitly show after initialization. No forced-visible creation is restored.
The keyboard route checks top-level visibility before menu dispatch, then
checks target enabled ancestry without requiring local child visibility.
Mouse targeting retains its visibility checks; hidden top input stays rejected.

## Primary contract evidence

- Microsoft SetWindowPlacement specifies show state and requires correct length:
  https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowplacement
- WINDOWPLACEMENT.showCmd accepts ShowWindow commands:
  https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-windowplacement
- SetFocus and Keyboard Input Overview identify the focused HWND as recipient:
  https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setfocus
  https://learn.microsoft.com/en-us/windows/win32/inputdev/about-keyboard-input
- Microsoft's general Window Features visibility paragraph says hidden windows
  cannot process user input. This is in tension with specific hidden-focus-proxy
  compatibility evidence; omission of visibility in SetFocus alone is not proof:
  https://learn.microsoft.com/en-us/windows/win32/winmsg/window-features
- Oracle's Windows AWT documentation explicitly describes hidden child HWNDs
  receiving native keyboard/IME messages before JDK7:
  https://docs.oracle.com/javase/7/docs/webnotes/tsg/TSG-Desktop/html/awt.html
- Independent reviewer 01a09ecd-a80c-78e3-b4da-c443469da62a corroborated the proxy
  creation without WS_VISIBLE and explicit SetFocus in OpenJDK6, plus Wine's
  conformance test of a hidden edit beneath a visible parent. This is source
  evidence, not native Windows execution in this session:
  https://github.com/openjdk/jdk6/blob/3e49aa876353eaa215cde71eb21acc9b7f9872a0/jdk/src/windows/native/sun/windows/awt_Frame.cpp#L360
  https://github.com/openjdk/jdk6/blob/3e49aa876353eaa215cde71eb21acc9b7f9872a0/jdk/src/windows/native/sun/windows/awt_Component.cpp#L2238
  https://github.com/wine-mirror/wine/blob/2550c238151a00e43908561f32b6e131603ec6f7/dlls/user32/tests/msg.c#L13880

## Visibility observability

WMP record flag 512 (VIEWABLE) is an additive snapshot bit derived from mapping,
self/anchor requested visibility and minimization, using the compositor's
eligibility predicates. It does not imply unoccluded pixels or frame submission.
Existing flag256 still means only the surface's own requested-hidden state.
wmctl list exposes H for that flag; wmctl wait visible TITLE requires VIEWABLE.
SameBoy/GPU-box/Notepad startup tests now require viewability, not only existence.
Image version293 is a candidate only; no bake/install/deployment yet.

## Executed source/nonboot validation

- Actual user32.c compiled with synthetic HWND state and deterministic SDL
  show/hide/raise/size callbacks: 10 assertions pass. Actual wmctl.c compiled
  with synthetic WMP records: six query assertions pass. These are nonboot
  function-level tests, not public creation or installed-guCOS evidence.
- Red control substitutes only user32.c from4e534f88 into the same current
  harness/compiler/dependencies. It fails the placement and hidden-focus tests;
  the control log is retained alongside the passing log.
- Kernel fake-worker lifecycle test passes, including new VIEWABLE checks for
  hidden/mapped/pending-placement/minimized/anchored states.
- A first test draft failed compilation on C true literals; the wmctl extension
  initially lacked png include linkage, then a BlockFS import provider. Those
  harness diagnostics are in build/789-corrections; they are not product reds.

Versioned logs: 789-corrections-evidence/. No browser or manual interaction was
performed for these corrections. Existing screenshots remain historical evidence
for the superseded tree, not acceptance of this correction.

## Outstanding gates

Independent exact-tip implementation review, final immutable gate failure census,
slot release, affected actual e2e reproductions and regression checks, installed
software/GPU browser acceptance with versioned real screenshots and fingerprints,
required flake checks, and coordinator fresh mapped integration. No timeout
weakening or failure waiver. Coordinator owns main integration and rollout.

## Completed author acceptance and handoff

Runtime correction 86968e3339fe1c9339c81b6f4c6b01aebe519978 was independently
approved. All 11 original kernel failures and all 10 original browser failures
then passed in actual executions: kernel selection16/16 and browser selection11/11,
including the added lifecycle/startup acceptance. Both affected runs were complete
for their selections, with no resumed or carried results. The machine-checked
before/after census is acceptance-census-v1.json in the evidence directory.

The separately tracked repeated desktop-file paste and later taskbar-menu reopen
both passed unchanged, then passed 3/3 under ten CPU load workers in clipboard and
shell browser repetitions. This establishes observed recovery and repeat stability;
it does not independently isolate which correction caused each former symptom.
Loaded kernel startup/lifecycle: SameBoy, Notepad, compiled lifecycle and Dawn
GPU-box each3/3 (12 executions). Loaded browser clipboard, shell and installed
software/GPU lifecycle each3/3 (nine executions). The repeat summaries retain
unselected historical rows marked carried; those rows are not counted in these
12/nine execution results. Per-repetition logs are retained separately.

The first standard flake gate at86968e33 was RED: kernel9 pass/3 fail,
browser18 pass/0 fail. All three failures were the same stale test expectation:
WM-service demanded the old eight-character FLAGS string f---R--- while the
correct visible/focused/resizable row was f---R----, with the new H slot clear.
Commit c8e726341acc58ea07c6296126b94ac98d2cc350 changes ONLY that full-field
assertion and its explanatory comment. It neither weakens a timeout nor changes
runtime behavior. Independent reviewer approved this exact tip with no findings.
The complete red run is retained under standard-flake-red-v1 plus its stream log.

A fresh `node tests/flake.js` at c8e72634 passed: kernel12/12 and browser18/18
executions, all selected files3/3 under ten load workers, 521.0 seconds total.
Fresh summaries are done, have no resumed/carried rows and all results pass.
This is the repository's standard selected tripwire, not a full kernel/browser
suite or the coordinator's mapped integration gate.

### Installed browser evidence

Four real Chromium149.0.7827.55 runs (initial plus three under load), fresh local
OPFS at http://localhost:3349/os/os.html?hostkeys=off, installed candidate293. Every software
and GPU run measured target pixels0 hidden /28600 shown /0 after hide, preserved
focus on nonactivating show and observed explicit activation. Software bitmap
ships0; GPU ships66 initially and148/208/84 under load. No browser page/console
errors were recorded. Host/served source hashes and installed version/Small
snapshot metadata checks passed in every run.

Screenshots are real composited-canvas pixels captured via ImageBitmap/WebGPU
readback and PNG encoding in Node. No Canvas2D or browser font rendering added.
Versioned directories under screenshots-v1 preserve every capture. The show/hide
loops include intermediate frames; representative-screenshots-v1.json selects
and verifies the final observed frames rather than assuming index0 is settled.
The single active-phase capture may precede the next visual chrome update;
activation acceptance uses the input/focus transcript, not that image alone.
Author visually inspected initial GPU active and loaded final hidden frames,
including identifying a still-visible intermediate hide frame. This was agent
visual inspection and automated Playwright keyboard interaction, NOT human manual
interaction. Human/manual acceptance remains distinct and is not claimed.

SHA256 identities (unchanged again at the end of acceptance):

- host.js: 881fa3b31d11fca934684d3fdabfd30f7d7bcb801abeccdfc640b0abad6c31b5
- kernel.js: fd57c635fa84bb991af904d3e317f67a21cbf468e9c5dafe2785bb82d50f2698
- compiler.js: bd117fcf838da9cb0c22e4e351c19b844c0d32bdc2cc71b5f3bbbd2538d0733b
- image manifest: e898b932b95cc655cc013a80df0e408d031e66e775af55d28662bab8dc1e8a5b
- served image293: 73a4cf8f2a16208ffda2b8ee22755e6fe068e467be9dbeb931b46de8534cbd7e
- Small snapshot: aba6f88a4dd392b6e0c91d9a3253740b692b49a2bc4d28e20889a55f68a576a1
- Small source small.js: 22152506e0c02f14939ab2c6f429f2927d9fb5a91324b83351005ed22869f591

The image hash is the served image artifact hash, not a bytewise OPFS volume hash.
Small compiler bytes in frozen-identities-v2.json are source-derived snapshot
bytes; the browser directly verified installed snapshot metadata. Full artifact
hashes, transcripts, review records and original gate failure census are retained.

### Coordinator gates

Author runtime/source work is complete and reviewed; this evidence-only handoff
commit changes no tested runtime or test code after c8e72634. No changes to the old
integration worktree/gate evidence, main merge, main push or deployment occurred.
#789 stays open for coordinator integration. Coordinator owns the corrected merge
and fresh mapped gate, graphics inheritance of these corrections, manual acceptance,
remaining UI phases, Small#40 and the complete Swing rollout. Existing native
minimize/maximize/placement limitations are unchanged; this bounded batch does not
claim full native Win32 compatibility or completion of the shared UI rollout.
