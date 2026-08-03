#!/usr/bin/env node
'use strict';
// Runs the kernel (process control plane) test suite. See todos/KERNEL.md.
//
//   node tests/kernel/run.js                 # parallel (default -j; see below)
//   node tests/kernel/run.js --serial        # the old one-at-a-time behavior
//   node tests/kernel/run.js --filter=wm     # substring on file name
//   node tests/kernel/run.js --resume        # skip files that passed last run
//   node tests/kernel/run.js --fail-fast
//
// Engine: tests/lib/suite-runner.js (todos/0081). Every file is independent
// by construction — each e2e makes its own mkdtemp + `--image=` pair, no
// shared ports, no shared build/ writes — so file-level parallelism is safe.
// Per-file logs + an incrementally checkpointed summary.json land in
// build/test-kernel/ (an interrupted run keeps its partial verdict; --resume
// picks up from it).
const path = require('path');
const os = require('os');
const { runSuite, parseSuiteArgs, usage, matchesFilter, memoryCappedJobs, assertMemberRegistry } = require('../lib/suite-runner.js');
const { ensurePrebakedImage } = require('../lib/image-fixture.js');
const { acquireHeavyLock } = require('../lib/heavy-lock.js');
const { preflight } = require('../lib/harness-leaks.js');

// Cross-tree preflight (todos/0341) — FIRST, ahead of acquireHeavyLock(): a
// launch we are about to refuse must not first take a machine-wide lock, and
// its exit code must not be confusable with that lock's (hence 4, not 3 — see
// the header of tree-guard.js). Ahead of ensurePrebakedImage() for the same
// reason the host runner is: the bake WRITES into the script's own tree.
require('../lib/tree-guard.js').assertSameTree(__dirname, { label: 'tests/kernel/run.js' });

// Rows tagged IMG spawn os/boot.js and materialize their per-test image by
// copying the prebaked os/os-system.img fixture (todos/0082) — the runner
// bakes that fixture ONCE up front (below) when it's missing/stale, instead
// of every file re-baking an identical blob. test_os_boot.js is deliberately
// untagged: it is the bake-path test and really bakes (--no-fixture).
const IMG = { image: true };

