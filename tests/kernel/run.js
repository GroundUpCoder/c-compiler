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
const { runSuite, parseSuiteArgs, usage, matchesFilter } = require('../lib/suite-runner.js');
const { ensurePrebakedImage } = require('../lib/image-fixture.js');

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
  ['test_cfgstore_e2e.js'], // 0254: cfgstore.h never silently truncates — >8K user file survives cfg_set (the R3 data-loss regression), streaming replace/append/dedupe, cfg_load3 -1/EFBIG loud cap, errno on every failure path
  ['test_mounts.js'],       // 0026: MountFS — prefix routing, EXDEV/EBUSY, symlink escapes (no wasm)
  ['test_module_cache.js'], // 0037: compiled-Module cache on spawn — RO-volume policy, ss/rw exclusions, real clone e2e
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
  ['test_sockets.js'],      // 0008: AF_UNIX OFD semantics over the SAB protocol (no wasm)
  ['test_sockets_e2e.js'],  // 0008: real C client/server — accept/connect/send/recv, poll
  ['test_http.js'],         // 0172: HTTP transport (0x06xx) over the SAB protocol with a fake fetch — deferred status, streaming, backpressure, EOF/error split, teardown (no wasm)
  ['test_http_e2e.js'],     // 0172: real C over the full stack — Node fetch to a local server: streamed GET, POST echo, 512K integrity, 404, mid-stream drop
  ['test_curl_e2e.js'],     // 0173: the libcurl veneer differential smoke — ONE C program built gucOS (veneer) AND native (clang -lcurl, the oracle), outputs diffed after documented normalization; callbacks, getinfo, refused=7, timeout=28
  ['test_code_e2e.js', IMG],     // 0174: /bin/code in-OS vs a scripted fake SSE server — login-shell /etc/profile+~/.profile env plumbing, streamed text, write_file-on-BlockFS + posix_spawn bash tool round-trips
  ['test_gcode_step2_e2e.js', IMG], // 0174 step 2: usage accounting to stderr + durable 0600 JSONL sessions on BlockFS + -c/--resume replay across processes (fake SSE server with usage counters), in-image --self-test
  ['test_jobctl_e2e.js'],   // Phase 4: real C stop/cont — WUNTRACED/WCONTINUED, output halts
  ['test_jobctl_tty_e2e.js', IMG], // interactive Ctrl-Z/fg/bg/kill %1 through hush + the kernel tty
  ['test_os_boot.js', { timeoutMs: 900000 }], // 0004: headless OS boot — seed, protoshell, cc, persistence; deliberately --no-fixture (the bake path IS under test), so 3+ full ~100s bakes put it right at the 600s default under -j4 load (333s solo)
  ['test_overlays.js'],     // 0118: opt-in image overlays — overlay@1 verify/plant/provenance over a tiny synthetic bake, every fatal rule, base-bake inertness (no wasm)
  ['test_vi_e2e.js', IMG],       // 0011: busybox vi through the real tty — raw mode, edit sessions
  ['test_repl_pty_e2e.js'], // 0036: lua/micropython/sqlite3 interactive on a kernel pty — prompt, eval, LD erase, ^D exit
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
  ['test_vdso.js'],          // 0179: the seqlock vDSO block — spawn publish, zero-RPC getpgid/getsid/getppid/uptime/screen, SETPGID/SETSID/reparent/wmSetScreen republish, wedge -> RPC fallback, payload-cap arithmetic (no wasm)
  ['test_vdso_e2e.js'],      // 0179: real C reads pid/ppid/pgrp/sid off the page — RPC-op counter shows ZERO GETPGID/GETSID across setsid + orphan-reparent mutations; the libc setsid() acceptance
  ['test_rofs.js'],          // 0180: process-side read-only /usr — RemoteFS fast-path mechanics vs a fake RPC recorder: zero-RPC reads (incl. in-volume symlinks), final local errors, brokered fallbacks (relative / '..' / write-intent / escapes), RO_FD_BASE dup family, dup2/spawn-action twin promotion (no wasm)
  ['test_rofs_e2e.js'],      // 0180: real C under Kernel opts.roImage — RPC-op counter shows ZERO fs RPCs for /usr reads; EROFS after the walk, /usr/local -> /var/local escape write, DUP2-action promotion feeds a child's stdin
  ['test_wm_policy.js'],    // 0014: the WM protocol over the kernel-owned /run/wm.sock (no wasm)
  ['test_wm_service_e2e.js', IMG], // 0014: real /bin/wm + wmctl through os/boot.js — autostart, taskbar, crash+respawn
  ['test_snap_e2e.js', IMG],     // 0095: Aero Snap — drag-to-edge tiling via wmctl sdown/smove/sup, translucent preview pixels, drag-off restore, quarters, wmctl snap (= Win+arrow), fixed-size letterbox, no-WM refusal
  ['test_saver_e2e.js', IMG],    // 0096: the screensaver — kernel idle clock (wmctl idle), idle raise + input dismissal + clock reset, marquee animation shots, saver none, wmctl saver (= ctlpanel Preview), the Screen Saver applet store writes, no-WM refusal
  ['test_cursor_e2e.js', IMG],   // 0105: pointer cursor shapes — per-surface SDL_SetCursor readback (wmctl cursor = CURSOR_AT/R_CURSOR), chrome resize cursors on resizable frames (EW/NS/NWSE), title/desktop/fixed-frame arrow
  ['test_os_apps_e2e.js', IMG],  // 0015: seeded vendor apps windowed in-OS — bin-entry game data, real frames via wmctl shot
  ['test_sameboy_e2e.js', IMG],  // 0075: /bin/sameboy (cycle-accurate GB/GBC core) — exact DMG grey shades, animation, CGB colorful frame, sameboy is the baked .gb/.gbc default
  ['test_mgba_e2e.js', IMG],     // 0112: /bin/mgba (mGBA 0.10.5 GBA core — ARM7TDMI, HLE BIOS) — built-in MODE3 test ROM renders a red frame at 480x320, .gba defaults to mgba, .gb/.gbc stay sameboy
  ['test_cairo_e2e.js', IMG],    // 0061: cairo image backend -> shm — in-OS selftest (gradients/AA/cairo-ft anchors), windowed scene via wmctl shot, theme repaint, vector re-render on resize
  ['test_gdi32_e2e.js', IMG],    // 0057: win32 gdi32 — in-OS selftest (GDI semantics + leak check), windowed scene probed via wmctl shot, bit-exact repaints
  ['test_user32_e2e.js', IMG],   // 0058: win32 user32 — blocking GetMessage loop, lifecycle order, controls, MessageBox modal, wmctl tree/click-by-label agent path
  ['test_kernel32_e2e.js', IMG], // 0059: win32 kernel32/advapi32/wide-CRT — in-OS selftest, POSIX-twin identity, registry persistence across boots
  ['test_win32_ports.js'],  // 0060: port corpus compile-check — controls still link clean, PORTS.md (the 0059+ backlog) current
  ['test_winmine_e2e.js', IMG],  // 0068: winmine playable — sidecar resources, menu bar/popups, SURFACE_RESIZE, dialogs from templates, WM_TIMER, registry persistence
  ['test_calc_e2e.js', IMG],     // 0048: calc usable — WRES v2 template menus, owner-draw keypad, clipboard file + menu re-gray, keyboard translation, TrackPopupMenu agent path
  ['test_notepad_e2e.js', IMG],  // 0048: notepad usable — EDIT-around-a-file (EM_*HANDLE), comdlg32 file dialogs + find/replace protocol, status bar, MB_YESNOCANCEL, ShellExecuteW
  ['test_notepad_menu_e2e.js', IMG], // 0222: EVERY notepad menu item — effect or loud refusal (grayed items refuse agent clicks; Font/Print/PageSetup report unsupported), WM_SETTEXT caret-to-start, the win32rc \r fix pinned
  ['test_comdlg_diag_e2e.js', IMG], // 0255 R4: short listings say so — list_dir TRUE count past the fill cap, deleted-cwd "(cannot open directory)", 520-entry "(8 more...)" marker (dialog + fileman, TRUE status count), and a REAL OOM "(cannot allocate...)" row via the heap-ballast fixture under --wasm-max-mem-pages
  ['test_wm_fatal_e2e.js'],  // 0255 R5: wm fatal diagnostics name the failing layer — EV_SCREEN recreate + initial make_desk/make_bar report SDL_GetError() via fatal_sdl (pre-fix: stale strerror(errno) "Success"-class lies), forced through the kernel's real >8192 SURFACE_CREATE refusal
  ['test_fileman_e2e.js', IMG],  // 0048: file manager — dirs-first LISTBOX listing, Go/Up/Open navigation, 0066 activate() launch semantics, resize reflow
  ['test_openwith_e2e.js', IMG], // 0072: openwith associations — open(1) --set + resolver order + carry-forward, fileman Open/With picker persistence, desktop .gb dblclick → sameboy (registered by 0108)
  ['test_fileman_ops_e2e.js', IMG], // 0092: file ops — context menu, F2/Del accelerators, rename dialog, clipboard file-list cut/copy/paste (incl. the wm.c desktop menus, cross-app), delete confirm + EROFS, properties
  ['test_fileman_nav_e2e.js', IMG], // 0106: navigator v2 — details columns + status strip, LBS_EXTENDEDSEL multi-select (Ctrl-click/Shift-range/multi-delete), Enter/Backspace, F5 refresh, View sort/show-hidden, Alt+Left back
  ['test_paint_e2e.js', IMG],    // 0107: Paint accessory — memory-DC canvas, tool menu + palette (filled rect, flood fill), single-level undo, 24-bit BMP save/open round-trip via comdlg32
  ['test_recycle_e2e.js', IMG],  // 0093: the Recycle Bin — trash/restore/empty through fileman + the wm.c desktop (bin icon glyph, icon DELETE, bin menu), sidecars, Shift+Del bypass, EROFS no-stray
  ['test_ctlpanel_e2e.js', IMG], // 0048: control panel — AUDIO_GAIN control plane end to end (__audio_gain import, kernel state across processes), os-release//proc info panel
  ['test_term_e2e.js', IMG],     // 0020: /bin/term — hush on a pty in a window, vi inside, resize reflow, shot pixels
  ['test_present_e2e.js', IMG],  // 0119: /bin/sent + /bin/mgp — demo decks render (glyphs, %default bg, %tab icons), paging, q quits
  ['test_mgp_livereload_e2e.js', IMG], // #75/0264: mgp live-reload — the deck watch is wantreload()'s ONE source (ctime poll gone): external tmp+rename-over and truncate-rewrite saves re-render, background-color-proven
  ['test_fileman_watch_e2e.js', IMG],  // #75/0264 (closes 0123): fileman auto-refresh — external create/rename-over/delete re-list unprompted via RegisterFdWake→WM_FSCHANGE, selection carried by name, navigation re-arms
  ['test_clipboard_e2e.js', IMG], // 0090: the system clipboard — kernel slot via /bin/clip, notepad copy/cut/paste across processes, term drag-select + Ctrl+Shift+C/V
  ['test_hostclip_e2e.js'], // ticket #79: host-clipboard bridge kernel seam — onClipboard fires at CLIP_SET commit (real C copy), embedder clipSet feeds SDL_GetClipboardText without firing the hook (loop guard), clear reports null
  ['test_keymap_e2e.js', IMG],   // 0149/0150: the keyboard scheme (os/keys.h) — windows/macos verb tables in EDIT, the FCONTROL accel swap (fileman), term ⌘V/⌘C vs Ctrl+Shift, readline rows + off-switch, 1Hz live revalidate, ctlpanel Keyboard applet delta-writes
  ['test_ctxmenu_e2e.js', IMG],  // 0091: right-click context menus — wm.c desktop/icon/taskbar popups (geometry, dismissal, flyouts, keyboard nav), EDIT WM_CONTEXTMENU via the agent, ctlpanel argv
  ['test_desk_icons_e2e.js', IMG], // ticket #82: per-filetype desktop icon glyphs — desk_kind dispatch (exec/text/image/deck/generic/dir/bin), center-pixel contract: navy = program/folder/full-bin, white = data files/empty bin
  ['test_gpubox_dawn_e2e.js', IMG], // 0016 tier 1: gpubox (webgpu.h) under Dawn — readback->shm shots, tolerance-diff; SKIPs without the webgpu pkg
  ['test_gpubox_menu_e2e.js', IMG], // 0258 M2 acceptance: gpubox's win32 menu WITHOUT Dawn — A14 no-GPU survival, bar/popup children over the black client, Spin/Wireframe via the agent; forces tier 0 via lib/nodawn-require.js
  ['test_gpu_multiwin_dawn_e2e.js'], // menu item 0 / A4: TWO GPU windows, per-window present binding — each shows ITS color, no newest-wins clobber; SKIPs without the webgpu pkg
  ['test_gucman_e2e.js', { timeoutMs: 900000 }], // gucman Slice 1: install/remove/list on the MINIMAL image (punes as a package) — sha256 refusal before extraction, staged atomic install, launch from /usr/local/bin, reboot persistence, exact DB-replay removal; bakes its own no-packages blob + runs mkpkg (both cached), so a cold run is bake-heavy like test_os_boot
  ['test_gucman_quake_e2e.js', { timeoutMs: 900000 }], // gucman fat-data leg: the ~8.6 MiB quake package (18.7 MB pak0) installs on the minimal image — in-OS sha256sum proves the pak byte-exact through fetch→inflate→untar→BlockFS, the self-locating launcher boots the game, remove reclaims the tree; shares the cached minimal blob + mkpkg pool with test_gucman_e2e
  ['test_software_e2e.js', { timeoutMs: 900000 }], // #81 storefront GUI over gucman: dead-repo honest error, catalog cards from the live index (`gucman index`), one-click install/remove with REAL fs asserts (install DB + /opt binary + symlink), FS_WATCH liveness for CLI installs beside the open window; shares the cached minimal blob + mkpkg pool with the gucman e2es
];

const defaults = {
  // Boot-heavy files are compile-dominated; 4 concurrent full-OS boots keep
  // this 10-core box responsive without starving the in-OS `sleep N` waits
  // (the timing-flake class). Bump with -j if the machine is idle.
  jobs: Math.max(1, Math.min(4, os.cpus().length - 2)),
  timeoutMs: 600000,
};
const opts = parseSuiteArgs(process.argv.slice(2), defaults);
if (opts.help) { process.stdout.write(usage('tests/kernel/run.js', defaults)); process.exit(0); }

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
}).then(r => process.exit(r.failed ? 1 : 0))
  .catch(e => { process.stderr.write(`Fatal: ${e.stack || e.message}\n`); process.exit(2); });
