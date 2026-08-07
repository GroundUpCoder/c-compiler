# Queue classification — OS-proper vs package-side (#567, PKGDEV-EPIC ladder 6b)

Snapshot: 2026-08-07. **This file is the at-a-glance snapshot; the ticket
DB is the live truth.** Every open ticket (statuses open + in_progress +
deferred; done/dropped excluded) carries exactly one classification in its
cc `design` field, machine-greppable by leading token:

    pkgdev:<os-proper|package-side|mixed> — <one-line reasoning>

Pre-existing free-prose `design` values (#464, #280, #276) are preserved
verbatim after a `| prior:` separator. The filter is a client-side
projection over `cc-meta ticket list` JSON (`ticket.design` matches
`/^pkgdev:(os-proper|package-side|mixed) /`; the field is OMITTED from the
projection when empty — absent key = unclassified, i.e. filed after this
sweep). `ticket list` has no server-side design filter.

Definitions (from #567, used verbatim):
- **package-side** — codes against the gucOS interface: apps, vendored
  ports, gcode features, decks, demos, package defs.
- **os-proper** — kernel / wm / compositor / compiler / host / veneers /
  the build+test estate.
- **mixed** — genuinely both; every mixed entry names both halves.

Rulings applied where the definitions underdetermine (reasoning in
`logs/2026-08-07/0567-queue-classification.md`): gucman and its verbs are
os-proper (package-manager platform tooling, not an app that would move
to a package repo); tests classify by their SUBJECT (a NetSurf conformance
lane is package-side, a suite-runner/harness/gate ticket is os-proper);
baked system apps that code wholly above the interface (term, ctlpanel,
fileman, paint, software manager) are package-side; conformance corpora
whose subject is the veneer (Wine tests, Petzold, SDL testautomation) are
os-proper.

## Counts (verified 2026-08-07 by DB re-read: 255 open tickets, 255 classified, 0 unclassified)

| class | count |
|---|---|
| os-proper | 158 |
| package-side | 73 |
| mixed | 24 |
| **total** | **255** |

## os-proper (158)

- **#3** 0052 — loopback AF_INET — *kernel networking (loopback AF_INET)*
- **#4** 0064 — WM bug sweep, round 3 — *wm bug sweep*
- **#5** 0049 — wallpaper — *wm.c desktop wallpaper*
- **#7** 0054 — AF_INET relay transport (arbitrary hosts) — *kernel net relay transport*
- **#8** 0051 — halt / reboot — *kernel/OS lifecycle (halt/reboot)*
- **#10** 0062 — zero-copy present (direct transport + cross-agent seam) — *compositor/kernel present transport*
- **#12** 0087 — Compiler triage: GNU-extension gaps surfaced by the SameBoy port — *compiler (GNU-extension gaps)*
- **#13** 0097 — ss modules join the spawn module cache (0037) — compile options unified by 0041 — *kernel spawn module cache (ss modules)*
- **#14** 0109 — desktop icon Properties popup (the 0092 tail) — *wm.c desktop furniture (icon Properties)*
- **#15** 0110 — wm.c desktop confirm dialogs — Empty Recycle Bin, delete, Shift+Del bypass — *wm.c desktop confirm dialogs*
- **#16** 0115 — More screensavers — Mystify + 3D pipes — *wm.c screensavers*
- **#17** 0116 — Title-bar right-click raises the window system menu — *wm/kernel title-bar system menu*
- **#20** 0120 — Overlay windowed-app smoke leg: drive an --overlay=clang-apps DOOM via wmctl shot (browser + e2e) — *test estate (overlay-image smoke leg)*
- **#21** 0121 — Reproducible image bakes: strip wall-clock inode mtimes so os-system.img is blob-deterministic (verify overlays/base by hash) — *build/bake determinism (mkimage mtimes)*
- **#25** 0125 — Wrap host.js so its top-level bindings don't leak onto the page — *host.js page-binding hygiene*
- **#29** 0133 — user32 EDIT control → real multiline editor (notepad completeness) — *user32 EDIT control (veneer)*
- **#32** 0136 — EDIT control interactive scrollbars (WM_VSCROLL / WM_HSCROLL) — *user32 EDIT scrollbars (veneer)*
- **#33** 0137 — EDIT control word-wrap + horizontal-scroll rendering — *user32 EDIT word-wrap (veneer)*
- **#34** 0138 — comdlg32 ChooseFont dialog (notepad Format → Font) — *comdlg32 ChooseFont (veneer)*
- **#35** 0139 — Win32 printing pipeline (PrintDlg / PageSetup / StartDoc rendering) — *win32 printing pipeline (veneer)*
- **#37** 0148 — test tightness sweep (recurring) — *test estate tightness sweep*
- **#41** 0157 — Real icon set for gucOS (desktop / Start menu / taskbar) — *wm.c icon glyphs + bake-time rasterizer (desktop furniture)*
- **#42** 0162 — registry backend: consider SQLite (shared, consistent hive) — *kernel32/advapi32 registry backend (veneer)*
- **#71** CS4 — SUBSCRIBE MANAGE-bit (design-sensitive, SURFACE-FIRST) — *WMP protocol (SUBSCRIBE MANAGE-bit)*
- **#73** gucman update / info / gc subcommands — *gucman platform tooling (update/info/gc)*
- **#74** gucman postinst/prerm script hatch — *gucman platform tooling (postinst/prerm hatch)*
- **#92** 0285 — kernel-worker deploy image fetch: cover the manifest.image branch, make the failure LOUD, retire the zombie bake fallback — *kernel-worker boot/deploy image path*
- **#100** 0292 — optional bake assets: dependent launchers inherit optionality; decide + gate cross-machine bake identity — *bake estate (optional assets, cross-machine bake identity)*
- **#102** 0294 — Window resize: west / north / NW / NE / SW moving edges (kernel hit test + wm policy) — *kernel hit test + wm resize policy*
- **#103** 0295 — win32 0211 remainder: WM_MOUSELEAVE, WM_SYSKEYDOWN activation, comdlg32 lpstrFilter (LISTBOX WS_VSCROLL split to #275) — *win32 veneer remainder (WM_MOUSELEAVE etc.)*
- **#104** 0296 — BlockFS-backed statvfs (real free/used blocks) so df stops reporting fiction — *BlockFS/kernel statvfs*
- **#105** 0297 — BLOCK_FS Immediate: C-level tests for the 10 untested WASM imports — *test estate (BLOCK_FS import tests)*
- **#107** 0300 — wm.c modal min/max box suppression — descoped into a now-closed item, never refiled — *wm.c modal chrome policy*
- **#108** 0301 — mobileViewport() trips on a short-but-wide NON-touch window (900x600) while data-touchui stays off — *host shell (os.html mobile viewport)*
- **#109** 0302 — recurring liability sweep: find gap-describing comments that never entered todos/ — *repo/estate liability-sweep process*
- **#118** 0314 — compiler.js: statement-body inlining (tryInline only handles 'return EXPR;' bodies — the measured 5.4x cc-vs-clang gap's highest-value lever) — *compiler inliner*
- **#122** 0323 — Whole-program link rejects cross-TU declared-type mismatches that separate compilation allows — *compiler (whole-program link checks)*
- **#123** 0324 — Provide C11 `<stdatomic.h>` (or the `__atomic_*` builtins) so CPython's pyatomic.h has a backend — *compiler/libc stdatomic*
- **#124** 0325 — libc surface gaps found by the CPython/numpy M0 probe — *libc gaps (CPython probe)*
- **#125** 0326 — SDecl._withChildren silently drops a rewrite of a declaration initializer — *compiler (SDecl initializer rewrite)*
- **#127** 0329 — an over-arity call is blamed on an "unprototyped function" when the prototype came from a re-declaration — *compiler diagnostics*
- **#129** 0334 — sealed-vs-brokered `/usr`: an in-OS read probe that does not spawn per read — *kernel/RemoteFS read-probe measurement*
- **#130** 0335 — a function with more than 65520 basic blocks still dispatches through a linear compare chain — *compiler codegen (block dispatch)*
- **#131** 0336 — CPython startup is 26x clang because V8 spends 2.3 s optimizing ONE of our functions — *compiler codegen (V8 optimization pathology)*
- **#136** 0347 — CAPABILITY: Win32-veneer apps must be buildable by the clang sibling — *toolchain capability (clang sibling must build the veneer)*
- **#137** 0349 — overlay `.wasm` payloads embed the ABSOLUTE build path, so the bytes depend on WHICH DIRECTORY built them — *build determinism (overlay wasm path embedding)*
- **#145** 0364 — id allocation cannot see an unpushed id in another clone — *repo tooling (cross-ref id allocator)*
- **#147** 0366 — nothing prevents a NEW wall-clock budget entering tests/unit — the 0361 survey is a hand-run audit — *test estate guard (wall-clock budgets)*
- **#148** 0369 — the kernel/py harnesses use FIXED per-test timeouts, so the heaviest tests fail on machine load rather than on code — *test estate (load-relative timeouts)*
- **#151** 0373 — Freshness by RECORDED read-set: buildProject records {path,sha256} per read; 'fresh' = recorded hashes unchanged (retires the hand-maintained closure) — *build estate freshness (recorded read-set)*
- **#152** 0377 — Brokered write() short-writes at 60,000 B — the exact mirror of the 0140 read bug, still open on the write side — *kernel brokered write path*
- **#153** 0378 — The libc env-divergence batch (D5–D22) + do libc contracts deserve their own conformance seats — *libc conformance batch*
- **#154** 0379 — Repair path for duplicate-dirent corruption on existing user volumes — *BlockFS corruption repair path*
- **#155** 0380 — Same-origin allowlist relay for github.com (the CORS-free substrate for clone/fetch on gucOS) — *net relay substrate (serve/kernel)*
- **#157** 0382 — libc gaps surfaced by the 0350 zip vendoring: umask(2) and id_t absent, strcasecmp mis-headered, 6 time/at-family functions missing — *libc gaps (umask, at-family)*
- **#159** 0385 — cpython-clang startup latency (~2s for python --version on iPhone) — *startup latency is compiler/spawn platform work; cpython-clang is the symptom carrier*
- **#168** 0399 — umask is per-process but does not survive __spawn (POSIX inherits it) — *kernel spawn umask inheritance*
- **#169** 0400 — directory file descriptors: O_DIRECTORY, dirfd(3), fdopendir(3) — what the *at family needs — *kernel/libc directory fds*
- **#170** 0401 — FIFOs: mkfifo(3) and path-named rendezvous (todos/0382 gap 9) — *kernel FIFOs*
- **#172** 0405 — the fuzz tier has no ILP32 oracle; the width normalization is not guarded — *test estate (fuzz ILP32 oracle)*
- **#179** 0428 — kernel-brokered intra-guest drag session (WMP_REQ_DRAG_START/ACCEPT + EV_DRAG_*/EV_DROP) — *kernel/WMP drag session*
- **#181** 0430 — desktop icon grid (0077) as a drag SOURCE and drop TARGET for the kernel drag session — *wm.c desktop grid as drag source/target*
- **#185** 0440 — WebSockets as a first-class gucOS capability (ws OFD kind + curl_ws veneer) — *kernel ws OFD kind + curl_ws veneer*
- **#191** [deferred] 0446 — gucos-rust gucos-sys::http still binds the retired 0417 id-based HTTP ABI — *gucos-sys Rust-to-OS ABI binding (toolchain)*
- **#193** 0449 — Media seam: a general WebCodecs host transport with independent decode/encode capability probes — *host media seam (WebCodecs transport)*
- **#196** 0452 — Optional media encoder: VideoEncoder/AudioEncoder + window recording, capability-gated with a visible failure notice — *host encoder seam + window-recording capture*
- **#206** 0460 — win32: WM_GETMINMAXINFO + MINMAXINFO — enforce a minimum window tracking size — *user32 WM_GETMINMAXINFO (veneer)*
- **#280** win32: integer-snap SET_DST upscale for fixed-size windows (winmine/games) — *wm/veneer SET_DST scale mechanism (platform-side per its own design note)*
- **#284** C4 — win32 consolidation: WM_CTLCOLOR* family — *WM_CTLCOLOR* family (veneer)*
- **#285** C6 — win32 consolidation: AlphaBlend + TransparentBlt + SetStretchBltMode — *AlphaBlend/TransparentBlt/StretchBltMode (veneer)*
- **#286** C8 — win32 consolidation: COMBOBOX + progress bar (msctls_progress32) — *COMBOBOX + progress controls (veneer)*
- **#287** C9 — win32 consolidation: glass tier — evaluate + recommend (decision item) — *glass tier decision (veneer/compositor)*
- **#288** C10 — win32 consolidation: the toolkit contract doc (closes the stream) — *veneer toolkit contract doc*
- **#289** C7 — win32 consolidation: LISTBOX owner-draw + blessed child-SCROLLBAR pattern (scrollbar half = #275, adopted) — *LISTBOX owner-draw + child-SCROLLBAR pattern (veneer)*
- **#293** [deferred] D3 — M1: the codex port runtime spike on the 0442 shim (size, startup, current_thread verdict) — *wasip1 shim runtime verdict (toolchain spike)*
- **#294** [deferred] D4 — M2: the wasm C toolchain experiment — verdicts for the 9 asm-FFI crates — *wasm C toolchain experiment (asm-FFI crates)*
- **#323** W2-TF — MessageBox fidelity — *MessageBox fidelity (veneer)*
- **#324** W2-TG — small-control styles — *small-control styles (veneer)*
- **#325** W2-TH — dialog-stress applet pack (the acceptance surface for W2) — *dialog-stress applet is the veneer acceptance surface (ctldemo family)*
- **#326** W3-TI — kernel-backed mouse capture + WM_CAPTURECHANGED — *kernel-backed mouse capture (kernel+veneer)*
- **#327** W3-TJ — cursor protocol: class hCursor + WM_SETCURSOR — *cursor protocol (kernel+veneer)*
- **#328** W3-TK — menu keyboard completion — *menu keyboard completion (veneer)*
- **#329** W3-TL — scroll + list interaction fidelity — *scroll/list interaction fidelity (veneer)*
- **#334** W5 — win32 gap residue — *win32 veneer gap residue*
- **#339** Win32 corpus C4b — port the first slice of Wine's comctl32/user32 conformance tests (scope + licensing set by C4a) — *Wine conformance tests target the veneer*
- **#341** Win32 corpus C6 (OPTIONAL, LAST) — Petzold 5e samples as per-control micro-tests, scrollbar chapter first — *Petzold micro-tests target veneer controls*
- **#344** test_fileman_nav_e2e.js 'Enter on a directory navigates into it' flakes under full-estate load (0171 lost-keystroke class) — *test-estate flake (0171 lost-keystroke class under load)*
- **#352** CREATE_SUSPENDED: real suspended spawn via a spec-level field (retire #321's report hack) — *kernel spawn spec + kernel32 CREATE_SUSPENDED*
- **#357** [deferred] gucOS mobile (touch) copy/paste — investigate the real gap vs shipped #79/#69, then implement — *host shell touch copy/paste (os.html/osk)*
- **#362** net bridge (#349) is unreachable from the shipped https origin — every off-origin fetch dies ENETUNREACH — *net bridge reachability (deploy/kernel net)*
- **#364** gucOS gate: pane tests assert ink PRESENCE, which cannot fail on a layout bug — add containment + off-nominal font-size renders — *test estate (gate assertion strength)*
- **#366** gdi32: implement CreateDIBSection — kill the copy+swizzle present path (paint.c today, win32 NetSurf chrome next) — *gdi32 CreateDIBSection (veneer)*
- **#374** FEASIBILITY (jku asked directly, answer was orphaned): how hard is an OpenGL shim on top of WebGPU? — *OpenGL-on-WebGPU shim feasibility (host/veneer graphics)*
- **#375** gate: summary.json is written by the LAST run, so a second run DESTROYS the first run's evidence block (traps letter (IX)) — merge across runs[] — *test estate (summary merge across runs)*
- **#379** gdiplus-mini follow-ups: ICO/CUR decode + JPEG encode (from 0453/#94) — *gdiplus-mini veneer lib (ICO/CUR decode, JPEG encode)*
- **#384** SET_DST magnifies user32 menu chrome — general scale-exempt inset primitive (SameBoy, Winmine, Paint) — *kernel/compositor scale-exempt inset for veneer chrome*
- **#390** SysListView32: implement a real LVS_ICON view (retire the "no customer" opt-out; needs ImageList substrate) — *SysListView32 LVS_ICON (veneer control)*
- **#391** net bridge: same-origin passthrough + URL absolutization at the netFetch choke point (Software Manager broken with the bridge ON) — *net bridge netFetch choke (kernel/host)*
- **#392** net bridge SUBSET half: surface transport error text + honor errno distinctions (kernel/veneer side of #387's complaint class) — *net bridge errno honesty (kernel/veneer)*
- **#397** Fullscreen/PWA + Keyboard Lock host plumbing so ⌘W reaches the page (BLOCKED on the spike) — *host plumbing (fullscreen/PWA/Keyboard Lock)*
- **#402** [deferred] DESIGN ASK for jku (deferred): touch-specific resize affordance needs a pointer-type bit on the wm-input wire — amends 0212's 'kernel never learns touch exists' invariant — *wm input-wire design (pointer-type bit)*
- **#404** macOS ⌘ bindings: ⌘W close-window, ⌘M minimise, Ctrl+Tab rotate, opportunistic fullscreen+Keyboard-Lock, and a beforeunload guard so the unlocked ⌘W/⌘Q fallback prompts instead of killing the session — *host/wm macOS key bindings*
- **#410** HUMAN-ONLY: two ~1-min #396 probe follow-ups — run A2 (fullscreen, no lock) + ⌘H/⌘M double-action check — *host keyboard probes (human-only)*
- **#416** Run the keyboard-passthrough probe on a real Windows box — convert #406's ASSUMED rows in KEYMAP.md to MEASURED — *host keyboard probe on Windows*
- **#425** boot.js --audio-wav=FILE: arm the mixer + capture WAV headless (Playwright residual) — *boot.js estate tooling (headless WAV capture)*
- **#426** wmScreenshotScreen opt-in furniture parity (corners/shadows/anim-at-t) — must not change existing shot output — *kernel screenshot furniture parity*
- **#427** Shared boot-orchestration extraction — kill the boot.js / kernel-worker.js twin drift (structural, no behaviour change) — *boot orchestration extraction (boot.js/kernel-worker)*
- **#432** setjmp p4 residue: do/for controlling expressions and nonzero-constant comparisons still rejected — *compiler setjmp residue*
- **#441** netfs SCOPING — remote mount of a Lightsail volume: deferred-reply fs path + NetFS design (JSON-over-HTTPS to SFTPGo) — *kernel fs scoping (netfs remote mount)*
- **#442** Document the Kernel capability object as the supported host contract (headless-node follow-up; the seam behind kernel-worker.js/BrowserHost and boot.js/NodeHost) — *kernel host-contract documentation*
- **#447** Voice dictation — speech → focused app (Web Speech → osk.js injection seam) — *host speech-to-osk injection seam*
- **#448** Text-to-speech — gucOS speaks (speechSynthesis bridge + say(1)) — *host speechSynthesis bridge (say(1) is the thin consumer)*
- **#449** Mic PCM capture — SDL3 recording shim (getUserMedia + AudioWorklet + audioPumpIn) — *host/SDL mic capture shim*
- **#454** test_os_boot.js runs at the executor timeout boundary (619.7s measured vs ~600s ceiling): killed 5x then passed; registry budget 900s and its '333s solo' comment is ~2x stale — *test estate (executor timeout boundary)*
- **#465** the browser tier has NO suite-membership guard: a test outside the os-*.mjs discovery glob belongs to no suite and nothing reports it (#431's mechanism, not its instance) — *test estate (browser suite-membership guard)*
- **#468** SDL_ttf classic API as a builtin veneer over FreeType (TTF_OpenFont / TTF_RenderUTF8_*) — mirrors the SDL_image contract; TTF_Text deliberately excluded — *SDL_ttf classic API veneer*
- **#471** tests/host/run.js: ROW_RE accepts '../..' but the refusal message and comment both promise 'one sibling' (enrolment gap stays CLOSED — prose/code mismatch only) — *test estate prose/code mismatch*
- **#479** os-compositor 'without free-running' leg: scale-free frames-per-wake bound + an inflated-coast red control — *compositor test leg*
- **#482** #473 binary-growth accounting (1,132 B) does not reproduce at the exact reviewed range (2,252 B measured) — *build/binary-size measurement follow-up*
- **#492** P0: kernel timed wait overshoots ~36% (usleep/nanosleep/SDL_Delay) — textbook 60Hz game loop runs at 44.5 fps — *kernel timed-wait accuracy*
- **#494** No text rendering for SDL3 games: SDL_RenderDebugText absent, no SDL_ttf, freetype unlinkable — a score display needs a hand-rolled font — *SDL veneer text-rendering gap*
- **#496** API honesty: SDL_TEXTUREACCESS_TARGET is declared and CreateTexture accepts it, but SDL_SetRenderTarget does not exist — *SDL veneer API honesty (TEXTUREACCESS_TARGET)*
- **#498** DX: zlib/libpng/freetype headers are on the in-OS default include path but unlinkable — cc has no -l, so they fail at link after a clean compile — *cc toolchain linkability DX*
- **#499** SDL3 surface gap register for gamedev: 43 entry points measured absent (rotation, render scale/logical presentation, surface API, batch draws, lock/unlock) — triage — *SDL veneer gap triage*
- **#500** Poll-only SDL_Renderer game presents 20,290/s unclamped (#484's clamp is gpu-transport only); no SDL_SetRenderVSync — discussion — *SDL veneer/kernel present clamp*
- **#512** driveBoot: harness kills (ETIMEDOUT / external signal) must self-describe; SIGTERM budget kill does not reliably bound (boot.js traps SIGTERM) — *test estate (driveBoot kill honesty)*
- **#514** Adopt spawn-budget.js at the remaining inline kernel-suite spawn sites (gucman-lib/seed/gucman/git/rust/rust_std + curl bootAsync) — *test estate (spawn-budget adoption)*
- **#516** Remote/network-backed filesystem for gucOS — SCOPING pass (kernel synchronous-FS assumption vs an async MountFS) — *kernel async-FS scoping*
- **#519** SysTreeView32 — first-class win32 control (TU); regedit #336 is its consumer — *SysTreeView32 veneer control*
- **#520** SysTabControl32 — first-class win32 control (TU); taskmgr #337 is its consumer — *SysTabControl32 veneer control*
- **#521** ToolbarWindow32 — first-class win32 control (TU); NetSurf chrome #361 is its consumer — *ToolbarWindow32 veneer control*
- **#522** tooltips_class32 — first-class win32 control (TU) — *tooltips_class32 veneer control*
- **#523** msctls_trackbar32 — first-class win32 control (TU) — *msctls_trackbar32 veneer control*
- **#524** msctls_updown32 — first-class win32 control (TU) — *msctls_updown32 veneer control*
- **#526** [deferred] win32 exotic controls — umbrella tracking (unscoped, deferred) — *win32 exotic-controls umbrella (veneer)*
- **#527** SDL_ttf modern TTF_Text / TTF_TextEngine API — surface + renderer engines only (GPU and GL engines are unreachable on this tree) — *SDL_ttf TTF_Text veneer*
- **#528** SDL_GPU is absent and UNTRACKED — tracking ticket so deferral edges (TTF_Text's GPU engine) point at something real — *SDL_GPU veneer tracking*
- **#529** SDL_mixer is unfiled — and the audio foundation is partial: no SDL_LoadWAV, no SDL_CreateAudioStream, no SDL_MixAudio (two simultaneous sounds has no supported path) — *SDL_mixer/audio veneer foundation*
- **#531** SDL corpus rung 1a: vendor upstream SDL's testautomation harness and bring up testautomation_render end-to-end (the external oracle we have never had) — *SDL testautomation corpus targets the veneer*
- **#532** SDL corpus rung 1b: the remaining testautomation subsystems (surface, pixels, audio, events, keyboard, mouse, timer) once #531 settles the seam — *SDL testautomation subsystems (veneer)*
- **#537** __secs_to_tm still walks years linearly in the secs-to-fields direction — *libc __secs_to_tm*
- **#538** GNU statement expressions ({ ... }) are unsupported, and they are what actually blocks the CPython hashlib family — *compiler (GNU statement expressions)*
- **#541** wmctl has no way to resolve a window NAME to a SID — every verb requires the numeric SID from 'wmctl list' — *wmctl name resolution (wm tooling)*
- **#544** Re-vendor clang-simplified's libc pin (todos/0330) — retires #539's #ifdef __clang__ guard and the -Dwcstol rename — *toolchain (clang-simplified libc pin re-vendor)*
- **#545** gucman has NO upgrade path — an installed package can never be updated (strands #177 and #365 in the netsurf package) — *gucman upgrade path (platform tooling)*
- **#547** browser harness: record a run-start marker for killed runs, and bound the unbounded protocol awaits (page.evaluate / keyboard.type / raw-CDP) — *test estate (browser harness bounds)*
- **#550** liabilities.test.js is IDENTITY-KEYED to live register entries, so closing a liability (its own success path) turns the gate red — *test estate (liabilities gate keying)*
- **#552** Non-member browser tests bind ports owned by sweep members (11 of 17 duplicate port groups contain a member) — *test estate (browser test port collisions)*
- **#555** DESIGN: what do we still owe the BLOCKED-PRODUCER GPU class after #551? (presenter-worker vs JSPI vs neither — the ~4.6min ghost-freeze residual is REFUTED) — *kernel/compositor GPU-class design*
- **#556** JSPI: suspend the wasm frame at the park imports so a blocked worker genuinely yields (present + device recovery + mapAsync) — CHILD B of the #555 design — *JSPI park suspension (host/kernel)*
- **#557** presenter-worker: a yielding sibling owns device+canvas and executes the draw stream — CHILD A of the #555 design (DEPRIORITIZED, may be dropped) — *presenter-worker (compositor/host)*
- **#558** A wasm that fails instantiation dies as exit 139 with an EMPTY stderr — a LinkError is indistinguishable from a real SEGV inside the OS — *kernel/host instantiation diagnostics*
- **#560** run.py run_disw_tests walks every subdir, so the first run's __pycache__ silently SKIPS a test from run 2 onward — *test estate (run.py pycache skip)*
- **#562** os-loopguard.mjs #551 AppInit-allowance leg is timing-flaky: 60% failure under load (splashcb AppInit present misclassified as main()-present) — *test estate flake (os-loopguard timing)*
- **#563** PKGDEV: in-OS packaging — a gucman-build verb producing deterministic .pkg.tar.gz inside gucOS — *gucman build verb (platform packaging tooling; enables package-side dev)*
- **#564** PKGDEV DESIGN: publish path — how in-OS-developed packages reach the served repo (git-push+host-CI vs upload) — *publish-path platform design*
- **#566** PKGDEV: /usr/doc self-contained in-OS development documentation baked into the image — *baked platform documentation (/usr/doc)*
- **#567** [in_progress] PKGDEV: queue classification sweep — label every open ticket OS-proper vs package-side — *queue/process meta-work on the host-side test+build estate side of the split*

## package-side (73)

- **#2** 0080 — Cairo: enable the PDF/SVG output surfaces (document export / printing) — *vendored Cairo library surfaces (document export for apps)*
- **#6** 0050 — pdpmake + busybox diff/patch — *vendored ports (pdpmake, busybox diff/patch applets)*
- **#11** 0086 — SameBoy save states (save_state.c) + core pickability — *SameBoy vendored port*
- **#19** 0117 — MicroPython: script runner + FS import (multi-round, unlocks /bin/python) — *MicroPython vendored port/package*
- **#22** 0122 — Chibi Scheme as the official Scheme (R7RS REPL + script runner) — *Chibi Scheme vendored port/package*
- **#24** 0124 — Paint v2: selection region + bitmap clipboard (Cut/Copy/Paste), New-with-size dialog — *paint app v2 (app over the veneer)*
- **#27** 0130 — Default Programs applet — GUI file-association editor in ctlpanel — *ctlpanel Default Programs applet (app UI over openwith/cfgstore)*
- **#28** 0131 — Control Panel restyle — XP/Win7-era category hub + search — *ctlpanel app restyle*
- **#95** 0454 — shimgvw port: ReactOS image viewer as THE gucOS image viewer — *shimgvw vendored port (image viewer)*
- **#98** 0290 — NetSurf Lane D — binding fills (canvas2D, rAF, document.title, innerHTML getter, querySelector, Date.now resolution) — *NetSurf port (JS binding fills)*
- **#120** 0317 — NetSurf: mouseover/mouseout/mouseenter/mouseleave and focusin/focusout (Lane C deferral) — *NetSurf port (mouse/focus events)*
- **#128** 0331 — Ship python-clang as a gucman package (needs a CPython vendor tree) — *python-clang gucman package (vendor tree + def)*
- **#132** 0343 — vendor libbz2 so CPython's `bz2` (and `tarfile`'s bz2 leg) imports — *vendored libbz2 (CPython dependency)*
- **#133** 0344 — vendor xz/liblzma so CPython's `lzma` (and `tarfile`'s xz leg) imports — *vendored xz/liblzma (CPython dependency)*
- **#134** 0345 — port ncurses over the gucOS tty so CPython's `curses` imports — *ncurses vendored port over the tty*
- **#135** 0346 — SCOPING ONLY: price Tcl + Tk + a gucOS display backend for `tkinter` — *Tcl/Tk port scoping*
- **#138** 0350 — zip as a LIBRARY in the image — measure libarchive vs libzip, then vendor one — *vendor a zip library (libarchive vs libzip)*
- **#139** 0351 — `/bin/zip` and `/bin/unzip` built on the item-1 library — */bin/zip and /bin/unzip apps*
- **#140** 0352 — `/bin/mgpp` reads `.mgpp` — a zip bundle of the deck plus its assets — *mgpp deck-bundle app*
- **#149** 0371 — Rebuild the software manager on the real ListView (THE consumer of 0370) — *software-manager app rebuild on ListView*
- **#160** 0389 — NetSurf A1: html5lib-tests tokenizer + tree-construction conformance vs libhubbub, plus Acid1/Acid2 headline — *NetSurf conformance (tokenizer/tree construction)*
- **#161** 0390 — NetSurf A2: libcss upstream test/data parse+select conformance (engine-level, no pixels) — *NetSurf libcss conformance*
- **#162** 0391 — NetSurf A3: test262 subset vs Duktape 2.7.0 — a measured ES level — *NetSurf JS (test262 vs Duktape)*
- **#163** 0392 — NetSurf B: runtime binding probe + a MEASURED HTML/CSS/JS support statement replacing the inherited README claims — *NetSurf measured support statement*
- **#164** 0393 — NetSurf C: text-editor design answer — confirm the walls and spec a gucOS-native file read/write seam, or overturn them with B evidence — *NetSurf design (file read/write seam in the port)*
- **#165** 0394 — NetSurf D: gucman-installable packages for the more involved demos + corpus showcase pages, browsable in-OS — *NetSurf demo packages*
- **#166** 0395 — NetSurf E: W3C CSS2.1 reftest suite as its OWN lane — visual/reftest, needs a golden-image harness — *NetSurf CSS2.1 reftest lane (port acceptance; harness is the vehicle)*
- **#174** 0408 — netsurf JS: HTMLElement.style is a disconnected stub - style property writes are silently lost — *NetSurf JS style binding*
- **#178** 0426 — netsurf: two shapes the dynamic-restyle chain walk does not cover — *NetSurf dynamic-restyle chain*
- **#194** 0450 — Video player v1: MP4/ISO-BMFF demux in C + H.264 video-only playback paced by vsync — *video-player app (demux + playback over the seam)*
- **#195** 0451 — Video audio, A/V sync and seek: AudioDecoder into the mixer ring, audio-master clock — *video-player app (audio/sync/seek)*
- **#197** 0455 — solitaire + spider via clang: the first C++-on-veneer rung — *solitaire/spider C++ ports*
- **#198** 0456 — ATL leg: vendor ReactOS ATL + COM-lite on libcxx-mini, WITH_EXCEPTIONS packaging — *vendored ATL/COM-lite for ports*
- **#199** 0457 — mspaint-clang: the ATL consumer as an optional *-clang gucman package — *mspaint-clang package*
- **#200** 0386 — design/diagnosis: what makes `test_netsurf_mutation_e2e.js` read 285 vs 234 — *NetSurf test diagnosis*
- **#202** 0458 — term: clear command + ESC[3J + Cmd+K clear (macOS Terminal.app parity) — *term app feature (baked, but codes wholly above the pty interface)*
- **#203** 0459 — software manager: WS_THICKFRAME + WM_SIZE relayout (resizable, crisp text at every size) — *software-manager app relayout*
- **#276** paint: WS_THICKFRAME + WM_SIZE relayout (win32 resize sweep) — *paint app relayout (win32 resize sweep)*
- **#290** cpython-clang interactive REPL polish: exec_prefix warning, truncated banner, pyrepl terminfo shim — *cpython-clang REPL polish (package app)*
- **#292** [deferred] D2 — gucos-rust: codex HttpTransport over the fd HTTP ABI, with a streamed SSE proof — *codex port HttpTransport (Rust app port)*
- **#295** [deferred] D5 — apply the D1 selection rule (port vs native), decided by M1+M2 — *codex port approach decision (port vs native)*
- **#297** gchat Phase 0 — win32 shell over the gcode CLI — *gchat app Phase 0*
- **#298** gchat Phase 1 — make it look right (typography + AlphaBlend) — *gchat app Phase 1*
- **#299** gchat Phase 2 — in-process streaming, Stop/cancel, session sidebar — *gchat app Phase 2*
- **#300** gchat web track — cc-lite in a browser tab (DECISION ITEM) — *gchat/cc-lite decision (gcode-family app track)*
- **#307** term.c: document that a term-spawned child gets a FIXED env (the ~/.profile + login-shell route is the supported one) — *term app env documentation*
- **#308** os-gcode.mjs leg 3: resize assertion does not guard the captured-width invariant its screenshot demonstrates — *os-gcode test assertion (subject: the gcode app)*
- **#331** W4 — port: charmap (ReactOS, C) — *charmap vendored port*
- **#333** W4 — port: taskmgr-lite — *taskmgr-lite app port*
- **#336** Win32 corpus C1 — vendor ReactOS regedit (THE TreeView test; SysTreeView32 is currently UNIMPLEMENTED) — *ReactOS regedit vendored port (consumer of the #519 TreeView control)*
- **#337** Win32 corpus C2 — vendor ReactOS taskmgr (report-mode ListView + sorting; SysTabControl32 is ABSENT) — *ReactOS taskmgr vendored port (consumer of the #520 tab control)*
- **#338** Win32 corpus C5 — vendor winfile (Microsoft, MIT, pure C) to break the ReactOS-lineage monoculture — DECIDED, not PuTTY — *winfile vendored port*
- **#340** Win32 corpus C3 — vendor ReactOS mspaint (app-owned SCROLLED CANVAS; distinct from the existing in-house 'paint' target) — *ReactOS mspaint vendored port*
- **#360** netsurf: multipart POST in the gucOS http fetcher (0433 file-upload residual) — *NetSurf fetcher multipart POST*
- **#361** NetSurf: browser chrome v1 — editable URL bar + back/forward/reload/stop (there is NO toolbar today) — *NetSurf chrome app UI*
- **#369** netsurf gate: EVERY test drives file:// — no test can observe an HTTP response-header defect at all — *NetSurf test coverage (http vs file://)*
- **#377** netsurf: Korean/CJK renders as tofu — the bundled font has no CJK glyphs (a size/packaging call, NOT the charset bug) — *CJK font packaging for NetSurf*
- **#382** mgp validating importer: vendor a deck exported from the user's own magic library, refusing what the gucOS port cannot render — *mgp deck importer*
- **#389** Control Panel: the icon grid does not reflow when the window resizes (already resizable, no WM_SIZE) — *ctlpanel app reflow on resize*
- **#400** gcode: execute_tool() returns char* — embedded NUL silently truncates a tool result (length-carrying return; #386's out-of-scope adjacent finding) — *gcode tool-result handling*
- **#437** Per-script Noto font packages: 205 families / 40.6 MB measured — bake defaults, make the rest installable (jku ask 2026-08-03) — *per-script Noto font packages (defs + bake-default split)*
- **#467** gcode: COMPACT at the context ceiling (warn, then summarize-and-drop oldest rounds) — today it grows unbounded until a 400 exits the REPL — *gcode context compaction*
- **#470** gcode: persist the assistant tool_use and its tool_result as ONE atomic record (close the crash window #462 narrowed but left open) — *gcode session persistence*
- **#472** netsurf http e2e: the positive UTF-8 title assertion is echo-contaminated and passes vacuously (test_netsurf_http_e2e.js:436) — *NetSurf e2e assertion quality (subject: the port)*
- **#475** Minimal git WRITE set — init/add/commit/branch/checkout (jku APPROVED 2026-08-04) — *git port write set (app over vendored libgit2)*
- **#478** git network leg: clone/fetch/pull/push (jku P0, 2026-08-04) — implement git_smart_subtransport_http over the Tier 2 curl veneer — *git port network leg (over the curl veneer; the net-bridge blockers are separate os-side tickets)*
- **#504** gcode cannot launch a windowed app: the bash tool wedges indefinitely, so the agent loop ends at 'it compiles' (#488 Pass B) — *gcode bash-tool wedge on windowed apps*
- **#505** gcode gives the model no gucOS orientation: unguided sessions burn the whole first turn rediscovering the platform (15 min, zero code) (#488 Pass B) — *gcode orientation context*
- **#511** gcode native: signal-before-poll race leaves a ^C latent against a silent child (residual of #510) — *gcode signal-before-poll race*
- **#517** gcode GUI Phase 0 — chat window in gucOS driving the existing os/gcode/gcode.c as a local subprocess — *gcode GUI app Phase 0*
- **#530** gcode reads no context files: add layered GCODE.md — /usr/share + /etc system layer (cfgstore precedent) and a project tree walk-up — *gcode context-files feature (GCODE.md)*
- **#536** busybox FEATURE_DATE_ISOFMT is now a pure config choice — date -D could be enabled — *busybox config choice (vendored port)*
- **#540** vendor/cpython/bin.json compileCheckSkip text names 0327, which is now merged and stale — *cpython package-def hygiene (stale compileCheckSkip text)*

## mixed (24)

- **#1** 0113 — Sound scheme v2 — preset schemes, per-event applet UI, SND_LOOP — *os: sounds.h scheme core + winmm SND_LOOP; pkg: ctlpanel per-event applet UI*
- **#26** 0127 — manual UX bug sweep (THE consolidated human dogfood pass) — *os: wm/desktop-furniture findings; pkg: app findings - the consolidated human sweep spans both*
- **#77** gucman — ROM-launchers packaging (blocked on copyright + desktop[] planting vocab) — *os: gucman desktop[] planting vocab; pkg: the ROM-launcher package defs (copyright-blocked)*
- **#150** 0372 — Migrate fileman's space-padded details columns (and comdlg32's file list) onto SysListView32 — the proof of generality — *os: comdlg32 file list (veneer); pkg: fileman details-view migration onto SysListView32*
- **#156** 0381 — git clone -> kfs -> compile -> run a real GitHub repo on gucOS (THE consumer of 0380) — *os: relay+git+cc platform integration; pkg: building a real external repo in-OS*
- **#180** 0429 — win32 DnD landing: de-stub DragAcceptFiles/DragQueryFileW/DragFinish/DragQueryPoint, WM_DROPFILES, fileman as source+target — *os: user32/shell32 DnD API de-stub; pkg: fileman as drag source+target*
- **#283** C3 — win32 consolidation: existing-app adoption + layout repair pass — *os: veneer consolidation repairs; pkg: existing-app adoption/layout pass*
- **#332** W4 — port: regedit-lite v1 (forces RegEnum* into existence) — *os: forces advapi32 RegEnum* into existence; pkg: the regedit-lite app itself*
- **#367** SPIKE: does windows.h survive the ~850-TU NetSurf constellation, and can we harvest upstream frontends/windows chrome? — *os: windows.h/veneer at 850-TU scale; pkg: harvesting NetSurf win32 frontend chrome*
- **#370** netsurf win32 event loop: NetSurf schedules re-conversion at 0 ms and WM_TIMER cannot deliver that — the re-box is silently lost — *os: user32 WM_TIMER 0ms delivery semantics; pkg: NetSurf re-conversion scheduling*
- **#372** C++ ladder Tier 4 — jsonq + the pugixml contrast consumer: prove exceptions/RTTI at app scale (the ladder's OWN named next rung) — *os: exceptions/RTTI toolchain proof at scale; pkg: jsonq/pugixml consumer apps*
- **#378** 0347 follow-on: PACKAGE sameboy-clang as a gucman package AND run the br_table A/B that justifies it (the packaging step has no ticket) — *os: br_table codegen A/B; pkg: sameboy-clang package def*
- **#383** [deferred] DECISION RECORD (deferred): deck -> gucOS video-capture pipeline shape (gucOS capture vs magic-side) — *os: gucOS capture capability shape; pkg: deck video-export pipeline*
- **#443** MEASUREMENT — LLM GUI-authoring success rate: win32 veneer vs HTML/CSS-in-NetSurf (vs optional immediate-mode spike), fixed app spec — *os: platform GUI-stack decision evidence; pkg: the LLM-authored test apps*
- **#450** Mic privacy — per-app consent + Control Panel pane + taskbar recording indicator — *os: kernel/wm consent policy + taskbar indicator; pkg: Control Panel pane UI*
- **#464** Split FreeType into standalone srclib package with automatic source linking — *os: srclib link-metadata mechanism in the build pipeline; pkg: the freetype srclib package def*
- **#502** Pass A round 2 — dogfood-direct: Opus agent builds and runs games in gucOS by hand — *os: platform friction findings; pkg: the game built in-OS (dogfood pass)*
- **#508** Pass B round 2 — dogfood-via-agent: Opus agent plays the human driving gcode to build a game — *os: platform friction findings; pkg: agent-driven game build (dogfood pass)*
- **#533** SDL corpus rung 2: the small-game ladder (Breakout, Snake+textures, Asteroids, tile platformer, audio mixing) — each rung a named acceptance gate — *os: SDL veneer acceptance gates; pkg: the ladder games themselves*
- **#548** doom-clang: the PUBLISHED artifact SEGVs in BOTH browser and headless (the shipped default game is broken) — *os: clang toolchain/libc-pin root cause; pkg: the published doom-clang artifact*
- **#565** PKGDEV DECISION: separate repo gucos-packages/ for package defs + package-side apps — scope both ways — *os: which infra stays OS-side; pkg: which defs/apps would move - the boundary decision itself*
- **#568** PKGDEV dogfood D1 round 1 — edit-build-run a real app change entirely inside gucOS (runnable TODAY) — *os: platform friction findings; pkg: real app change developed in-OS (dogfood D1)*
- **#569** PKGDEV dogfood D2 round 1 — clone/edit/build/commit/push entirely inside gucOS — *os: git/relay platform legs under test; pkg: the edited app + commit flow (dogfood D2)*
- **#570** PKGDEV dogfood D3 round 1 — full package lifecycle (develop, package, publish, install) without leaving gucOS — *os: packaging/publish platform legs under test; pkg: the developed package (dogfood D3)*