const tests = [
  ['test_kernel.js'],       // process-table semantics over the real SAB protocol
  ['test_e2e.js'],          // real C programs in worker_threads via nodeCreateWorker
  ['test_signals_e2e.js'],  // Phase 2: async delivery, EINTR/SA_RESTART, pause, exit handshake
  ['test_itimer_e2e.js'],   // 0044: alarm/setitimer(ITIMER_REAL) -> SIGALRM — EINTR on blocked read, interval reload, DFL terminate
  ['test_tty.js'],          // Phase 3: line discipline semantics (kernel-side, no wasm)
  ['test_tty_e2e.js'],      // Phase 3: real C driven by a scripted UI bridge
  ['test_fs_e2e.js'],       // 0009: brokered fs — shared offsets, fd_actions, SIGKILL+fsck, winsize
  ['test_read_fill_e2e.js'], // 0140: a single read() of a >KP_FS_CHUNK REGULAR FILE fills the whole count (not one capped chunk) like native — the mGBA-ROM short-read class; scoped to regular files (pipes keep POSIX short-read)
  ['test_cfgstore_e2e.js'], // 0254: cfgstore.h never silently truncates — >8K user file survives cfg_set (the R3 data-loss regression), streaming replace/append/dedupe, cfg_load3 -1/EFBIG loud cap, errno on every failure path
  ['test_mounts.js'],       // 0026: MountFS — prefix routing, EXDEV/EBUSY, symlink escapes (no wasm)
  ['test_module_cache.js'], // 0037+#188: compiled-Module cache on spawn — RO immutable + rw VALIDATED keys, replace-on-rewrite, ss/no-fs exclusions, real clone e2e, in-OS recompile loop
  ['test_procfs.js'],       // 0043: synthetic /proc — Linux formats, snapshot-at-open, zombies, EROFS, GETSID (no wasm)
  ['test_readdir_page.js'], // 0241: paginated FS_OPENDIR/FS_READDIR — 3000-entry dir lists fully in order (raw RPC + RemoteFS drain), small dirs single-page, stale cursor EBADF, handle release on exhaustion AND death mid-drain (no wasm)
  ['test_pipes.js'],        // Phase 4: pipe OFD semantics over the SAB protocol (no wasm)
  ['test_pipes_e2e.js'],    // Phase 4: real C pipelines — blocking wake, EOF, SIGPIPE death
  ['test_pipes_spsc.js'],   // 0181: SPSC ring mechanics over the SAB protocol — pipe-sab handshake, LATENT->FAST->DEMOTED ladder (promotion on removal, spawn-inherit demotion, strace pseudo-holder, in-process dup stays FAST), stale-mode ring service, PR_RWAIT/PR_WWAIT doorbell + PIPE_KICK, ring EOF/EPIPE flags (no wasm)
  ['test_spsc_e2e.js'],     // 0181: real C pipelines — RPC-op counter shows 8MB moving with ZERO pipe data RPCs (wakes counted separately), fast-writer SIGPIPE via kick{epipe}, mid-stream demotion byte-identical
  ['test_strace.js'],       // 0046: per-pid RPC trace — spec.trace validation, decode, deferred/unfinished, -f inheritance, drop policy (no wasm)
  ['test_strace_e2e.js', IMG],   // 0046: /bin/strace in-OS — cat's fd stream, exit/signal status propagation, -f, -o
  ['test_pty.js'],          // 0020: pty pair semantics over the SAB protocol (no wasm)
  ['test_pty_e2e.js'],      // 0020: real C over a pty — openpty, spawn-on-slave, winsize, SIGHUP
  ['test_zerolen_read.js'], // 0253: read(fd, buf, 0) returns 0 immediately (never parks) on every brokered read kind — pipe/socket/pty-master (_streamRead) + tty FS_READ, empty stream + live writer; count>0 blocking semantics unchanged (no wasm)
  ['test_sockets.js'],      // 0008: AF_UNIX OFD semantics over the SAB protocol (no wasm)
  ['test_sockets_e2e.js'],  // 0008: real C client/server — accept/connect/send/recv, poll
  ['test_http.js'],         // 0172: HTTP transport (0x06xx) over the SAB protocol with a fake fetch — deferred status, streaming, backpressure, EOF/error split, teardown (no wasm)
  ['test_http_e2e.js'],     // 0172: real C over the full stack — Node fetch to a local server: streamed GET, POST echo, 512K integrity, 404, mid-stream drop
  ['test_curl_e2e.js'],     // 0173: the libcurl veneer differential smoke — ONE C program built gucOS (veneer) AND native (clang -lcurl, the oracle), outputs diffed after documented normalization; callbacks, getinfo, refused=7, timeout=28
  ['test_netbridge_e2e.js', IMG], // #349: the Tier 2.5 HTTP bridge — one C process flips /etc/net OFF->ON->OFF->ON-dead live (watchPath, ack-file sync) with the bridge /fetch counter as the positive control (exactly 1); wrapper EACCES/ENETUNREACH mapping, CORS/PNA preflight, origin allowlist, 502 encapsulation; boot.js leg proves the shipped embedder wiring
  ['test_ticketbridge_e2e.js', IMG], // #451: the host ticket bridge — the in-OS /usr/bin/file-gucos-ticket client through tools/ticket-bridge.js to a FAKE `file-gucos-ticket` handler the test plants on a private PATH dir (so acceptance never depends on real ticket tooling): the positive leg runs in BOTH net modes with the net-bridge /fetch counter proving the bridge-ON transit carries no special-casing, plus handler-absent 501, handler-exit-3 relayed as a HANDLER (not bridge) failure, handler timeout, unreachable bridge, 413 oversize, the CORS/PNA + origin-allowlist surface, and a driveBoot leg running the SHIPPED binary out of the baked image
  ['test_code_e2e.js', IMG],     // 0174: /bin/code in-OS vs a scripted fake SSE server — login-shell /etc/profile+~/.profile env plumbing, streamed text, write_file-on-BlockFS + posix_spawn bash tool round-trips
  ['test_gcode_step2_e2e.js', IMG], // 0174 step 2: usage accounting to stderr + durable 0600 JSONL sessions on BlockFS + -c/--resume replay across processes (fake SSE server with usage counters), in-image --self-test
  ['test_gcode_intr_flush_e2e.js', IMG], // #433: ^C mid-stream flushes queued tty type-ahead — paced interactive session (jobctl Session machinery) vs the stalling fake SSE server; POST count 1, nothing auto-submitted at the fresh prompt
  ['test_gcode_native.js'],  // #314: the NATIVE gcode oracle — runs os/gcode/test/smoke.mjs (clang + real libcurl/cJSON vs the scripted SSE server) and asserts the CHECK COUNT against the source's check( call sites, not just exit 0 (the oracle prints no total)
  ['test_jobctl_e2e.js'],   // Phase 4: real C stop/cont — WUNTRACED/WCONTINUED, output halts
  ['test_jobctl_tty_e2e.js', IMG], // interactive Ctrl-Z/fg/bg/kill %1 through hush + the kernel tty
  ['test_os_boot.js', { timeoutMs: 900000 }], // 0004: headless OS boot — seed, protoshell, cc, persistence; deliberately --no-fixture (the bake path IS under test), so 3+ full ~100s bakes put it right at the 600s default under -j4 load (333s solo)
  ['test_heavylock_e2e.js', IMG, { timeoutMs: 900000 }], // 0342 (closes 0303): the heavy lock guards the BOOT, not a caller list — under a private-TMPDIR lock scope: free-lock boot runs (leg 1), live foreign holder → exit 3 fast naming holder + CC_NO_HEAVY_LOCK with NO image work (leg 2, the RED control), verified CC_HEAVY_LOCK_PID marker joins re-entrantly with no release duty (leg 3, the nested proof), dead-pid holder stolen (leg 4), driveBoot propagates the refusal as its own exit 3 (leg 5), the escape hatch boots past a live holder (leg 6), and a hand-run os-*.mjs exits 3 at the harness before any serve.js (leg 7); 900s: four real boots, and --repeat runs them concurrently
  ['test_overlays.js'],     // 0118: opt-in image overlays — overlay@1 verify/plant/provenance over a tiny synthetic bake, every fatal rule, base-bake inertness (no wasm)
  ['test_vi_e2e.js', IMG],       // 0011: busybox vi through the real tty — raw mode, edit sessions
  ['test_repl_pty_e2e.js'], // 0036: lua/micropython/sqlite3 interactive on a kernel pty — prompt, eval, LD erase, ^D exit
  ['test_micropython_script_e2e.js'], // 0117 R1: the micropython CLI as an OS process — argv/sys.argv, open() on BlockFS, FS import, sys.exit status, traceback on fd 2 not fd 1, -c
  ['test_micropython_stdlib_e2e.js'], // 0117 R2: sys.path policy (script dir / site dir / symlink-chased package lib), two-file import from another cwd, -m, os+os.path over the kernel fs, the curated stdlib
  ['test_wm.js'],           // WM.md: surface registry, input routing, chrome, screenshots (no wasm)
  ['test_wm_anchored.js'],  // 0256 Spike 1: anchored child surfaces (A1 tree, A11 materialized dst, A5 owner child resize, clamp, cascade, thumbnail compositing) + the grab (A2) + the focus-funnel owner pair (A9) — kernel seam, no wasm
  ['test_wm_aero.js'],      // 0063: has-alpha src-over blend goldens, wmThumbnail box filter, glass headless invariance, minimize/restore anim records (no wasm)
  ['test_wm_e2e.js'],       // WM.md: real C SDL app windowed — shm present, ring input, QUIT
  ['test_menubox_e2e.js', IMG], // 0256 Spike 1 e2e: SDL_CreatePopupWindow through the real veneer — subtree drag-follow (2-deep chain), hide/show, composited child text + popup overflow, grab dismiss+consume, A5 strip resize, the owner focus pair, cascade close
  ['test_audio.js'],        // 0017: the kernel mixer — exact-value mixes, resample, lifecycle (no wasm)
  ['test_audio_e2e.js'],    // 0017: real C SDL audio streams — AUDIO_OPEN handshake, mix, SIGKILL drain
  ['test_sounds_e2e.js'],   // 0094: the event-sound scheme — PlaySound aliases/flags/mute store, MessageBeep + MessageBox beep, SYNC drain-dry reclaim
  ['test_vsync.js'],        // 0100: vsync broadcast — spawn-time advertise flag, vsyncTick bump/notify per live pcb, vsyncWait park + rAF catch-up semantics (no wasm)
  ['test_waitevent_e2e.js'], // 0161: SDL_WaitEvent(Timeout) parks on the input ring via __sdl_pump_wait — no-ring nanosleep fallback, full-timeout park, chunk-crossing wake on injected input, signal-while-parked, NULL peek
  ['test_sdl_delay_e2e.js'], // 0224: SDL_Delay cooperative in worker flavors — the classic while(running){poll;draw;Delay} corpus loop runs unmodified as an OS process: pre-ring blocking fallback, full-duration sleeps with mid-delay input queued, frame-idle release mid-delay (compositor may park), standalone-browser throw preserved
  ['test_sockwake_e2e.js'],  // 0168: kernel-socket→input-ring wake — a WMP subscriber parked in __sdl_pump_wait wakes promptly on kernel-peer socket data (EV_SCREEN), not on the park timeout; + the 0169-gate lost-notify interleave (kick lands BEFORE the park entry)
  ['test_comp_park_e2e.js'], // 0169: on-demand compositor wake protocol e2e — real C presents vs a test-played compositor: doorbell-on-present only while PARKED, WaitEvent entry drops the wantFrame pin, SIGKILL mid-pin clears it
  ['test_wait_e2e.js'],      // 0178: unified wait (FS_WAIT via __wait) — fd wake, entry-scan atomicity, pure timeout, ring wake out of an infinite park, prompt signal-EINTR with the handler run, post-EINTR re-park
  ['test_fswatch_e2e.js'],   // #75/0264: FS_WATCH — path-keyed watch fds fed from the _fsRpc choke: cross-process settle-on-close, FS_WAIT park wake, the rename-over settle (the inotify-trap case), EAGAIN contract, SELF_GONE + re-arm, dir names, one-record rename, O_TRUNC settle, overflow clear+latch with the writer unblocked, MODIFY opt-in, EINVAL/ENOENT
  ['test_realpath_e2e.js'],  // #76/0263: realpath(3)/readlink -f resolve symlinks PHYSICALLY — real busybox over the baked /bin->/usr/bin + ls->coreutils + /usr/local->/var/local chains, relative '../' targets, ELOOP failure, ENOENT-on-missing (fs.realpathSync oracle parity); the kernel FS_REALPATH RPC now walks lstat/readlink instead of the lexical _resolvePath
  ['test_symlink_create_e2e.js'], // 0375: open(O_CREAT) through a dangling symlink creates the TARGET, never a duplicate dirent — hush redirects + ln/rm/mkdir over the brokered FS RPCs: single-link create, rm removes the link only, chain create at the end, mkdir-over-dangling EEXIST
  ['test_vdso.js'],          // 0179: the seqlock vDSO block — spawn publish, zero-RPC getpgid/getsid/getppid/uptime/screen, SETPGID/SETSID/reparent/wmSetScreen republish, wedge -> RPC fallback, payload-cap arithmetic (no wasm)
  ['test_vdso_e2e.js'],      // 0179: real C reads pid/ppid/pgrp/sid off the page — RPC-op counter shows ZERO GETPGID/GETSID across setsid + orphan-reparent mutations; the libc setsid() acceptance
  ['test_rofs.js'],          // 0180: process-side read-only /usr — RemoteFS fast-path mechanics vs a fake RPC recorder: zero-RPC reads (incl. in-volume symlinks), final local errors, brokered fallbacks (relative / '..' / write-intent / escapes), RO_FD_BASE dup family, dup2/spawn-action twin promotion (no wasm)
  ['test_rofs_e2e.js'],      // 0180: real C under Kernel opts.roImage — RPC-op counter shows ZERO fs RPCs for /usr reads; EROFS after the walk, /usr/local -> /var/local escape write, DUP2-action promotion feeds a child's stdin
  ['test_wm_policy.js'],    // 0014: the WM protocol over the kernel-owned /run/wm.sock (no wasm)
  ['test_keybind.js'],      // KEYBINDING-OVERRIDE-SYSTEM §3 (CHUNK 1): the kernel key-grab table — GRAB_SET install/replace/cap/n=0, EV_HOTKEY + both-edge swallow, exact-modifier match, the Shift amendment (named vs masked) + repeat flag, non-subscriber refusal, subscriber-gone reset, the default table reproducing legacy EV_CYCLE/MENU/SNAP_KEY/SYSMENU, and the km-fold twin vs os/keys.h (no wasm)
  ['test_keybind_registry.js'], // KEYBINDING-OVERRIDE-SYSTEM §2/§5 (CHUNK 2): the keys.h named-action registry + bind.<action> override resolution + chord parse/format, exercised by a native-C probe (clang, no boot) — registry defaults per scheme (macos line/doc-nav + Ctrl+Alt+arrow tiling + F3 overview), rebind moves/none unbinds/default restores/malformed loud-fallback, readline-row immunity, scheme-independence, parse/format round-trip, and the ks_chord_scancode twin vs kernel.js WM_DEFAULT_GRABS
  ['test_wm_service_e2e.js', IMG], // 0014: real /bin/wm + wmctl through os/boot.js — autostart, taskbar, crash+respawn
  ['test_snap_e2e.js', IMG],     // 0095: Aero Snap — drag-to-edge tiling via wmctl sdown/smove/sup, translucent preview pixels, drag-off restore, quarters, wmctl snap (= Win+arrow), fixed-size letterbox, no-WM refusal
  ['test_overview_e2e.js', IMG], // EXPOSE: window overview / Exposé — wmctl overview enters (live miniatures in wmctl shot), PICK focuses+raises+exits, background dismiss, relayout on create/destroy, N=0 no-op, no-WM refusal
  ['test_ksvc_e2e.js', IMG],     // 0275: the ksvc kernel-C text service — headless composite label text (titles, close 'x', Exposé captions) bit-compared against os/ksvc.js rendering over the SAME image (the same-bytes assertion), ellipsis on overlong titles, CJK tofu parity
  ['test_saver_e2e.js', IMG],    // 0096: the screensaver — kernel idle clock (wmctl idle), idle raise + input dismissal + clock reset, marquee animation shots, saver none, wmctl saver (= ctlpanel Preview), the Screen Saver applet store writes, no-WM refusal
  ['test_cursor_e2e.js', IMG],   // 0105: pointer cursor shapes — per-surface SDL_SetCursor readback (wmctl cursor = CURSOR_AT/R_CURSOR), chrome resize cursors on resizable frames (EW/NS/NWSE), title/desktop/fixed-frame arrow
  ['test_os_apps_e2e.js', IMG],  // 0015: seeded vendor apps windowed in-OS — bin-entry game data, real frames via wmctl shot
  ['test_sameboy_e2e.js', IMG],  // 0075: /bin/sameboy (cycle-accurate GB/GBC core) — exact DMG grey shades, animation, CGB colorful frame, sameboy is the baked .gb/.gbc default
  ['test_mgba_e2e.js', IMG],     // 0112: /bin/mgba (mGBA 0.10.5 GBA core — ARM7TDMI, HLE BIOS) — built-in MODE3 test ROM renders a red frame at 480x320, .gba defaults to mgba, .gb/.gbc stay sameboy
  ['test_punes_e2e.js', IMG, { timeoutMs: 900000 }], // 0088 + 0213 (registered by #167): /bin/punes (puNES NES/Famicom core — 6502/2C02/2A03) — built-in NROM test ROM composites a solid palette-$21 blue frame at 512x480, .nes defaults to punes, and the D-pad regression guard (held Up must tint the backdrop green — the SOCD filter used to erase it). Shape sibling is test_mgba_e2e.js, but this file drives THREE boots whose own driveBoot deadlines already sum to 660s, past the 600s suite default — hence 900s, sized like test_heavylock_e2e.js's four-boot row
  ['test_cairo_e2e.js', IMG],    // 0061: cairo image backend -> shm — in-OS selftest (gradients/AA/cairo-ft anchors), windowed scene via wmctl shot, theme repaint, vector re-render on resize
  ['test_gdi32_e2e.js', IMG],    // 0057: win32 gdi32 — in-OS selftest (GDI semantics + leak check), windowed scene probed via wmctl shot, bit-exact repaints
  ['test_multiface_font_e2e.js', IMG], // C1/#281: multi-face CreateFont — NULL-face default byte-identical to mono (no flag day), proportional sans/serif metrics, real bold/italic files preferred (sans italic advances shift) vs synthetic shear (mono/serif italic advances preserved), drawn underline/strikeout rules, the Win32 name mapper, /etc per-face override, per-face ramp shots
  ['test_user32_e2e.js', IMG],   // 0058: win32 user32 — blocking GetMessage loop, lifecycle order, controls, MessageBox modal, wmctl tree/click-by-label agent path
  ['test_lb_vscroll_e2e.js', IMG], // 0275 (#275): LISTBOX built-in WS_VSCROLL bar — show-when-needed pixels, arrows/channel/thumb-drag through the real input path, wheel/keys share the lb_vscroll clamp (thumb sync)
  ['test_listview_e2e.js', IMG], // 0370: SysListView32 + SysHeader32 + the AQM agent seam — lvtest message surface, rows/columns addressable by NAME (wmctl click/gettext/wait text, lvrow/hdcol tree lines), sort via header click, LISTBOX rows retrofitted as click targets
  ['test_kernel32_e2e.js', IMG], // 0059: win32 kernel32/advapi32/wide-CRT — in-OS selftest, POSIX-twin identity, registry persistence across boots
  ['test_win32_ports.js'],  // 0060: port corpus compile-check — controls still link clean, PORTS.md (the 0059+ backlog) current
  ['test_win32rc.js'],      // #311: rc NOT semantics — bare/combined/#define-carried NOT clears bits from the assembled style, keyword defaults included
  ['test_winmine_e2e.js', IMG],  // 0068: winmine playable — sidecar resources, menu bar/popups, SURFACE_RESIZE, dialogs from templates, WM_TIMER, registry persistence
  ['test_calc_e2e.js', IMG],     // 0048: calc usable — WRES v2 template menus, owner-draw keypad, clipboard file + menu re-gray, keyboard translation, TrackPopupMenu agent path
  ['test_notepad_e2e.js', IMG],  // 0048: notepad usable — EDIT-around-a-file (EM_*HANDLE), comdlg32 file dialogs + find/replace protocol, status bar, MB_YESNOCANCEL, ShellExecuteW
  ['test_notepad_menu_e2e.js', IMG], // 0222: EVERY notepad menu item — effect or loud refusal (grayed items refuse agent clicks; Font/Print/PageSetup report unsupported), WM_SETTEXT caret-to-start, the win32rc \r fix pinned
  ['test_edit_punct_repro.js', IMG], // #430: punctuation keysym→VK collisions (' = VK_RIGHT, . = VK_DELETE) — 13-key EOL insert matrix + type-over-selection replaces; RED until #430's vk_of OEM remap lands
  ['test_comdlg_diag_e2e.js', IMG], // 0255 R4: short listings say so — list_dir TRUE count past the fill cap, deleted-cwd "(cannot open directory)", 520-entry "(8 more...)" marker (dialog + fileman, TRUE status count), and a REAL OOM "(cannot allocate...)" row via the heap-ballast fixture under --wasm-max-mem-pages
  ['test_wm_fatal_e2e.js'],  // 0255 R5: wm fatal diagnostics name the failing layer — EV_SCREEN recreate + initial make_desk/make_bar report SDL_GetError() via fatal_sdl (pre-fix: stale strerror(errno) "Success"-class lies), forced through the kernel's real >8192 SURFACE_CREATE refusal
  ['test_fileman_e2e.js', IMG],  // 0048: file manager — dirs-first LISTBOX listing, Go/Up/Open navigation, 0066 activate() launch semantics, resize reflow
  ['test_cmdalt_e2e.js', { timeoutMs: 900000 }], // 0338: the command-alternatives dispatcher — /usr/bin/cmdalt multicall (basename(argv[0]) = the key), verbatim argv forwarding, exit/signal status, 127-never-silent-fallback, #! links, self-dispatch refusal, layer precedence + reset, a SECOND dispatched name with no C change, and the three PATH-shadow diagnostics (which/list/set); session B installs micropython from a real mkpkg repo to prove the `commands` claim round-trip and `python` end to end; shares the cached minimal blob + mkpkg pool with the gucman e2es
  ['test_openwith_e2e.js', IMG], // 0072: openwith associations — open(1) --set + resolver order + carry-forward, fileman Open/With picker persistence, desktop .gb dblclick → sameboy (registered by 0108)
  ['test_fileman_ops_e2e.js', IMG], // 0092: file ops — context menu, F2/Del accelerators, rename dialog, clipboard file-list cut/copy/paste (incl. the wm.c desktop menus, cross-app), delete confirm + EROFS, properties
  ['test_fileman_nav_e2e.js', IMG], // 0106: navigator v2 — details columns + status strip, LBS_EXTENDEDSEL multi-select (Ctrl-click/Shift-range/multi-delete), Enter/Backspace, F5 refresh, View sort/show-hidden, Alt+Left back
  ['test_paint_e2e.js', IMG],    // 0107: Paint accessory — memory-DC canvas, tool menu + palette (filled rect, flood fill), single-level undo, 24-bit BMP save/open round-trip via comdlg32
  ['test_recycle_e2e.js', IMG],  // 0093: the Recycle Bin — trash/restore/empty through fileman + the wm.c desktop (bin icon glyph, icon DELETE, bin menu), sidecars, Shift+Del bypass, EROFS no-stray
  ['test_ctlpanel_e2e.js', IMG], // 0048: control panel — AUDIO_GAIN control plane end to end (__audio_gain import, kernel state across processes), os-release//proc info panel
  ['test_term_e2e.js', IMG],     // 0020: /bin/term — hush on a pty in a window, vi inside, resize reflow, shot pixels
  ['test_netsurf_e2e.js', IMG],  // NetSurf Lane 2: the gucOS frontend renders real documents in-window — ~600-TU build, freetype AA text pixels, title-follows-<title>, resize reflow (float re-wrap), wheel/PageDown/Home scroll, click-a-link navigation, wmctl close exit
  ['test_netsurf_layout_e2e.js', IMG],  // NetSurf Lane 4: layout fidelity as exact box geometry — table cell grid, margin/border/padding arithmetic, inline-block wrap, form-control rendering, serif/mono-bold faces really load
  ['test_netsurf_content_e2e.js', IMG], // NetSurf Lane 4: in-app image decode (GIF/BMP/ICO/PNG + data:-URI + scaled), data:text/html from the CLI, the fetch-error page, the baked welcome page + about:logo, the Desktop icon seed
  ['test_netsurf_js_e2e.js', IMG],      // NetSurf JS Lane A: enable_javascript is ON BY DEFAULT in the gucOS frontend, setInterval+putImageData repaints with zero input, a real SDL click reaches a DOM listener, and ${HOME}/.netsurf/Choices enable_javascript:0 is still the off-switch
  ['test_netsurf_console_e2e.js', IMG], // todos/0421: a page's console output reaches the shell's tty — every console level under its own name, a multi-line entry prefixed on both lines, the trailing-newline and empty-entry branches, and `2>FILE` proven to be the off-switch
  ['test_netsurf_mutation_e2e.js', IMG], // NetSurf JS Lane B: the mutation->re-box->reflow->repaint bridge in the real frontend — demos/stopwatch.html's setInterval textContent write reaches PIXELS with zero input, a real SDL click createElement/appendChild's then removeChild's a visible block, and the SCROLL OFFSET (decoded from a colour-coded ruler page) survives a re-conversion
  ['test_netsurf_events_e2e.js', IMG],  // NetSurf JS Lane C (todos/0289): UI event coverage through the REAL SDL input map — a wmctl drag paints the `paint` demo's canvas where the pointer went (and nowhere else, so the coordinates are asserted not assumed), a real key press AND its release both reach the FOCUSED field (keyup needed a new core path), a real click runs a CAPTURE-phase listener, and clicking away from an edited field commits `change`
  ['test_netsurf_img_reconvert_e2e.js', IMG], // todos/0410: an <img> keeps rendering after a mutation-triggered live re-conversion — deck-shaped page (abs-pos base layer, opaque cover toggled by click), WIDTH-ONLY img (the REPLACE_DIM-less shape whose box needs the object's intrinsic size), ink asserted after the 1st and 3rd re-conversions; pins the DONE-status completion-reformat branch in object.c
  ['test_netsurf_pointer_e2e.js', IMG], // todos/0419 (P0) + todos/0420: the pointer path of html_mouse_action — a click listener that calls preventDefault() really stops the link AND its own restyle survives to paint (the dispatch result used to be discarded), a link whose listener does NOT cancel still navigates (the control that keeps the fix honest), and the dynamic pseudo-classes work: `a:hover` paints on entry and CLEARS on exit, `#outer:hover` paints with the pointer on a span inside it (:hover is a chain), and `:active` paints only between a button-down and its release
  ['test_netsurf_dragslop_e2e.js', IMG], // todos/0427 (P0): a held button reports HOLDING_* from the press on, not from the DRAG_SLOP promotion on — press + sub-slop move (3 px) arrives as a mousemove with buttons=1 and NOT as a mouseup (the unfixed frontend synthesised a mouseup inside the 5 px slop window, killing every drag on every page), the one mouseup lands at the release after the moves, a motionless click still ups exactly once (the CLICK_1 path), and a press released inside the slop ups exactly once (not twice).  In-OS by necessity: smoke-js drives the monkey frontend, which never executes gucos/gui.c
  ['test_netsurf_select_e2e.js', IMG], // todos/0422: the CORE select menu is ON by default in gucOS — a <select> click opens the in-content menu (selected-row band + occlusion oracle), choosing fires `change` and repaints the widget text, six scrollbar-arrow clicks scroll exactly 96px and re-map the row→option pick, an outside click dismisses without an event, a <select multiple> toggles per click and STAYS open, and the option widens the closed widget by exactly SCROLLBAR_WIDTH (the layout half, measured against a --core_select_menu=0 control window whose click still paints nothing)
  ['test_netsurf_filegadget_e2e.js', IMG], // todos/0433: <input type=file> opens the OUT-OF-PROCESS /bin/filepick (comdlg32 GetOpenFileNameW; the win32 modal pump cannot share netsurf's SDL process) — the dialogue opens on its own agent socket starting at $HOME, a second gadget click under it is ignored, Cancel fires NO event, a typed absolute path + Open fires exactly one `input` with the value and repaints the gadget, a re-open starts at the last accepted directory, and a GET submit carries the VALUE in the query while GW_EVENT_NEW_CONTENT kills the still-open picker (the BYTES half needs an http fetcher: todos/0437)
  ['test_netsurf_select_reconvert_e2e.js', IMG], // todos/0434: an OPEN core select menu survives a live re-conversion — a mid-menu change listener's JS mutation re-boxes the document while the menu is up; the settle rule re-attaches (unrelated option.selected write: menu stays open, band at its EXACT 96px-scrolled row, one change event) or dismisses (the anchor option removed: menu closes, NO change event fires), and an appended selected option grows the scroll range (its band reachable at the 21-item clamp); every leg's #mark strip proves the re-conversion really ran
  ['test_netsurf_restyle_e2e.js', IMG], // todos/0316: a class-selector restyle on an EXISTING element repaints, promptly — one click rewrites an existing element's class (`.slab.on`), gives a class-less one its first (`#idsel.on`), creates one carrying the same compound selector, and fills a canvas; all five probes must light in the SAME frame, which pins both defects (libdom's never-refreshed class cache, and the gucOS loop parking on a deadline sampled before the JS handler scheduled the re-conversion)
  ['test_netsurf_http_e2e.js', IMG],    // #182 (todos/0437): REAL NETWORKING — the gucOS http/https fetcher (gucos/httpfetch.c over the kernel HTTP transport) against a live local server: an http: page renders end to end, a GET form's query and a urlenc POST's body reach the wire, a redirect renders the FINAL page with llcache's refetch observed server-side and the relative <img> resolving against the FINAL directory (the #359 x-guc-final-url payoff, asserted in BOTH direct and bridge modes), a 404 body renders as content, and DNS-failure/connection-refused/headers-timeout each raise the fetch-error query page instead of a hang
  ['test_netsurf_demos_e2e.js', IMG],   // the `seed` content resource kind's first consumer (packages/netsurf-demos.json): a fresh fat boot carries every declared file byte-for-byte under Desktop/Presentations/samples/Web Demos (derived from the package + os-common's tree walk, never a list), the pre-existing sample survives the additive merge, the Desktop icon set is untouched, and EVERY seeded demo really runs — its load-check pill goes green only if the page's EXTERNAL stylesheet AND EXTERNAL script both loaded (two negative controls: script removed = red, stylesheet removed = colourless)
  ['test_present_e2e.js', IMG],  // 0119: /bin/sent + /bin/mgp — demo decks render (glyphs, %default bg, %tab icons), paging, q quits
  ['test_mgpp_e2e.js', IMG],     // 0272: /bin/mgpp — MagicPointPlus fork (-DMGPP): left-half click / Left arrow go BACK, right-half / Right arrow forward; space/b/q unchanged (pixel-identity page assertions)
  ['test_mgp_livereload_e2e.js', IMG], // #75/0264: mgp live-reload — the deck watch is wantreload()'s ONE source (ctime poll gone): external tmp+rename-over and truncate-rewrite saves re-render, background-color-proven
  ['test_deck_e2e.js', IMG],     // 0284: /bin/deck — --validate/--shot goldens on the seeded demo, self-maximize, FS_WATCH live reload (rename-over, slide preserved BY ID), broken-save last-good + red banner + recovery, Ctrl-R, openwith .deck
  ['test_fileman_watch_e2e.js', IMG],  // #75/0264 (closes 0123): fileman auto-refresh — external create/rename-over/delete re-list unprompted via RegisterFdWake→WM_FSCHANGE, selection carried by name, navigation re-arms
  ['test_clipboard_e2e.js', IMG], // 0090: the system clipboard — kernel slot via /bin/clip, notepad copy/cut/paste across processes, term drag-select + Ctrl+Shift+C/V
  ['test_pbcopy_e2e.js', IMG], // 0397: /bin/pbcopy + /bin/pbpaste over os/clipio.h — the macOS names on the SAME one kernel slot as /bin/clip (interop asserted both directions), empty-slot exit 1 printing nothing, argv refused with exit 2, the clip refactor's contract unchanged, 170KB chunking, the recorded text-only NUL limit (with a negative control), and notepad paste/copy through the win32 veneer
  ['test_hostclip_e2e.js'], // ticket #79 + the clipboard seam: onClipboard fires at CLIP_SET commit (loop guard, clear reports null); deferred CLIP_GET parks a data read on onClipRead's done (first paste fresh by construction), SDL_HasClipboardText peeks without firing the hook, SIGKILL-while-parked tears down cleanly and a late done() is a no-op
  ['test_egress_e2e.js', IMG], // 0398: the gucOS->host egress seam headless — os/egress.h -> EGRESS RPC -> onEgress: lone file bytes, lone-symlink follow, dir/multi store-only zips (symlink entries, empty dirs, CRCs), ENOENT/EINVAL/E2BIG/EFBIG(pre-read, sparse-proven)/ENOSYS, the boot.js --egress-dir twin + '-N' collision suffix
  ['test_keymap_e2e.js', IMG],   // 0149/0150: the keyboard scheme (os/keys.h) — windows/macos verb tables in EDIT, the FCONTROL accel swap (fileman), term ⌘V/⌘C vs Ctrl+Shift, readline rows + off-switch, 1Hz live revalidate, ctlpanel Keyboard applet delta-writes
  ['test_hostpaste_e2e.js', IMG], // ticket #96/0432: paste legibility + robustness — /run/host-platform verdict both values, the implicit host-native ⌘V paste row on a STALE windows-scheme volume (no scheme flip, no user-config write, non-mac negative control), the drawn menu accel field (Ctrl+V vs Cmd+V, the menucore choke), ctlpanel Keyboard effective-chord listing + live flip
  ['test_ctxmenu_e2e.js', IMG],  // 0091: right-click context menus — wm.c desktop/icon/taskbar popups (geometry, dismissal, flyouts, keyboard nav), EDIT WM_CONTEXTMENU via the agent, ctlpanel argv
  ['test_desk_icons_e2e.js', IMG], // ticket #82: per-filetype desktop icon glyphs — desk_kind dispatch (exec/text/image/deck/generic/dir/bin), center-pixel contract: navy = program/folder/full-bin, white = data files/empty bin
  ['test_desktop_defaults_e2e.js', IMG], // Lane D (source-lib §6): the baked /usr/share/desktop/default rendering + /usr/bin/desktop-defaults additive reconcile — deleted defaults restored (link/script/nested data), user files + name-squats never touched, idempotent re-run, phase-2 installed-package icons (explicit action beats the flag, DB-recorded), the wm.c ctx-menu row
  ['test_gpubox_dawn_e2e.js', IMG], // 0016 tier 1: gpubox (webgpu.h) under Dawn — readback->shm shots, tolerance-diff; SKIPs without the webgpu pkg
  ['test_gpubox_menu_e2e.js', IMG], // 0258 M2 acceptance: gpubox's win32 menu WITHOUT Dawn — A14 no-GPU survival, bar/popup children over the black client, Spin/Wireframe via the agent; forces tier 0 via lib/nodawn-require.js
  ['test_gpu_multiwin_dawn_e2e.js'], // menu item 0 / A4: TWO GPU windows, per-window present binding — each shows ITS color, no newest-wins clobber; SKIPs without the webgpu pkg
  ['test_cc_srclib.js'],    // Lane A (source-lib §1) unit legs, no boot: systemIncludePaths tier order + the builtin-beats-ambient precedence (-I still shadows), __require_source FS tiers (sourceRoots exact map, sourcePaths search), name validation (traversal loud), path-identity dedup, buildProject/CLI srcRoots plumbing + --srcroot conflicts
  ['test_cc_srclib_e2e.js', IMG], // Lane A e2e: in-OS cc pulls a shell-planted synthetic lib from /usr/local/{include,src} (no -I, no TU list), transitive FS requires + same-dir quote includes, '..' require name is a loud error, planted builtin twins (__SDL.c/__alloca.c/stdio.h) stay inert
  ['test_cc_libpng_e2e.js', { timeoutMs: 600000 }], // Minesweeper lane: in-OS cc builds a libpng WRITE→SDL_image IMG_Load READ round trip pulling the folded libpng package via the builtin <SDL3_image/SDL_image.h> require block (no -I, no TU list); asserts decode dims/pixel + SDL_DestroySurface owned-free + libpng folded "Built-in"
  ['test_gdiplus_e2e.js', IMG], // 0453/#94: gdiplus-mini — the 29 flat GDI+ entry points DERIVED from ReactOS shimgvw @e3e58ac1, driven in-OS via `gdiplusdemo selftest`: PNG/GIF/BMP/JPEG each decode through the shim from an independently-encoded fixture AND each has a can-fail control (corrupt/truncated bytes must be rejected), the 2x NEAREST StretchBlt draw asserted pixel-exact, rotate/flip as a pixel loop (StretchBlt refuses mirroring extents), static codec tables + PNG/BMP save round trips, the ole32 memory IStream, and the fail-loud refusals with their WIN32_UNSUPPORTED stderr lines; the check TOTAL is pinned so a shrinking selftest cannot still print PASS
  ['test_cc_libjpeg_e2e.js', { timeoutMs: 600000 }], // 0448/#93: in-OS cc builds a libjpeg encode→decode round trip pulling the folded libjpeg package via the program's OWN __require_source block (no veneer exists — the consumer carries it; no -I, no TU list); asserts exact decoded pixels vs the clang-native golden, corrupt-stream rejection through the error manager (the can-fail control), libjpeg folded "Built-in"
  ['test_minesweeper_sample_e2e.js', IMG], // v163 tap-to-run sample: the ONE Desktop/Presentations/samples .sh (0755), dblclick folder -> fileman -> open it -> the `[ -n "$TERM" ] || exec term "$0"` guard re-execs the headless-spawned script into a term window (mkdir marker proves it's executing); network-free by design
  ['test_sdl_render_e2e.js', { timeoutMs: 600000 }], // Minesweeper lane: the SDL_Render* choke — in-OS cc builds a scene app (clear + NONE/BLEND/ADD/MOD fill quads + NEAREST/LINEAR scaled textures + blended textures), wmctl shot pixel-asserts every arm; headless this pins the SOFTWARE renderer tier (the GPU tier shares the batch geometry and SDL_BLEND_DESC semantics)
  ['test_cc_win32_e2e.js', { timeoutMs: 900000 }], // Lane B2 (source-lib §4): win32 apps compile IN-OS — `cc hellowin.c` pulls the whole veneer+freetype through windows.h's require block, physical-TU-path resolution crosses the srclib symlink farms ("../fontcore.h", freetype "../src/..."), the built app's window+BUTTON drive via wmctl tree/click; the documented -DUNICODE …wwinmain.c path; minimal image fails clean then works after `gucman install win32`; shares the cached minimal blob + mkpkg pool with the gucman e2es
  ['test_gucman_e2e.js', { timeoutMs: 900000 }], // gucman Slice 1: install/remove/list on the MINIMAL image (punes as a package) — sha256 refusal before extraction, staged atomic install, launch from /usr/local/bin, reboot persistence, exact DB-replay removal; bakes its own no-packages blob + runs mkpkg (both cached), so a cold run is bake-heavy like test_os_boot
  ['test_clang_pkgs_e2e.js', { timeoutMs: 900000 }], // T1 C++ ladder: the *-clang gucman channel end-to-end — box2d-clang/imgui-clang cards on the --clang superset repo, install/launch (Box2D window + banner; ImGui window + Process Inspector reading the REAL /proc), clean remove; SKIPs without the clang-simplified sibling's published overlay (base estate never hard-requires it); shares the cached minimal blob with the gucman e2es but rebuilds dist/packages as the --clang superset (accepted thrash, Part II §7)
  ['test_cpython_clang_e2e.js', { timeoutMs: 1200000 }], // todos/0340 + 0331: CPython 3.13.5 as a gucman package, in-OS — install/remove, the Clang banner, ZERO-env landmark stdlib discovery over RemoteFS (and through a symlinked argv0, which host.js's readlink cannot prove), script argv + exit-status propagation, `subprocess.run(["ls"])` really crossing the posix_spawn broker (no fork, PATH via posix_spawnp, close_fds via the kernel's CLOSEFROM fd action), the in-OS import-sweep NUMBER with every failure required to be a named CPYTHON.md §3.3 casualty, zlib/gzip/sqlite3-on-BlockFS/C-_decimal/ELOOP, and the pyc cache landing in /var while /opt stays pristine; SKIPs without the clang-simplified sibling's published overlay
  ['test_rust_pkgs_e2e.js', { timeoutMs: 900000 }], // todos/0416: the -rust gucman channel end-to-end — the wc-rust card on the --rust superset repo (real gucos-rust overlay), in-OS base purity (zero *-rust, 127 before install), install/run (output byte-equal to the busybox wc applet), clean remove; overlay sha256 must equal the committed fixture's (producer/consumer identity); SKIPs without the sibling's published overlay (base estate never hard-requires it; RUST_REQUIRE=1 makes absence loud)
  ['test_rust_e2e.js', IMG], // todos/0413 + 0414 + 0415: Rust binaries run in gucOS and gucos-sys is the ONE "c" binding — committed fixtures (sha256-pinned) spawned from the shell in a booted OS: hello + panic→__exit(101, stderr-reported, no hang) + alloc-rust (Vec/String/Box/BTreeMap/sort/format! over the libc-malloc #[global_allocator], Rust/C allocations INTERLEAVED on the one heap), module shape per RUST.md §2; sibling-gated legs (gucos-rust at RUST_ROOT, default ~/git/gucos-rust): freshness rebuilds must be byte-equal (both artifacts), missing #[link(wasm_import_module="c")] must FAIL AT LINK naming the symbol, a no-alloca module must trap at start-up, an absent-import module must FAIL AT LOAD naming the import, and the single-declaration guard (no host import outside gucos-sys, none declared twice); absent sibling SKIPs those legs unless RUST_REQUIRE=1 (then loud fail + fix command); + 0415: wc-rust (a real -rust tool over BlockFS) byte-compared against the busybox wc applet on the same inputs in the same booted OS, with one large-input leg per read loop (regular file = the kernel's S_IFREG reassembly; piped stdin = the tool's own loop, sized past the pipe ring and KP_FS_CHUNK, both derived)
  ['test_rust_std_e2e.js', IMG], // todos/0442: std on wasip1 — the wasi_snapshot_preview1 shim (BlockFS.toWasiPreview1) beside "c": committed std-rust fixture (sha256-pinned, upstream std on stable wasm32-wasip1, gucos-sys getpid in the SAME module) runs standalone (--block-fs; full deterministic output, exit7 via proc_exit, panic=abort trap semantics, Node-fs flavor refuses loud) and in-OS from the shell; shim unit legs: the "/" preopen is a REAL fd (lowest free slot, no "c" collision), the O_DIRECTORY substrate (0400 fs half — plain O_RDONLY-on-dir stays EISDIR), poll_oneoff pure-clock really sleeps / pipe-fd immediate+timeout (no kernel) / kernel path forwards BOTH r AND w lists in ONE waitMulti (the census gap-2 write-fd-drop regression guard) + EINTR mapping, the served/absent split (five absent names LinkError naming module+symbol against a real one-import module; the ENOTSUP trio answers 58); sibling-gated: freshness rebuild byte-equal + build.sh REFUSES -Zbuild-std naming the 0418 ruling (with the plain build as positive control)
  ['test_seed_e2e.js', { timeoutMs: 900000 }], // the gucman `seed` CONTENT resource kind: mkpkg's negative legs (".." / absolute / dot-prefixed dest — `.config/openwith` by name — bad src, nested dests, reserved control.json), install plants copies + records {path,sha256} per file, collision kept-and-unrecorded, remove unlinks PRISTINE copies but keeps MODIFIED ones loudly, a failed install unwinds every seed, and the virgin-root baked pass + reconcile phase 3 off a blob folded with a throwaway definition (mkpkg/mkimage/boot --packages-dir); bakes its own seed-carrying blob + shares the cached minimal one
  ['test_gucman_sources_e2e.js', { timeoutMs: 900000 }], // todos #407: mechanical <pkg>-sources companions — gcode-sources (image derivation, the jku demo) + lua-sources (package derivation) install through gucman, the payload-root ('.') srclib namespace plants /usr/local/src/<name> and replays exactly, source bytes byte-exact vs the repo (in-OS sha256); shares the cached minimal blob + mkpkg pool with the gucman e2es
  ['test_stdinc_e2e.js', { timeoutMs: 900000 }], // ticket #439: the C stdlib is READABLE in-OS — a VIRGIN minimal boot cats every /usr/include header, full-set sha256-equal to the compiler's merged literal map (hazard 1: baked headers are documentation, drift fails here); the fat image agrees with the srclib tier folded in (hazard 2 end-to-end); libc-sources ('builtin' derivation) installs and the .c units are byte-exact; shares the cached minimal blob + mkpkg pool
  ['test_gucman_quake_e2e.js', { timeoutMs: 900000 }], // gucman fat-data leg: the ~8.6 MiB quake package (18.7 MB pak0) installs on the minimal image — in-OS sha256sum proves the pak byte-exact through fetch→inflate→untar→BlockFS, the self-locating launcher boots the game, remove reclaims the tree; shares the cached minimal blob + mkpkg pool with test_gucman_e2e
  ['test_gucman_apps_e2e.js', { timeoutMs: 1200000 }], // #417+#418: netsurf/demos/gameboy/sameboy install from the minimal image and RUN — netsurf's resource closure from /opt/netsurf/res (welcome page + a real file:// page), winbox + ctldemo (.res sidecar) from the demos bundle, both emulators loading a real minimal ROM; shares the cached minimal blob + mkpkg pool (netsurf makes the cold pool build the long pole)
  ['test_fontpkg_e2e.js', { timeoutMs: 900000 }], // Unicode Phase D (W7): font packages + the fallback chain — minimal image renders CJK as the 2-cell tofu (one box ×3, byte-identical pairs), gucman install font-unifont plants the /etc/fonts/fallback line and a FRESH term/notepad render real distinct glyphs (gdi32 tofu stderr report gone), multi-package add/remove keeps the other line, last remove unlinks the file and tofu returns; shares the cached minimal blob + mkpkg pool with the gucman e2es
  ['test_software_e2e.js', { timeoutMs: 900000 }], // #81 storefront GUI over gucman: dead-repo honest error, catalog cards from the live index (`gucman index`), one-click install/remove with REAL fs asserts (install DB + /opt binary + symlink), FS_WATCH liveness for CLI installs beside the open window; shares the cached minimal blob + mkpkg pool with the gucman e2es; + the win32 Lane 0 FAT-fixture leg: baked (PACKAGES=) cards render [built-in] with Install disabled, install-over-the-top round-trips
];

