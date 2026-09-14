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