// ---- suite-membership guard (ticket #314) ----
//
// The `tests` list above is HARDCODED, and that produced three tests that
// existed on disk, were mapped to this suite by the diff planner, and executed
// NOWHERE while every gate reported full coverage (test_punes_e2e.js since
// 2026-07-18; os/gcode/test/smoke.mjs; test_win32rc.js live on the #311 lane).
// assertMemberRegistry (below, before the heavy lock) refuses to run the suite
// unless the on-disk test_*.js set EQUALS the declared set — so an
// unregistered file now fails the very first kernel run instead of silently
// never running. runSuite's `evidence` opt is the other half: after a run,
// every selected member must have a build/test-kernel/<name>.log post-dating
// the run's start (a registered-but-silently-skipped member has no fresh log,
// whatever the counters say).
const MEMBER_RE = /^test_.*\.js$/;
// Deliberate exclusions ONLY. Every entry names the live ticket that owns
// registering the file, and the entry MUST come out in the same change that
// registers it — assertMemberRegistry fails on an entry whose file is gone or
// has become a declared member, so an entry cannot outlive its reason.
// EMPTY, and that is the point: #167 registered the one entry that used to
// live here (test_punes_e2e.js, orphaned since d8701a1e), so the on-disk set
// and the declared set are now equal with nothing carved out. Keep it empty
// unless a file genuinely cannot be a member — an entry here is a coverage
// hole with a name, not a way to quiet the guard.
const EXCLUDED = [];

const defaults = {
  // Boot-heavy files are compile-dominated; a few concurrent full-OS boots keep
  // this box responsive without starving the in-OS `sleep N` waits (the
  // timing-flake class). The CPU-based number is then RAM-capped: each job is
  // ~4 GB resident (a boot + its nested os/boot.js node), so cpu count alone
  // over-commits memory — 4 jobs ≈ 16.7 GB crashed a 16 GB box on 2026-07-25.
  // Bump with -j if the machine is idle (still RAM-clamped; CC_NO_MEM_CAP=1 to
  // override entirely).
  jobs: memoryCappedJobs(Math.max(1, Math.min(4, os.cpus().length - 2)), 4),
  timeoutMs: 600000,
};
const opts = parseSuiteArgs(process.argv.slice(2), defaults);
if (opts.help) { process.stdout.write(usage('tests/kernel/run.js', defaults)); process.exit(0); }

// #314: set equality between disk and the declared list — BEFORE the heavy
// lock (a launch we are about to refuse must not take the machine-wide lock;
// the tree-guard precedent), and unconditionally (--list and --filter runs
// must be just as loud about an orphaned member). Exit 2 on divergence.
assertMemberRegistry({
  dir: __dirname, pattern: MEMBER_RE, entries: tests.map(([file]) => ({ file })),
  exclude: EXCLUDED, label: 'tests/kernel/run.js',
});

// Crash safety: clamp EVEN an explicit -j to what RAM allows — an over-eager
// -j8 on a 16 GB box is exactly the OOM that killed the GUI (2026-07-25).
const safeJobs = memoryCappedJobs(opts.jobs, 4);
if (safeJobs < opts.jobs) {
  process.stderr.write(`[mem-cap] -j${opts.jobs} exceeds this host's safe RAM budget; clamping to -j${safeJobs} (CC_NO_MEM_CAP=1 to override)\n`);
  opts.jobs = safeJobs;
}

// Heavy-suite mutual exclusion: refuse to start if another heavy runner (a
// second kernel run, or a browser sweep) already owns the host — their overlap
// is what exhausted RAM and crashed the machine. Skipped for --list (no boots).
if (!opts.list) acquireHeavyLock({ name: 'kernel suite' });

// Leak pre-flight — AFTER the lock, deliberately (see the same call in
// tests/browser/os-sweep.mjs). THIS suite is the one that mints the $TMPDIR
// os-* fixture dirs, ~150 MB apiece, so it is also the one that most needs the
// abandoned ones swept before it adds 60 more. Reaping is by dead-owner-pid, so
// a hand-run single e2e (which takes no lock) is never touched.
if (!opts.list) preflight({ name: 'kernel suite' });

const entries = tests.map(([file, ...rest]) => Object.assign({ file }, ...rest.filter(x => typeof x === 'object')));

// 0082 pre-step: only when the (filtered) run actually contains fixture
// consumers — a --filter=test_tlsf-style quick run never pays a bake here.
if (!opts.list && entries.some(e => e.image && matchesFilter(e.file, opts.filter))) {
  ensurePrebakedImage();
}

runSuite(entries, {
  name: 'kernel suite',
  dir: __dirname,
  artifactDir: path.resolve(__dirname, '../../build/test-kernel'),
  jobs: opts.jobs, timeoutMs: opts.timeoutMs, filter: opts.filter,
  failFast: opts.failFast, resume: opts.resume, list: opts.list,
  repeat: opts.repeat, underLoad: opts.underLoad,
  evidence: { pattern: MEMBER_RE, exclude: EXCLUDED },
}).then(r => process.exit(r.failed ? 1 : 0))
  .catch(e => { process.stderr.write(`Fatal: ${e.stack || e.message}\n`); process.exit(2); });
