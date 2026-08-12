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
const fs = require('fs');
const path = require('path');
const os = require('os');
const { runSuite, parseSuiteArgs, usage, matchesFilter, ramBudgetGb, assertMemberRegistry } = require('../lib/suite-runner.js');
const { loadSiblingTests } = require('../lib/sibling-tests.js');
const { ensurePrebakedImage } = require('../lib/image-fixture.js');
const { joinHeavyLock } = require('../lib/heavy-lock.js');
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
// Rows tagged LIGHT are the pure-protocol tests — fake workers over the SAB
// protocol or small headless probes, no full-OS boot, no in-process corpus
// compile — so the weighted pool (#576 A2) schedules them into the RAM the
// boots leave free instead of charging each one a boot-sized reservation.
// An UNTAGGED row is assumed boot-heavy: the safe default for a new e2e.
const LIGHT = { light: true };
// Rows tagged BOOT drive ONE prebaked-fixture boot and were MEASURED at or
// under 1.08 GB peak RSS (#579; see the weight block below for the run).
// This is the class the uniform HEAVY_GB=4 used to over-charge 4x, and
// over-charging it is what pinned the whole pool at 2 concurrent files.
// Tagging a row BOOT is an assertion about a MEASUREMENT, so a new e2e is
// deliberately NOT tagged until someone has sampled it — untagged still
// means "assumed boot-heavy", which is the safe direction to be wrong in.
const BOOT = { boot: true };

const tests = [
  ['test_kernel.js', LIGHT],       // process-table semantics over the real SAB protocol
  ['test_e2e.js', BOOT],          // real C programs in worker_threads via nodeCreateWorker
  ['test_signals_e2e.js', BOOT],  // Phase 2: async delivery, EINTR/SA_RESTART, pause, exit handshake
  ['test_itimer_e2e.js', BOOT],   // 0044: alarm/setitimer(ITIMER_REAL) -> SIGALRM — EINTR on blocked read, interval reload, DFL terminate
  ['test_tty.js', LIGHT],          // Phase 3: line discipline semantics (kernel-side, no wasm)
  ['test_tty_e2e.js'],      // Phase 3: real C driven by a scripted UI bridge
  ['test_fs_e2e.js', BOOT],       // 0009: brokered fs — shared offsets, fd_actions, SIGKILL+fsck, winsize
  ['test_read_fill_e2e.js', BOOT], // 0140: a single read() of a >KP_FS_CHUNK REGULAR FILE fills the whole count (not one capped chunk) like native — the mGBA-ROM short-read class; scoped to regular files (pipes keep POSIX short-read)
  ['test_cfgstore_e2e.js'], // 0254: cfgstore.h never silently truncates — >8K user file survives cfg_set (the R3 data-loss regression), streaming replace/append/dedupe, cfg_load3 -1/EFBIG loud cap, errno on every failure path
  ['test_mounts.js'],       // 0026: MountFS — prefix routing, EXDEV/EBUSY, symlink escapes (no wasm)
  ['test_module_cache.js', BOOT], // 0037+#188: compiled-Module cache on spawn — RO immutable + rw VALIDATED keys, replace-on-rewrite, ss/no-fs exclusions, real clone e2e, in-OS recompile loop
  ['test_procfs.js'],       // 0043: synthetic /proc — Linux formats, snapshot-at-open, zombies, EROFS, GETSID (no wasm)
  ['test_readdir_page.js', LIGHT], // 0241: paginated FS_OPENDIR/FS_READDIR — 3000-entry dir lists fully in order (raw RPC + RemoteFS drain), small dirs single-page, stale cursor EBADF, handle release on exhaustion AND death mid-drain (no wasm)
  ['test_pipes.js', LIGHT],        // Phase 4: pipe OFD semantics over the SAB protocol (no wasm)
  ['test_pipes_e2e.js', BOOT],    // Phase 4: real C pipelines — blocking wake, EOF, SIGPIPE death
  ['test_pipes_spsc.js', LIGHT],   // 0181: SPSC ring mechanics over the SAB protocol — pipe-sab handshake, LATENT->FAST->DEMOTED ladder (promotion on removal, spawn-inherit demotion, strace pseudo-holder, in-process dup stays FAST), stale-mode ring service, PR_RWAIT/PR_WWAIT doorbell + PIPE_KICK, ring EOF/EPIPE flags (no wasm)
  ['test_spsc_e2e.js', BOOT],     // 0181: real C pipelines — RPC-op counter shows 8MB moving with ZERO pipe data RPCs (wakes counted separately), fast-writer SIGPIPE via kick{epipe}, mid-stream demotion byte-identical
  ['test_strace.js', LIGHT],       // 0046: per-pid RPC trace — spec.trace validation, decode, deferred/unfinished, -f inheritance, drop policy (no wasm)
  ['test_strace_e2e.js', BOOT, IMG],   // 0046: /bin/strace in-OS — cat's fd stream, exit/signal status propagation, -f, -o
  ['test_pty.js', LIGHT],          // 0020: pty pair semantics over the SAB protocol (no wasm)
  ['test_pty_e2e.js', BOOT],      // 0020: real C over a pty — openpty, spawn-on-slave, winsize, SIGHUP
  ['test_zerolen_read.js', LIGHT], // 0253: read(fd, buf, 0) returns 0 immediately (never parks) on every brokered read kind — pipe/socket/pty-master (_streamRead) + tty FS_READ, empty stream + live writer; count>0 blocking semantics unchanged (no wasm)
  ['test_sockets.js', LIGHT],      // 0008: AF_UNIX OFD semantics over the SAB protocol (no wasm)
  ['test_sockets_e2e.js', BOOT],  // 0008: real C client/server — accept/connect/send/recv, poll
  ['test_http.js', LIGHT],         // 0172: HTTP transport (0x06xx) over the SAB protocol with a fake fetch — deferred status, streaming, backpressure, EOF/error split, teardown (no wasm)
  ['test_http_e2e.js', BOOT],     // 0172: real C over the full stack — Node fetch to a local server: streamed GET, POST echo, 512K integrity, 404, mid-stream drop
  ['test_curl_e2e.js', BOOT],     // 0173: the libcurl veneer differential smoke — ONE C program built gucOS (veneer) AND native (clang -lcurl, the oracle), outputs diffed after documented normalization; callbacks, getinfo, refused=7, timeout=28
  ['test_netbridge_e2e.js', BOOT, IMG], // #349: the Tier 2.5 HTTP bridge — one C process flips /etc/net OFF->ON->OFF->ON-dead live (watchPath, ack-file sync) with the bridge /fetch counter as the positive control (exactly 1); wrapper EACCES/ENETUNREACH mapping, CORS/PNA preflight, origin allowlist, 502 encapsulation; boot.js leg proves the shipped embedder wiring
  ['test_ticketbridge_e2e.js', BOOT, IMG], // #451: the host ticket bridge — the in-OS /usr/bin/file-gucos-ticket client through tools/ticket-bridge.js to a FAKE `file-gucos-ticket` handler the test plants on a private PATH dir (so acceptance never depends on real ticket tooling): the positive leg runs in BOTH net modes with the net-bridge /fetch counter proving the bridge-ON transit carries no special-casing, plus handler-absent 501, handler-exit-3 relayed as a HANDLER (not bridge) failure, handler timeout, unreachable bridge, 413 oversize, the CORS/PNA + origin-allowlist surface, and a driveBoot leg running the SHIPPED binary out of the baked image
  ['test_code_e2e.js', BOOT, IMG],     // 0174: /bin/code in-OS vs a scripted fake SSE server — login-shell /etc/profile+~/.profile env plumbing, streamed text, write_file-on-BlockFS + posix_spawn bash tool round-trips
  ['test_gcode_step2_e2e.js', BOOT, IMG], // 0174 step 2: usage accounting to stderr + durable 0600 JSONL sessions on BlockFS + -c/--resume replay across processes (fake SSE server with usage counters), in-image --self-test
  ['test_gcode_intr_flush_e2e.js', BOOT, IMG], // #433: ^C mid-stream flushes queued tty type-ahead — paced interactive session (jobctl Session machinery) vs the stalling fake SSE server; POST count 1, nothing auto-submitted at the fresh prompt
  ['test_gcode_timeout_e2e.js', BOOT, IMG], // #503: the bash-tool cap BOUNDS wall time (kill AND stop reading — pipe-holding descendants and chatty children both; alarm checked at loop top, not EINTR-only) and the tool_result is honest ("timed out ... may still be running", never a fabricated completed kill); GCODE_BASH_SECS=3 is the testability seam
  ['test_gcode_intr_honesty_e2e.js', BOOT, IMG], // #509: the ^C survivor edge (kill -INT at gcode alone, sh SIGKILLed, its sleep child survives) reports honestly — interrupt + shell killed + may-still-be-running, never the fabricated "[command killed:" claim; instrument is the persisted session log (#412 sends no tool_results POST after a ^C)
  ['test_gcode_intr_chatty_e2e.js', BOOT, IMG], // #510: a CHATTY child must not defeat the ^C survivor-edge kill — g_interrupted was EINTR-gated (#503(b) twin), so reads that keep returning data never ran the kill branch and the ^C did nothing until the wall-time cap; checked at the drain-loop top now, tool_result carries the honest #509 message not the timeout's
  ['test_gcode_native.js', BOOT],  // #314: the NATIVE gcode oracle — runs os/gcode/test/smoke.mjs (clang + real libcurl/cJSON vs the scripted SSE server) and asserts the CHECK COUNT against the source's check( call sites, not just exit 0 (the oracle prints no total)
  ['test_jobctl_e2e.js', BOOT],   // Phase 4: real C stop/cont — WUNTRACED/WCONTINUED, output halts
  ['test_jobctl_tty_e2e.js', BOOT, IMG], // interactive Ctrl-Z/fg/bg/kill %1 through hush + the kernel tty
  ['test_os_boot.js', { timeoutMs: 900000 }], // 0004: headless OS boot — seed, hush, cc, persistence; deliberately --no-fixture (the bake path IS under test), so 3+ full ~100s bakes put it right at the 600s default under -j4 load (333s solo)
  ['test_os_boot_kill_honesty.js', BOOT], // #110 (todos-0304): harness-kill honesty — a boot/bake spawn killed at the CC_OS_BOOT_TIMEOUT_MS budget prints the TIMED OUT banner (leg 1 forces it: a 1500ms budget against the full-bake session), an externally SIGKILLed boot child prints the external-signal banner naming the signal (leg 2 delivers a real out-of-band SIGKILL), both exit 1 with NO bare "FAIL <leg>  null" shape and NO unattributed ETIMEDOUT stack; target heavy-lock refusals propagate as exit 3
  ['test_spawn_budget_kill_honesty.js', BOOT], // #513 (#110's inline-site sibling): kill honesty for the direct kernel-suite spawns via tests/lib/spawn-budget.js — a CC_SPAWN_BUDGET_MS budget kill of test_gcode_native.js prints the TIMED OUT banner (leg 1 forces a 1000ms budget), an out-of-band SIGKILL of its smoke.mjs child prints the external-signal banner (leg 2 delivers it for real), neither renders the product-shaped "oracle exits 0 (got null" line; leg 3 pins the helper's classify/passthrough contract (sync + async execFile, real kills, nonzero exits pass through)
  ['test_boot_guard_e2e.js', BOOT, IMG, { timeoutMs: 900000 }], // 0293 (#101, the 0045 follow-up): the single-instance image-pair guard — two boots pointed at ONE store deliberately (the drive.js mkdtemp isolation is exactly what hides the bug): live holder → exit 5 naming holder pid + lock path with the script never run, clean exit releases the sidecar, the freed pair boots again, a dead holder's stale lock is stolen; 900s: three real boots under a private-TMPDIR heavy-lock scope
  ['test_heavylock_e2e.js', BOOT, IMG, { timeoutMs: 900000 }], // 0342 (closes 0303): the heavy lock guards the BOOT, not a caller list — under a private-TMPDIR lock scope: free-lock boot runs (leg 1), live foreign holder → exit 3 fast naming holder + CC_NO_HEAVY_LOCK with NO image work (leg 2, the RED control), verified CC_HEAVY_LOCK_PID marker joins re-entrantly with no release duty (leg 3, the nested proof), dead-pid holder stolen (leg 4), driveBoot propagates the refusal as its own exit 3 (leg 5), the escape hatch boots past a live holder (leg 6), and a hand-run os-*.mjs exits 3 at the harness before any serve.js (leg 7); 900s: four real boots, and --repeat runs them concurrently
  ['test_overlays.js'],     // 0118: opt-in image overlays — overlay@1 verify/plant/provenance over a tiny synthetic bake, every fatal rule, base-bake inertness (no wasm)
  ['test_vi_e2e.js', BOOT, IMG],       // 0011: busybox vi through the real tty — raw mode, edit sessions
  ['test_repl_pty_e2e.js'], // 0036: lua/micropython/sqlite3 interactive on a kernel pty — prompt, eval, LD erase, ^D exit
  ['test_micropython_script_e2e.js', BOOT], // 0117 R1: the micropython CLI as an OS process — argv/sys.argv, open() on BlockFS, FS import, sys.exit status, traceback on fd 2 not fd 1, -c
  ['test_micropython_stdlib_e2e.js', BOOT], // 0117 R2: sys.path policy (script dir / site dir / symlink-chased package lib), two-file import from another cwd, -m, os+os.path over the kernel fs, the curated stdlib
  ['test_wm.js', LIGHT],           // WM.md: surface registry, input routing, chrome, screenshots (no wasm)
  ['test_wm_anchored.js', LIGHT],  // 0256 Spike 1: anchored child surfaces (A1 tree, A11 materialized dst, A5 owner child resize, clamp, cascade, thumbnail compositing) + the grab (A2) + the focus-funnel owner pair (A9) — kernel seam, no wasm
  ['test_wm_aero.js', LIGHT],      // 0063: has-alpha src-over blend goldens, wmThumbnail box filter, glass headless invariance, minimize/restore anim records (no wasm)
  ['test_wm_e2e.js', BOOT],       // WM.md: real C SDL app windowed — shm present, ring input, QUIT
  ['test_menubox_e2e.js', BOOT, IMG], // 0256 Spike 1 e2e: SDL_CreatePopupWindow through the real veneer — subtree drag-follow (2-deep chain), hide/show, composited child text + popup overflow, grab dismiss+consume, A5 strip resize, the owner focus pair, cascade close
  ['test_audio.js', LIGHT],        // 0017: the kernel mixer — exact-value mixes, resample, lifecycle (no wasm)
  ['test_audio_e2e.js', BOOT],    // 0017: real C SDL audio streams — AUDIO_OPEN handshake, mix, SIGKILL drain
  ['test_sounds_e2e.js', BOOT],   // 0094: the event-sound scheme — PlaySound aliases/flags/mute store, MessageBeep + MessageBox beep, SYNC drain-dry reclaim
  ['test_vsync.js', LIGHT],        // 0100: vsync broadcast — spawn-time advertise flag, vsyncTick bump/notify per live pcb, vsyncWait park + rAF catch-up semantics (no wasm)
  ['test_vsync_boot_e2e.js', BOOT, IMG, { timeoutMs: 600000 }], // #424: boot.js --vsync[=hz] — timer-driven vsyncTick under the headless host: bad-hz loud refusal (exit 2 before image work), a real C frame-loop app paced at 20Hz (30 frames >= 1.1s wall vs the fallback pacer's ~0.5s — the load-bearing bound), bare --vsync defaults 60Hz
  ['test_waitevent_e2e.js', BOOT], // 0161: SDL_WaitEvent(Timeout) parks on the input ring via __sdl_pump_wait — no-ring nanosleep fallback, full-timeout park, chunk-crossing wake on injected input, signal-while-parked, NULL peek
  ['test_sdl_delay_e2e.js', BOOT], // 0224: SDL_Delay cooperative in worker flavors — the classic while(running){poll;draw;Delay} corpus loop runs unmodified as an OS process: pre-ring blocking fallback, full-duration sleeps with mid-delay input queued, frame-idle release mid-delay (compositor may park), standalone-browser throw preserved; + #485: a POLL-ONLY loop (no Delay/WaitEvent) gets input + close via SDL_PollEvent's own ring pump
  ['test_sockwake_e2e.js', BOOT],  // 0168: kernel-socket→input-ring wake — a WMP subscriber parked in __sdl_pump_wait wakes promptly on kernel-peer socket data (EV_SCREEN), not on the park timeout; + the 0169-gate lost-notify interleave (kick lands BEFORE the park entry)
  ['test_comp_park_e2e.js', BOOT], // 0169: on-demand compositor wake protocol e2e — real C presents vs a test-played compositor: doorbell-on-present only while PARKED, WaitEvent entry drops the wantFrame pin, SIGKILL mid-pin clears it
  ['test_wait_e2e.js', BOOT],      // 0178: unified wait (FS_WAIT via __wait) — fd wake, entry-scan atomicity, pure timeout, ring wake out of an infinite park, prompt signal-EINTR with the handler run, post-EINTR re-park
  ['test_fswatch_e2e.js', BOOT],   // #75/0264: FS_WATCH — path-keyed watch fds fed from the _fsRpc choke: cross-process settle-on-close, FS_WAIT park wake, the rename-over settle (the inotify-trap case), EAGAIN contract, SELF_GONE + re-arm, dir names, one-record rename, O_TRUNC settle, overflow clear+latch with the writer unblocked, MODIFY opt-in, EINVAL/ENOENT
  ['test_realpath_e2e.js', BOOT],  // #76/0263: realpath(3)/readlink -f resolve symlinks PHYSICALLY — real busybox over the baked /bin->/usr/bin + ls->coreutils + /usr/local->/var/local chains, relative '../' targets, ELOOP failure, ENOENT-on-missing (fs.realpathSync oracle parity); the kernel FS_REALPATH RPC now walks lstat/readlink instead of the lexical _resolvePath
  ['test_symlink_create_e2e.js', BOOT], // 0375: open(O_CREAT) through a dangling symlink creates the TARGET, never a duplicate dirent — hush redirects + ln/rm/mkdir over the brokered FS RPCs: single-link create, rm removes the link only, chain create at the end, mkdir-over-dangling EEXIST
  ['test_vdso.js', LIGHT],          // 0179: the seqlock vDSO block — spawn publish, zero-RPC getpgid/getsid/getppid/uptime/screen, SETPGID/SETSID/reparent/wmSetScreen republish, wedge -> RPC fallback, payload-cap arithmetic (no wasm)
  ['test_vdso_e2e.js', BOOT],      // 0179: real C reads pid/ppid/pgrp/sid off the page — RPC-op counter shows ZERO GETPGID/GETSID across setsid + orphan-reparent mutations; the libc setsid() acceptance
  ['test_rofs.js', LIGHT],          // 0180: process-side read-only /usr — RemoteFS fast-path mechanics vs a fake RPC recorder: zero-RPC reads (incl. in-volume symlinks), final local errors, brokered fallbacks (relative / '..' / write-intent / escapes), RO_FD_BASE dup family, dup2/spawn-action twin promotion (no wasm)
  ['test_rofs_e2e.js', BOOT],      // 0180: real C under Kernel opts.roImage — RPC-op counter shows ZERO fs RPCs for /usr reads; EROFS after the walk, /usr/local -> /var/local escape write, DUP2-action promotion feeds a child's stdin
  ['test_wm_policy.js', LIGHT],    // 0014: the WM protocol over the kernel-owned /run/wm.sock (no wasm)
  ['test_keybind.js', LIGHT],      // KEYBINDING-OVERRIDE-SYSTEM §3 (CHUNK 1): the kernel key-grab table — GRAB_SET install/replace/cap/n=0, EV_HOTKEY + both-edge swallow, exact-modifier match, the Shift amendment (named vs masked) + repeat flag, non-subscriber refusal, subscriber-gone reset, the default table reproducing legacy EV_CYCLE/MENU/SNAP_KEY/SYSMENU, and the km-fold twin vs os/keys.h (no wasm)
  ['test_keybind_registry.js', LIGHT], // KEYBINDING-OVERRIDE-SYSTEM §2/§5 (CHUNK 2): the keys.h named-action registry + bind.<action> override resolution + chord parse/format, exercised by a native-C probe (clang, no boot) — registry defaults per scheme (macos line/doc-nav + Ctrl+Alt+arrow tiling + F3 overview), rebind moves/none unbinds/default restores/malformed loud-fallback, readline-row immunity, scheme-independence, parse/format round-trip, and the ks_chord_scancode twin vs kernel.js WM_DEFAULT_GRABS
  ['test_wm_service_e2e.js', BOOT, IMG], // 0014: real /bin/wm + wmctl through os/boot.js — autostart, taskbar, crash+respawn
  ['test_snap_e2e.js', BOOT, IMG],     // 0095: Aero Snap — drag-to-edge tiling via wmctl sdown/smove/sup, translucent preview pixels, drag-off restore, quarters, wmctl snap (= Win+arrow), fixed-size letterbox, no-WM refusal
  ['test_skey_e2e.js', BOOT, IMG],     // #423: WMP screen-path keyboard (INJECT_WMKEY, the 0095 keyboard analogue) — wmctl skey/skeydown/skeyup through the kernel's REAL wmKey grab table: Ctrl+Esc Start-menu toggle, single-edge chord swallow, Alt+Tab LRU cycle, with the INJECT_KEY bypass pinned as the control
  ['test_overview_e2e.js', BOOT, IMG], // EXPOSE: window overview / Exposé — wmctl overview enters (live miniatures in wmctl shot), PICK focuses+raises+exits, background dismiss, relayout on create/destroy, N=0 no-op, no-WM refusal
  ['test_ksvc_e2e.js', BOOT, IMG],     // 0275: the ksvc kernel-C text service — headless composite label text (titles, close 'x', Exposé captions) bit-compared against os/ksvc.js rendering over the SAME image (the same-bytes assertion), ellipsis on overlong titles, CJK tofu parity
  ['test_saver_e2e.js', BOOT, IMG],    // 0096: the screensaver — kernel idle clock (wmctl idle), idle raise + input dismissal + clock reset, marquee animation shots, saver none, wmctl saver (= ctlpanel Preview), the Screen Saver applet store writes, no-WM refusal
  ['test_cursor_e2e.js', BOOT, IMG],   // 0105: pointer cursor shapes — per-surface SDL_SetCursor readback (wmctl cursor = CURSOR_AT/R_CURSOR), chrome resize cursors on resizable frames (EW/NS/NWSE), title/desktop/fixed-frame arrow
  ['test_os_apps_e2e.js', BOOT, IMG],  // 0015: seeded vendor apps windowed in-OS — bin-entry game data, real frames via wmctl shot
  ['test_sameboy_e2e.js', BOOT, IMG],  // 0075: /bin/sameboy (cycle-accurate GB/GBC core) — exact DMG grey shades, animation, CGB colorful frame, sameboy is the baked .gb/.gbc default
  ['test_mgba_e2e.js', BOOT, IMG],     // 0112: /bin/mgba (mGBA 0.10.5 GBA core — ARM7TDMI, HLE BIOS) — built-in MODE3 test ROM renders a red frame at 480x320, .gba defaults to mgba, .gb/.gbc stay sameboy
  ['test_punes_e2e.js', IMG, { timeoutMs: 900000 }], // 0088 + 0213 (registered by #167): /bin/punes (puNES NES/Famicom core — 6502/2C02/2A03) — built-in NROM test ROM composites a solid palette-$21 blue frame at 512x480, .nes defaults to punes, and the D-pad regression guard (held Up must tint the backdrop green — the SOCD filter used to erase it). Shape sibling is test_mgba_e2e.js, but this file drives THREE boots whose own driveBoot deadlines already sum to 660s, past the 600s suite default — hence 900s, sized like test_heavylock_e2e.js's four-boot row
  ['test_cairo_e2e.js', BOOT, IMG],    // 0061: cairo image backend -> shm — in-OS selftest (gradients/AA/cairo-ft anchors), windowed scene via wmctl shot, theme repaint, vector re-render on resize
  ['test_gdi32_e2e.js', BOOT, IMG],    // 0057: win32 gdi32 — in-OS selftest (GDI semantics + leak check), windowed scene probed via wmctl shot, bit-exact repaints
  ['test_multiface_font_e2e.js', BOOT, IMG], // C1/#281: multi-face CreateFont — NULL-face default byte-identical to mono (no flag day), proportional sans/serif metrics, real bold/italic files preferred (sans italic advances shift) vs synthetic shear (mono/serif italic advances preserved), drawn underline/strikeout rules, the Win32 name mapper, /etc per-face override, per-face ramp shots
  ['test_user32_e2e.js', BOOT, IMG],   // 0058: win32 user32 — blocking GetMessage loop, lifecycle order, controls, MessageBox modal, wmctl tree/click-by-label agent path
  ['test_lb_vscroll_e2e.js', BOOT, IMG], // 0275 (#275): LISTBOX built-in WS_VSCROLL bar — show-when-needed pixels, arrows/channel/thumb-drag through the real input path, wheel/keys share the lb_vscroll clamp (thumb sync)
  ['test_listview_e2e.js', BOOT, IMG], // 0370: SysListView32 + SysHeader32 + the AQM agent seam — lvtest message surface, rows/columns addressable by NAME (wmctl click/gettext/wait text, lvrow/hdcol tree lines), sort via header click, LISTBOX rows retrofitted as click targets
  ['test_kernel32_e2e.js', BOOT, IMG], // 0059: win32 kernel32/advapi32/wide-CRT — in-OS selftest, POSIX-twin identity, registry persistence across boots
  ['test_win32_ports.js'],  // 0060: port corpus compile-check — controls still link clean, PORTS.md (the 0059+ backlog) current
  ['test_win32rc.js', LIGHT],      // #311: rc NOT semantics — bare/combined/#define-carried NOT clears bits from the assembled style, keyword defaults included
  ['test_winmine_e2e.js', BOOT, IMG],  // 0068: winmine playable — sidecar resources, menu bar/popups, SURFACE_RESIZE, dialogs from templates, WM_TIMER, registry persistence
  ['test_calc_e2e.js', BOOT, IMG],     // 0048: calc usable — WRES v2 template menus, owner-draw keypad, clipboard file + menu re-gray, keyboard translation, TrackPopupMenu agent path
  ['test_notepad_e2e.js', BOOT, IMG],  // 0048: notepad usable — EDIT-around-a-file (EM_*HANDLE), comdlg32 file dialogs + find/replace protocol, status bar, MB_YESNOCANCEL, ShellExecuteW
  ['test_notepad_menu_e2e.js', BOOT, IMG], // 0222: EVERY notepad menu item — effect or loud refusal (grayed items refuse agent clicks; Font/Print/PageSetup report unsupported), WM_SETTEXT caret-to-start, the win32rc \r fix pinned
  ['test_edit_punct_repro.js', BOOT, IMG], // #430: punctuation keysym→VK collisions (' = VK_RIGHT, . = VK_DELETE) — 13-key EOL insert matrix + type-over-selection replaces; RED until #430's vk_of OEM remap lands
  ['test_comdlg_diag_e2e.js', BOOT, IMG], // 0255 R4: short listings say so — list_dir TRUE count past the fill cap, deleted-cwd "(cannot open directory)", 520-entry "(8 more...)" marker (dialog + fileman, TRUE status count), and a REAL OOM "(cannot allocate...)" row via the heap-ballast fixture under --wasm-max-mem-pages
  ['test_wm_fatal_e2e.js', BOOT],  // 0255 R5: wm fatal diagnostics name the failing layer — EV_SCREEN recreate + initial make_desk/make_bar report SDL_GetError() via fatal_sdl (pre-fix: stale strerror(errno) "Success"-class lies), forced through the kernel's real >8192 SURFACE_CREATE refusal
  ['test_fileman_e2e.js', BOOT, IMG],  // 0048: file manager — dirs-first LISTBOX listing, Go/Up/Open navigation, 0066 activate() launch semantics, resize reflow
  ['test_cmdalt_e2e.js', { timeoutMs: 900000 }], // 0338: the command-alternatives dispatcher — /usr/bin/cmdalt multicall (basename(argv[0]) = the key), verbatim argv forwarding, exit/signal status, 127-never-silent-fallback, #! links, self-dispatch refusal, layer precedence + reset, a SECOND dispatched name with no C change, and the three PATH-shadow diagnostics (which/list/set); session B installs micropython from a real mkpkg repo to prove the `commands` claim round-trip and `python` end to end; shares the cached minimal blob + mkpkg pool with the gucman e2es
  ['test_openwith_e2e.js', BOOT, IMG], // 0072: openwith associations — open(1) --set + resolver order + carry-forward, fileman Open/With picker persistence, desktop .gb dblclick → sameboy (registered by 0108)
  ['test_fileman_ops_e2e.js', BOOT, IMG], // 0092: file ops — context menu, F2/Del accelerators, rename dialog, clipboard file-list cut/copy/paste (incl. the wm.c desktop menus, cross-app), delete confirm + EROFS, properties
  ['test_fileman_nav_e2e.js', BOOT, IMG], // 0106: navigator v2 — details columns + status strip, LBS_EXTENDEDSEL multi-select (Ctrl-click/Shift-range/multi-delete), Enter/Backspace, F5 refresh, View sort/show-hidden, Alt+Left back
  ['test_paint_e2e.js', BOOT, IMG],    // 0107: Paint accessory — memory-DC canvas, tool menu + palette (filled rect, flood fill), single-level undo, 24-bit BMP save/open round-trip via comdlg32
  ['test_recycle_e2e.js', BOOT, IMG],  // 0093: the Recycle Bin — trash/restore/empty through fileman + the wm.c desktop (bin icon glyph, icon DELETE, bin menu), sidecars, Shift+Del bypass, EROFS no-stray
  ['test_ctlpanel_e2e.js', BOOT, IMG], // 0048: control panel — AUDIO_GAIN control plane end to end (__audio_gain import, kernel state across processes), os-release//proc info panel
  ['test_term_e2e.js', BOOT, IMG],     // 0020: /bin/term — hush on a pty in a window, vi inside, resize reflow, shot pixels
  ['test_netsurf_e2e.js', BOOT, IMG],  // NetSurf Lane 2: the gucOS frontend renders real documents in-window — ~600-TU build, freetype AA text pixels, title-follows-<title>, resize reflow (float re-wrap), wheel/PageDown/Home scroll, click-a-link navigation, wmctl close exit
  ['test_netsurf_layout_e2e.js', BOOT, IMG],  // NetSurf Lane 4: layout fidelity as exact box geometry — table cell grid, margin/border/padding arithmetic, inline-block wrap, form-control rendering, serif/mono-bold faces really load
  ['test_netsurf_content_e2e.js', BOOT, IMG], // NetSurf Lane 4: in-app image decode (GIF/BMP/ICO/PNG + data:-URI + scaled), data:text/html from the CLI, the fetch-error page, the baked welcome page + about:logo, the Desktop icon seed
  ['test_netsurf_js_e2e.js', BOOT, IMG],      // NetSurf JS Lane A: enable_javascript is ON BY DEFAULT in the gucOS frontend, setInterval+putImageData repaints with zero input, a real SDL click reaches a DOM listener, and ${HOME}/.netsurf/Choices enable_javascript:0 is still the off-switch
  ['test_netsurf_console_e2e.js', BOOT, IMG], // todos/0421: a page's console output reaches the shell's tty — every console level under its own name, a multi-line entry prefixed on both lines, the trailing-newline and empty-entry branches, and `2>FILE` proven to be the off-switch
  ['test_netsurf_mutation_e2e.js', BOOT, IMG], // NetSurf JS Lane B: the mutation->re-box->reflow->repaint bridge in the real frontend — demos/stopwatch.html's setInterval textContent write reaches PIXELS with zero input, a real SDL click createElement/appendChild's then removeChild's a visible block, and the SCROLL OFFSET (decoded from a colour-coded ruler page) survives a re-conversion
  ['test_netsurf_events_e2e.js', BOOT, IMG],  // NetSurf JS Lane C (todos/0289): UI event coverage through the REAL SDL input map — a wmctl drag paints the `paint` demo's canvas where the pointer went (and nowhere else, so the coordinates are asserted not assumed), a real key press AND its release both reach the FOCUSED field (keyup needed a new core path), a real click runs a CAPTURE-phase listener, and clicking away from an edited field commits `change`
  ['test_netsurf_img_reconvert_e2e.js', BOOT, IMG], // todos/0410: an <img> keeps rendering after a mutation-triggered live re-conversion — deck-shaped page (abs-pos base layer, opaque cover toggled by click), WIDTH-ONLY img (the REPLACE_DIM-less shape whose box needs the object's intrinsic size), ink asserted after the 1st and 3rd re-conversions; pins the DONE-status completion-reformat branch in object.c
  ['test_netsurf_pointer_e2e.js', BOOT, IMG], // todos/0419 (P0) + todos/0420: the pointer path of html_mouse_action — a click listener that calls preventDefault() really stops the link AND its own restyle survives to paint (the dispatch result used to be discarded), a link whose listener does NOT cancel still navigates (the control that keeps the fix honest), and the dynamic pseudo-classes work: `a:hover` paints on entry and CLEARS on exit, `#outer:hover` paints with the pointer on a span inside it (:hover is a chain), and `:active` paints only between a button-down and its release
  ['test_netsurf_dragslop_e2e.js', BOOT, IMG], // todos/0427 (P0): a held button reports HOLDING_* from the press on, not from the DRAG_SLOP promotion on — press + sub-slop move (3 px) arrives as a mousemove with buttons=1 and NOT as a mouseup (the unfixed frontend synthesised a mouseup inside the 5 px slop window, killing every drag on every page), the one mouseup lands at the release after the moves, a motionless click still ups exactly once (the CLICK_1 path), and a press released inside the slop ups exactly once (not twice).  In-OS by necessity: smoke-js drives the monkey frontend, which never executes gucos/gui.c
  ['test_netsurf_select_e2e.js', BOOT, IMG], // todos/0422: the CORE select menu is ON by default in gucOS — a <select> click opens the in-content menu (selected-row band + occlusion oracle), choosing fires `change` and repaints the widget text, six scrollbar-arrow clicks scroll exactly 96px and re-map the row→option pick, an outside click dismisses without an event, a <select multiple> toggles per click and STAYS open, and the option widens the closed widget by exactly SCROLLBAR_WIDTH (the layout half, measured against a --core_select_menu=0 control window whose click still paints nothing)
  ['test_netsurf_filegadget_e2e.js', BOOT, IMG], // todos/0433: <input type=file> opens the OUT-OF-PROCESS /bin/filepick (comdlg32 GetOpenFileNameW; the win32 modal pump cannot share netsurf's SDL process) — the dialogue opens on its own agent socket starting at $HOME, a second gadget click under it is ignored, Cancel fires NO event, a typed absolute path + Open fires exactly one `input` with the value and repaints the gadget, a re-open starts at the last accepted directory, and a GET submit carries the VALUE in the query while GW_EVENT_NEW_CONTENT kills the still-open picker (the BYTES half needs an http fetcher: todos/0437)
  ['test_netsurf_select_reconvert_e2e.js', BOOT, IMG], // todos/0434: an OPEN core select menu survives a live re-conversion — a mid-menu change listener's JS mutation re-boxes the document while the menu is up; the settle rule re-attaches (unrelated option.selected write: menu stays open, band at its EXACT 96px-scrolled row, one change event) or dismisses (the anchor option removed: menu closes, NO change event fires), and an appended selected option grows the scroll range (its band reachable at the 21-item clamp); every leg's #mark strip proves the re-conversion really ran
  ['test_netsurf_restyle_e2e.js', BOOT, IMG], // todos/0316: a class-selector restyle on an EXISTING element repaints, promptly — one click rewrites an existing element's class (`.slab.on`), gives a class-less one its first (`#idsel.on`), creates one carrying the same compound selector, and fills a canvas; all five probes must light in the SAME frame, which pins both defects (libdom's never-refreshed class cache, and the gucOS loop parking on a deadline sampled before the JS handler scheduled the re-conversion)
  ['test_netsurf_http_e2e.js', BOOT, IMG, { timeoutMs: 900000 }],    // #182 (todos/0437): REAL NETWORKING — the gucOS http/https fetcher (gucos/httpfetch.c over the kernel HTTP transport) against a live local server: an http: page renders end to end, a GET form's query and a urlenc POST's body reach the wire, a redirect renders the FINAL page with llcache's refetch observed server-side and the relative <img> resolving against the FINAL directory (the #359 x-guc-final-url payoff, asserted in BOTH direct and bridge modes), a 404 body renders as content, and DNS-failure/connection-refused/headers-timeout each raise the fetch-error query page instead of a hang; since #368 also the RESPONSE-HEADER legs (the fetcher used to emit ZERO FETCH_HEADER messages): content-type asserted through a charset=utf-8 page with no <meta charset> decoding as UTF-8 and NOT as the Windows-1252 mojibake, etag/last-modified through the If-None-Match + If-Modified-Since a link-click revalidation puts on the wire (answered 304, page still renders), and cache-control through max-age=3600 keeping a second visit off the wire entirely.  900s: the #368 legs add ~10 navigations to a boot that already spends the kernel's 30s headers deadline
  ['test_netsurf_demos_e2e.js', BOOT, IMG],   // the `seed` content resource kind's first consumer (packages/netsurf-demos.json): a fresh fat boot carries every declared file byte-for-byte under Desktop/Presentations/samples/Web Demos (derived from the package + os-common's tree walk, never a list), the pre-existing sample survives the additive merge, the Desktop icon set is untouched, and EVERY seeded demo really runs — its load-check pill goes green only if the page's EXTERNAL stylesheet AND EXTERNAL script both loaded (two negative controls: script removed = red, stylesheet removed = colourless)
  ['test_present_e2e.js', BOOT, IMG],  // 0119: /bin/sent + /bin/mgp — demo decks render (glyphs, %default bg, %tab icons), paging, q quits
  ['test_mgpp_e2e.js', BOOT, IMG],     // 0272: /bin/mgpp — MagicPointPlus fork (-DMGPP): left-half click / Left arrow go BACK, right-half / Right arrow forward; space/b/q unchanged (pixel-identity page assertions)
  ['test_mgp_livereload_e2e.js', BOOT, IMG], // #75/0264: mgp live-reload — the deck watch is wantreload()'s ONE source (ctime poll gone): external tmp+rename-over and truncate-rewrite saves re-render, background-color-proven
  ['test_deck_e2e.js', BOOT, IMG],     // 0284: /bin/deck — --validate/--shot goldens on the seeded demo, self-maximize, FS_WATCH live reload (rename-over, slide preserved BY ID), broken-save last-good + red banner + recovery, Ctrl-R, openwith .deck
  ['test_fileman_watch_e2e.js', BOOT, IMG],  // #75/0264 (closes 0123): fileman auto-refresh — external create/rename-over/delete re-list unprompted via RegisterFdWake→WM_FSCHANGE, selection carried by name, navigation re-arms
  ['test_clipboard_e2e.js', BOOT, IMG], // 0090: the system clipboard — kernel slot via /bin/clip, notepad copy/cut/paste across processes, term drag-select + Ctrl+Shift+C/V
  ['test_pbcopy_e2e.js', BOOT, IMG], // 0397: /bin/pbcopy + /bin/pbpaste over os/clipio.h — the macOS names on the SAME one kernel slot as /bin/clip (interop asserted both directions), empty-slot exit 1 printing nothing, argv refused with exit 2, the clip refactor's contract unchanged, 170KB chunking, the recorded text-only NUL limit (with a negative control), and notepad paste/copy through the win32 veneer
  ['test_hostclip_e2e.js', BOOT], // ticket #79 + the clipboard seam: onClipboard fires at CLIP_SET commit (loop guard, clear reports null); deferred CLIP_GET parks a data read on onClipRead's done (first paste fresh by construction), SDL_HasClipboardText peeks without firing the hook, SIGKILL-while-parked tears down cleanly and a late done() is a no-op
  ['test_egress_e2e.js', IMG], // 0398: the gucOS->host egress seam headless — os/egress.h -> EGRESS RPC -> onEgress: lone file bytes, lone-symlink follow, dir/multi store-only zips (symlink entries, empty dirs, CRCs), ENOENT/EINVAL/E2BIG/EFBIG(pre-read, sparse-proven)/ENOSYS, the boot.js --egress-dir twin + '-N' collision suffix
  ['test_keymap_e2e.js', BOOT, IMG],   // 0149/0150: the keyboard scheme (os/keys.h) — windows/macos verb tables in EDIT, the FCONTROL accel swap (fileman), term ⌘V/⌘C vs Ctrl+Shift, readline rows + off-switch, 1Hz live revalidate, ctlpanel Keyboard applet delta-writes
  ['test_hostpaste_e2e.js', BOOT, IMG], // ticket #96/0432: paste legibility + robustness — /run/host-platform verdict both values, the implicit host-native ⌘V paste row on a STALE windows-scheme volume (no scheme flip, no user-config write, non-mac negative control), the drawn menu accel field (Ctrl+V vs Cmd+V, the menucore choke), ctlpanel Keyboard effective-chord listing + live flip
  ['test_ctxmenu_e2e.js', BOOT, IMG],  // 0091: right-click context menus — wm.c desktop/icon/taskbar popups (geometry, dismissal, flyouts, keyboard nav), EDIT WM_CONTEXTMENU via the agent, ctlpanel argv
  ['test_desk_icons_e2e.js', BOOT, IMG], // ticket #82: per-filetype desktop icon glyphs — desk_kind dispatch (exec/text/image/deck/generic/dir/bin), center-pixel contract: navy = program/folder/full-bin, white = data files/empty bin
  ['test_desktop_defaults_e2e.js', BOOT, IMG], // Lane D (source-lib §6): the baked /usr/share/desktop/default rendering + /usr/bin/desktop-defaults additive reconcile — deleted defaults restored (link/script/nested data), user files + name-squats never touched, idempotent re-run, phase-2 installed-package icons (explicit action beats the flag, DB-recorded), the wm.c ctx-menu row
  ['test_gpubox_dawn_e2e.js', BOOT, IMG], // 0016 tier 1: gpubox (webgpu.h) under Dawn — readback->shm shots, tolerance-diff; SKIPs without the webgpu pkg
  ['test_gpubox_menu_e2e.js', BOOT, IMG], // 0258 M2 acceptance: gpubox's win32 menu WITHOUT Dawn — A14 no-GPU survival, bar/popup children over the black client, Spin/Wireframe via the agent; forces tier 0 via lib/nodawn-require.js
  ['test_gpu_multiwin_dawn_e2e.js', BOOT], // menu item 0 / A4: TWO GPU windows, per-window present binding — each shows ITS color, no newest-wins clobber; SKIPs without the webgpu pkg
  ['test_cc_srclib.js'],    // Lane A (source-lib §1) unit legs, no boot: systemIncludePaths tier order + the builtin-beats-ambient precedence (-I still shadows), __require_source FS tiers (sourceRoots exact map, sourcePaths search), name validation (traversal loud), path-identity dedup, buildProject/CLI srcRoots plumbing + --srcroot conflicts
  ['test_cc_srclib_e2e.js', BOOT, IMG], // Lane A e2e: in-OS cc pulls a shell-planted synthetic lib from /usr/local/{include,src} (no -I, no TU list), transitive FS requires + same-dir quote includes, '..' require name is a loud error, planted builtin twins (__SDL.c/__alloca.c/stdio.h) stay inert
  ['test_cc_libpng_e2e.js', { timeoutMs: 900000 }], // Minesweeper lane + #498: <png.h> and <zlib.h> link STANDALONE from the in-OS cc (the headers carry their own require blocks, source-lib §4.2/#464) — fat image runs the SDL_image veneer round trip AND png-only AND zlib-only round trips, -DPNG/-DZLIB_NO_REQUIRE_SOURCES hatches must fail at link (the red controls); minimal image proves an <SDL3/SDL.h>-only program links LIBPNG-FREE, <png.h> fails clean, and `gucman install libpng` makes both standalone; shares the cached minimal blob + mkpkg pool with the gucman e2es
  ['test_cc_imagelibs_e2e.js', { timeoutMs: 1200000 }], // #661: the image/compositing stack as STANDALONE srclib packages — <pixman.h>, <cairo.h> and <gif_lib.h> each carry their own require block (source-lib §4.2), so the fat image links a pixman composite, a cairo draw (which proves pixman/libpng/zlib/freetype TRANSITIVELY — cairo.h requires only cairo's own 121 TUs) and a REAL 2x2 GIF decode, each with its -D<LIB>_NO_REQUIRE_SOURCES hatch as the red control; the minimal image then installs zlib STANDALONE and libpng ON TOP OF IT — the ownership guard for the #661 split, which pre-#661 refused because libpng planted the same zlib.h/src/z — then cairo pulls pixman+freetype via deps[] and `gucman remove zlib` must REFUSE on the recorded revdep edges; shares the cached minimal blob + mkpkg pool with the gucman e2es
  ['test_cc_cjson_e2e.js', { timeoutMs: 900000 }], // #662: cJSON as a STANDALONE srclib package — <cJSON.h> carries its own require block (source-lib §4.2), so the fat image parses/mutates/round-trips a non-trivial JSON document from a bare include (serialize -> re-parse -> re-serialize byte-identical), with the -DCJSON_NO_REQUIRE_SOURCES hatch as the red control; the minimal image fails clean then works after `gucman install cjson` through /usr/local/{include,src}; shares the cached minimal blob + mkpkg pool with the gucman e2es
  ['test_gdiplus_e2e.js', BOOT, IMG], // 0453/#94: gdiplus-mini — the 29 flat GDI+ entry points DERIVED from ReactOS shimgvw @e3e58ac1, driven in-OS via `gdiplusdemo selftest`: PNG/GIF/BMP/JPEG each decode through the shim from an independently-encoded fixture AND each has a can-fail control (corrupt/truncated bytes must be rejected), the 2x NEAREST StretchBlt draw asserted pixel-exact, rotate/flip as a pixel loop (StretchBlt refuses mirroring extents), static codec tables + PNG/BMP save round trips, the ole32 memory IStream, and the fail-loud refusals with their WIN32_UNSUPPORTED stderr lines; the check TOTAL is pinned so a shrinking selftest cannot still print PASS
  ['test_cc_libjpeg_e2e.js', { timeoutMs: 900000 }], // 0448/#93 + #498: <jpeglib.h> links STANDALONE from the in-OS cc (the header carries its own require block, source-lib §4.2/#464 — the program hand-wrote the TU list before #498) — encode→decode round trip with exact pixels vs the clang-native golden + corrupt-stream rejection (the can-fail control), -DJPEG_NO_REQUIRE_SOURCES hatch must fail at link; minimal image fails clean then works after `gucman install libjpeg`; shares the cached minimal blob + mkpkg pool with the gucman e2es
  ['test_minesweeper_sample_e2e.js', BOOT, IMG], // v163 tap-to-run sample: the ONE Desktop/Presentations/samples .sh (0755), dblclick folder -> fileman -> open it -> the `[ -n "$TERM" ] || exec term "$0"` guard re-execs the headless-spawned script into a term window (mkdir marker proves it's executing); network-free by design
  ['test_sdl_render_e2e.js', BOOT, { timeoutMs: 600000 }], // Minesweeper lane: the SDL_Render* choke — in-OS cc builds a scene app (clear + NONE/BLEND/ADD/MOD fill quads + NEAREST/LINEAR scaled textures + blended textures), wmctl shot pixel-asserts every arm; headless this pins the SOFTWARE renderer tier (the GPU tier shares the batch geometry and SDL_BLEND_DESC semantics)
  ['test_cc_freetype_e2e.js', { timeoutMs: 900000 }], // ticket #464: FreeType as a STANDALONE srclib package — `cc ftdemo.c` on the fat image pulls the whole library through ft2build.h's OWN require block (no -I, no TU list, no win32) and really renders a glyph from the baked mono.ttf; -DFT_NO_REQUIRE_SOURCES must fail at link (the hatch is the red control); minimal image fails clean, `gucman install freetype` plants the tiers WITHOUT win32 and the same compile+run works; shares the cached minimal blob + mkpkg pool with the gucman e2es
  ['test_cc_win32_e2e.js', { timeoutMs: 900000 }], // Lane B2 (source-lib §4): win32 apps compile IN-OS — `cc hellowin.c` pulls the whole veneer+freetype through windows.h's require block, physical-TU-path resolution crosses the srclib symlink farms ("../fontcore.h", freetype "../src/..."), the built app's window+BUTTON drive via wmctl tree/click; the documented -DUNICODE …wwinmain.c path; minimal image fails clean then works after `gucman install win32`; shares the cached minimal blob + mkpkg pool with the gucman e2es
  ['test_gucman_e2e.js', { timeoutMs: 900000 }], // gucman Slice 1: install/remove/list on the MINIMAL image (punes as a package) — sha256 refusal before extraction, staged atomic install, launch from /usr/local/bin, reboot persistence, exact DB-replay removal; bakes its own no-packages blob + runs mkpkg (both cached), so a cold run is bake-heavy like test_os_boot
  ['test_clang_pkgs_e2e.js', { timeoutMs: 900000 }], // T1 C++ ladder: the *-clang gucman channel end-to-end — box2d-clang/imgui-clang cards on the --clang superset repo, install/launch (Box2D window + banner; ImGui window + Process Inspector reading the REAL /proc), clean remove; SKIPs without the clang-simplified sibling's published overlay (base estate never hard-requires it); shares the cached minimal blob with the gucman e2es but rebuilds dist/packages as the --clang superset (accepted thrash, Part II §7)
  ['test_cpython_clang_e2e.js', { timeoutMs: 1200000 }], // todos/0340 + 0331: CPython 3.13.5 as a gucman package, in-OS — install/remove, the Clang banner, ZERO-env landmark stdlib discovery over RemoteFS (and through a symlinked argv0, which host.js's readlink cannot prove), script argv + exit-status propagation, `subprocess.run(["ls"])` really crossing the posix_spawn broker (no fork, PATH via posix_spawnp, close_fds via the kernel's CLOSEFROM fd action), the in-OS import-sweep NUMBER with every failure required to be a named CPYTHON.md §3.3 casualty, zlib/gzip/sqlite3-on-BlockFS/C-_decimal/ELOOP, and the pyc cache landing in /var while /opt stays pristine; SKIPs without the clang-simplified sibling's published overlay
  ['test_rust_pkgs_e2e.js', { timeoutMs: 900000 }], // todos/0416: the -rust gucman channel end-to-end — the wc-rust card on the --rust superset repo (real gucos-rust overlay), in-OS base purity (zero *-rust, 127 before install), install/run (output byte-equal to the busybox wc applet), clean remove; overlay sha256 must equal the committed fixture's (producer/consumer identity); SKIPs without the sibling's published overlay (base estate never hard-requires it; RUST_REQUIRE=1 makes absence loud)
  ['test_rust_e2e.js', BOOT, IMG], // todos/0413 + 0414 + 0415: Rust binaries run in gucOS and gucos-sys is the ONE "c" binding — committed fixtures (sha256-pinned) spawned from the shell in a booted OS: hello + panic→__exit(101, stderr-reported, no hang) + alloc-rust (Vec/String/Box/BTreeMap/sort/format! over the libc-malloc #[global_allocator], Rust/C allocations INTERLEAVED on the one heap), module shape per RUST.md §2; sibling-gated legs (gucos-rust at RUST_ROOT, default ~/git/gucos-rust): freshness rebuilds must be byte-equal (both artifacts), missing #[link(wasm_import_module="c")] must FAIL AT LINK naming the symbol, a no-alloca module must trap at start-up, an absent-import module must FAIL AT LOAD naming the import, and the single-declaration guard (no host import outside gucos-sys, none declared twice); absent sibling SKIPs those legs unless RUST_REQUIRE=1 (then loud fail + fix command); + 0415: wc-rust (a real -rust tool over BlockFS) byte-compared against the busybox wc applet on the same inputs in the same booted OS, with one large-input leg per read loop (regular file = the kernel's S_IFREG reassembly; piped stdin = the tool's own loop, sized past the pipe ring and KP_FS_CHUNK, both derived)
  ['test_rust_std_e2e.js', BOOT, IMG], // todos/0442: std on wasip1 — the wasi_snapshot_preview1 shim (BlockFS.toWasiPreview1) beside "c": committed std-rust fixture (sha256-pinned, upstream std on stable wasm32-wasip1, gucos-sys getpid in the SAME module) runs standalone (--block-fs; full deterministic output, exit7 via proc_exit, panic=abort trap semantics, Node-fs flavor refuses loud) and in-OS from the shell; shim unit legs: the "/" preopen is a REAL fd (lowest free slot, no "c" collision), the O_DIRECTORY substrate (0400 fs half — plain O_RDONLY-on-dir stays EISDIR), poll_oneoff pure-clock really sleeps / pipe-fd immediate+timeout (no kernel) / kernel path forwards BOTH r AND w lists in ONE waitMulti (the census gap-2 write-fd-drop regression guard) + EINTR mapping, the served/absent split (five absent names LinkError naming module+symbol against a real one-import module; the ENOTSUP trio answers 58); sibling-gated: freshness rebuild byte-equal + build.sh REFUSES -Zbuild-std naming the 0418 ruling (with the plain build as positive control)
  ['test_seed_e2e.js', { timeoutMs: 900000 }], // the gucman `seed` CONTENT resource kind: mkpkg's negative legs (".." / absolute / dot-prefixed dest — `.config/openwith` by name — bad src, nested dests, reserved control.json), install plants copies + records {path,sha256} per file, collision kept-and-unrecorded, remove unlinks PRISTINE copies but keeps MODIFIED ones loudly, a failed install unwinds every seed, and the virgin-root baked pass + reconcile phase 3 off a blob folded with a throwaway definition (mkpkg/mkimage/boot --packages-dir); bakes its own seed-carrying blob + shares the cached minimal one
  ['test_gucman_scripts_e2e.js', { timeoutMs: 900000 }], // ticket #74: the postinst/prerm script hatch — scripts are payload members named by control.json, run at the transaction edges (postinst after the plant/BEFORE the DB write with full rollback on failure; prerm first in remove, loud-but-non-blocking on failure), fixed argv/env/cwd contract, wall-clock bound (GUCMAN_SCRIPT_TIMEOUT_MS test seam) SIGKILLs a hung script, runnable-peek refusal of a hand-rolled non-runnable payload, mkpkg build gates + foldPackages refusal; shares the cached minimal blob + mkpkg pool with the gucman e2es
  ['test_gucman_sources_e2e.js', { timeoutMs: 900000 }], // todos #407: mechanical <pkg>-sources companions — gcode-sources (image derivation, the jku demo) + lua-sources (package derivation) install through gucman, the payload-root ('.') srclib namespace plants /usr/local/src/<name> and replays exactly, source bytes byte-exact vs the repo (in-OS sha256); shares the cached minimal blob + mkpkg pool with the gucman e2es
  ['test_stdinc_e2e.js', { timeoutMs: 900000 }], // ticket #439: the C stdlib is READABLE in-OS — a VIRGIN minimal boot cats every /usr/include header, full-set sha256-equal to the compiler's merged literal map (hazard 1: baked headers are documentation, drift fails here); the fat image agrees with the srclib tier folded in (hazard 2 end-to-end); libc-sources ('builtin' derivation) installs and the .c units are byte-exact; shares the cached minimal blob + mkpkg pool
  ['test_gucman_libgit2_e2e.js', { timeoutMs: 2400000 }], // ticket #473: libgit2 as a gucman srclib package — minimal image is bare, install plants the include-tier links (git2.h, the git2/ tree, git2_srclib.h) + the /usr/local/src/git2 namespace, the in-OS `cc` builds a REAL git program with NO -I and NO TU list (~190 TUs pulled by git2_srclib.h's require block, every internal header resolved same-dir through the generated forwarders — a srclib package cannot carry compilerArgs), the binary writes a commit and walks it (also the proof missing_stubs.c's __minstack(1048576) survives the in-OS compile AND the OS spawn path), the install and the built binary survive a reboot, remove replays exactly and the same compile then fails on the missing header; the ~190-TU in-OS compile is the long pole, hence the 40-minute cap; shares the cached minimal blob + mkpkg pool with the gucman e2es
  ['test_gucman_quake_e2e.js', { timeoutMs: 900000 }], // gucman fat-data leg: the ~8.6 MiB quake package (18.7 MB pak0) installs on the minimal image — in-OS sha256sum proves the pak byte-exact through fetch→inflate→untar→BlockFS, the self-locating launcher boots the game, remove reclaims the tree; shares the cached minimal blob + mkpkg pool with test_gucman_e2e
  ['test_gucman_doom_e2e.js', { timeoutMs: 900000 }], // #420: doom is a DEFAULT package, not baked mass — minimal boot has no /bin/doom, no Games menu link, no Desktop link, no /root/doom1.wad; the baked defaults file names doom, offline first boot fails LEGIBLY and the networked reboot installs it with zero user action (WAD byte-exact in-OS sha256, the game really opens "DOOM Shareware" off the launcher's -iwad), remove replays clean + tombstones; shares the cached minimal blob + mkpkg pool with the gucman e2es
  ['test_gucman_upgrade_e2e.js', { timeoutMs: 900000 }], // #545: `gucman upgrade [<name>]` — an installed package converges on the repository version via a STAGED REPLACEMENT (never remove+install): old prerm/new postinst run with argv[1]="upgrade", NO tombstone and NO revdep guard on the way (the #419/#624 hazards), the DB record only ever atomically replaced; cmdalt claim + font fallback lines keep their POSITION (the dispatch default never flips — red control vs a second claimant), dropped claims/faces reconciled, pristine seeds refreshed vs modified seeds kept, Desktop shortcut preserved by PRESENCE ignoring the toggle both ways, downgrade converges too, bare `upgrade` sweeps all installed, and the crash window is pinned live: SIGKILL gucman mid-postinst -> no tombstone + old record intact + re-run converges; shares the cached minimal blob + mkpkg pool with the gucman e2es
  ['test_defaults_sync_e2e.js', { timeoutMs: 900000 }], // #419: default packages, eager install on first boot — the /etc-declared set (punes + a --defs fixture font package: the non-app/glyph-cache case, hermetic since #615 moved the real fonts to gucos-packages) installs with zero user action on the next boot, `gucman remove` writes a tombstone the sync honors forever (removal is DURABLE — reboot never resurrects), a later-added default installs on a cached image's next boot, dead-repo/unknown-name fail loud + legible with the OS unharmed and retry on the next healthy boot; shares the cached minimal blob + mkpkg pool with the gucman e2es
  ['test_gucman_apps_e2e.js', { timeoutMs: 1200000 }], // #417+#418: netsurf/demos/gameboy/sameboy install from the minimal image and RUN — netsurf's resource closure from /opt/netsurf/res (welcome page + a real file:// page), winbox + ctldemo (.res sidecar) from the demos bundle, both emulators loading a real minimal ROM; shares the cached minimal blob + mkpkg pool (netsurf makes the cold pool build the long pole)
  ['test_symbolfont_e2e.js', { timeoutMs: 900000 }], // #435: Noto Sans Symbols 2 baked + registered in the BAKED /usr/share/fonts/fallback — clean no-packages first boot renders ⌘⌥⇧⌫⏎ as real distinct term glyphs (not the tofu box) and notepad's gdi32 tofu report names only the permanently-unassigned U+0378 in-run control (never U+2318); U+2303 ⌃ deliberately unasserted (not in Symbols 2 — measured, see the file header)
  ['test_git_e2e.js', { timeoutMs: 900000 }],
  ['test_git_net_e2e.js', { timeoutMs: 900000 }], // ticket #478: the git NETWORK leg — clone/fetch/fast-forward-pull/push over smart HTTP against the HOST's real git (gitserve.js drives upload-pack/receive-pack --stateless-rpc): a multi-MB pack streams through the kernel http fd, the pushed commit is verified SERVER-side (`git fsck --strict` + ref/sha/content readbacks), non-fast-forward push refuses loud, Basic auth works from the URL and from ~/.git-credentials (a credential-less clone fails NAMED), and a 301'd clone re-bases its POSTs; shares the cached minimal blob + mkpkg pool with the gucman e2es // ticket #474: git as a gucman package — `gucman install git` on the MINIMAL image plants /opt/git + the /usr/local/bin/git symlink + the DB record, and the CLI is DIFFERENTIALLY checked against the host's real git on the deterministic fakegit fixture (delivered in-OS by curl+tar): repo DISCOVERY from the root, from a subdirectory and three levels down with no path argument, `-C` as git spells it, `cat-file -p <tree>` line-for-line vs host git, `status` verbatim vs tests/fakegit/status/expected.txt, git's own fatal outside a repo, and the read-only refusal for `commit`; reboot persistence + exact DB-replay removal; shares the cached minimal blob + mkpkg pool with the gucman e2es
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

// Per-class peak RSS weights for the RAM-budgeted pool (#576 A2/A4/#579).
// The pool admits entries while the running set's summed weights stay under
// ramBudgetGb() (totalmem × 0.6) — 4 uniform jobs ≈ 16.7 GB is the shape
// that crashed a 16 GB box on 2026-07-25, and the budget is the guard that
// replaced the uniform -j clamp.
//
// 🔴 THE EVIDENCE. Every figure below is the WORST across all six sampled
// artifacts below (#579, 2026-08-08, idle 16 GB box). Units are GiB (`ps rss`
// reports KiB). Re-measure with:
//   node tests/lib/rss-sample.js --out=build/rss.json -- node tests/kernel/run.js
//
//   artifact                         scope + config              wall  verdict
//   build/rss-579-baseline.json      full, old weights (cold)  1289.5s 169/169
//   build/rss-579-baseline-warm.json full, old weights         1153.8s 169/169
//   build/rss-579-after.json         full, 1st cut              765.2s 169/169
//   build/rss-579-final.json         full, 2nd cut              879.1s 169/169
//   build/rss-579-xl.json            full, XL cut               984.1s 168/169
//   build/rss-579-pkgsolo.json       2 ROWS ONLY, serial, 3x each, 250 ms
//
// Read that table honestly: rss-579-xl.json is NOT a green run (test_os_boot.js
// timed out at its 300 s leg budget on a 99%-full disk), and rss-579-pkgsolo
// is not a suite run at all — it is two rows repeated three times to get an
// uncontended read. Both are still valid as RSS evidence, which is all they
// are used for here.
//
// Six artifacts, not one, and that is the whole methodology. The sampler
// UNDER-states a true peak (it samples; spikes between samples are missed), so
// a sampled maximum is a LOWER BOUND on the real one, and adding runs can
// expose more of the tail. It is not a monotonic creep — the same row moves
// both ways run to run:
//   test_micropython_script_e2e.js  1.01 -> 1.46 -> 1.628 GiB
//   test_gucman_e2e.js       4.802 -> 3.917 -> 5.344 -> 5.434 GiB (chronological)
// That non-monotonicity is exactly why one run cannot settle a weight: the
// first cut of #579 sized BOOT off one run at 1.5 (1.03x), and sized PKG at 5
// off two runs when a LATER run recorded 5.344. So: worst of every artifact,
// then real margin, and treat any headroom under ~1.2x as not yet proven.
//
//   class    rows  worst peak  from which run          weight  headroom
//   LIGHT      21  0.171 GiB   after   (wm_policy)        0.5     2.9x
//   BOOT      118  1.628 GiB   basewarm(micropython)      2       1.23x
//   (default)   9  1.547 GiB   final   (egress)           4.5     2.9x
//   os_boot     1  3.866 GiB   final                      5       1.29x
//   XL         20  5.783 GiB   final   (punes)            7       1.21x
//
// #579 was filed on the premise that HEAVY_GB=4 was uniformly too big. It is
// too big for 118 rows and TOO SMALL for twenty: every gucman-family row can
// reach ~5 GiB (test_gucman_e2e.js 5.344, test_defaults_sync_e2e.js 5.080)
// and test_punes_e2e.js reaches 5.783 — all were charged 4. So this is NOT a
// global reduction: one class moved down hard and one moved up.
//
// The 0.6 budget fraction is the SECOND line of defence and it is what makes
// a 1.2x per-class margin acceptable: if every running row overshot its
// charge by 25% at once, a full 9.6 GiB reservation lands at ~12 GiB on a
// 16 GB box. The 2026-07-25 OOM was a 4x class error (16.7 GiB charged on a
// 16 GB box), not a 20% one — that is the failure this budget exists to stop.
//
// 10 LIGHT rows and 4 default rows produced NO sample row in ANY run: they
// finish inside one sampling tick. "No row" is NOT "no memory" — those 4 are
// why the default stays conservative, and why LIGHT_GB is 0.5 rather than
// the ~0.2 the sampled LIGHT rows on their own would justify.
//
// ⚠️ ONE ROW MAY EXCEED THE WHOLE BUDGET. runSuite admits queue index 0 with
// no budget comparison when nothing is running (suite-runner.js), so a lone
// overweight row always runs rather than deadlocking. That window widens
// with these weights: a row is "lone-overweight" below 7.5 GB RAM at the
// default, below 8.33 at os_boot's 5, and below 11.67 GB at XL's 7. On such
// a box the pool deliberately exceeds its nominal 60% headroom for exactly
// one member at a time. That is the intended trade — refusing to run at all
// would be worse — but it is why XL rows must never be able to PAIR.
const HEAVY_GB = 4.5;  // default: untagged, i.e. UNMEASURED or measured >1.1 GiB
const LIGHT_GB = 0.5;
const BOOT_GB = 2;
// test_os_boot.js gets its own weight rather than riding the default: it is
// the most-sampled row in the suite by three orders of magnitude (~1500
// samples per full run, since it IS the long pole), so its 3.866 GiB is the
// best-characterised number here and does not need the default's slack for
// the unmeasured. Costs nothing: 9.6 - 5 = 4.6 still admits 2 BOOT + 1 LIGHT
// beside it, exactly as 9.6 - 4.5 = 5.1 did (a third BOOT needs 6).
const OSBOOT_GB = 5;
// XL = the 19 gucman-family rows (derived, see PKG_RE below) + the one
// three-boot NES row. Measured 5.080-5.783 GiB; they are one physical class
// — a full boot with a second heavy node process (mkpkg / a second boot)
// resident beside it — so they get one weight.
//
// 7 GiB is a MEMORY figure and nothing else: 5.783 worst observed, 1.21x.
// It also means XL cannot share the box with test_os_boot.js (5 + 7 = 12 >
// 9.6 here); the earlier 4.5 + 5 = 9.5 pairing was retired because PKG's real
// peak (5.344) was ABOVE its own 5 GiB reservation, so that 0.1 GiB of
// "slack" was never a memory margin at all.
//
// 🔴 The mkpkg mutual exclusion is NOT this number. An earlier cut of #579
// claimed "two XL is 14 GiB, so they can never both run" — false on any host
// where the budget reaches 14, i.e. totalmem >= 14 / 0.6 = 23.34 GiB. A 24 GiB
// box has a 14.4 GiB budget and admits BOTH. So a weight can only ever buy
// mutual exclusion on machines small enough, and silently drops it exactly
// where there is room to run two. Exclusion is now declared on its own axis
// (XL_EXCL -> the `exclusive` option in tests/lib/suite-runner.js) and holds
// on every host regardless of RAM.
const XL_GB = 7;
// One exclusion key for the whole XL class: these rows drive mkpkg over the
// shared content-addressed pool (tests/kernel/lib/gucman.js), and two builds
// at once is the todos/0388 race that retargeted a sibling's repo mid-read.
const XL_EXCL = 'gucman-mkpkg';

const defaults = {
  // `jobs` is now only the CPU-axis cap (concurrent files); RAM is governed
  // by the weight budget above. Kept modest: boots are compile-dominated
  // and too much CPU contention starves the in-OS `sleep N` waits (the
  // timing-flake class). CC_NO_MEM_CAP=1 drops the RAM budget entirely.
  jobs: Math.max(1, Math.min(6, os.cpus().length - 2)),
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

// ---- sibling-owned tests (#613, design §3) ----
//
// gucos-packages carries its own per-package e2es + member manifest; when the
// checkout is present beside c-compiler (resolved through the worktree's
// gitdir pointer — the naive ../gucos-packages does not exist from a linked
// worktree) they JOIN this suite, and a sibling red blocks a c-compiler land.
// That coupling direction is correct: a compiler.js change that breaks a
// shipping package is exactly what those tests exist to catch. ABSENT is a
// loud SKIP, never a failure — failing would make every contributor's gate
// depend on cloning an optional repo, the exact coupling the sibling repo
// removes, reintroduced through the back door; the hole is closed at the
// SHIP boundary instead (comguc's assertSiblingUsable makes the sibling
// mandatory where the #428 rule-5 pre-deploy gate runs). A present-but-
// MALFORMED sibling is loud-fatal: every malformed-manifest shape degrades
// to "zero members", which is indistinguishable from "no tests" and would
// print green while the sibling's tests never run.
const CC_ROOT = path.resolve(__dirname, '..', '..');
const sibling = loadSiblingTests({ ccRoot: CC_ROOT });
if (sibling.status === 'invalid') {
  process.stderr.write(`\x1b[31m[sibling-tests] ${sibling.name} at ${sibling.root} is present but its test contract is broken:\x1b[0m\n`);
  for (const e of sibling.errors) process.stderr.write(`  ${e}\n`);
  process.stderr.write('  Fix the sibling checkout (its README\'s "Tests" section is the contract), or remove/unset it to skip.\n');
  process.exit(2);
} else if (sibling.status === 'absent') {
  process.stdout.write(`\x1b[33msibling tests: SKIPPED — ${sibling.name} is not present beside c-compiler; `
    + `clone github.com/josephkimgpt/${sibling.name} beside the main clone (or set GUCOS_PACKAGES=) to run its package tests.\x1b[0m\n`);
} else {
  // The sibling's half of the #314 guard: set equality between its tests/
  // dir and its own manifest, per repo — a sibling test_*.js on disk that is
  // in no member list refuses the run naming the file, exactly like a native
  // one. A second call, not an extension of the first: the guard is
  // per-directory, so sibling files can never trip c-compiler's own check.
  assertMemberRegistry({
    dir: sibling.testsDir, pattern: sibling.pattern, entries: sibling.members,
    exclude: sibling.exclude, label: `${sibling.name}/tests/manifest.json`,
  });
  process.stdout.write(`sibling tests: ${sibling.name} at ${sibling.root} (via ${sibling.via}) — `
    + `${sibling.entries.length} member(s) join the suite\n`);
}

// Crash safety: EVEN an explicit -j runs under the RAM-weight budget — an
// over-eager -j8 on a 16 GB box is exactly the OOM that killed the GUI
// (2026-07-25). The budget admits extra jobs only when their summed weights
// fit, so -j8 here means "up to 8 files when RAM allows", never 8 boots.

// Heavy-suite mutual exclusion: refuse to start if another heavy runner (a
// second kernel run, or a browser sweep) already owns the host — their overlap
// is what exhausted RAM and crashed the machine. Skipped for --list (no boots).
// joinHeavyLock, not acquire (#561): under a tests/run.js gate the DISPATCHER
// owns the lock for the whole selected run (its reservation is what stops a
// sibling boot seizing the lock between suites) and this joins re-entrantly
// through the verified marker; hand-run there is no marker, so this acquires
// and owns exactly as before.
if (!opts.list) joinHeavyLock({ name: 'kernel suite' });

// Leak pre-flight — AFTER the lock, deliberately (see the same call in
// tests/browser/os-sweep.mjs). THIS suite is the one that mints the $TMPDIR
// os-* fixture dirs, ~150 MB apiece, so it is also the one that most needs the
// abandoned ones swept before it adds 60 more. Reaping is by dead-owner-pid, so
// a hand-run single e2e (which takes no lock) is never touched.
if (!opts.list) preflight({ name: 'kernel suite' });

const entries = tests.map(([file, ...rest]) => Object.assign({ file }, ...rest.filter(x => typeof x === 'object')))
  // Sibling members ride the same pool. Deliberately UNTAGGED for the RAM
  // classes (no light/boot — those are assertions about measurements, #579),
  // so each lands in the over-charged HEAVY_GB default; the manifest may pass
  // timeoutMs/serial/image through, nothing else (sibling-tests.js validates).
  .concat(sibling.status === 'ok' ? sibling.entries : []);

// The PKG class is DERIVED from each member's source, not declared in the
// table above. That is deliberate: "does this file call ensureMinimalImage()"
// is a property of the SOURCE, and a hand-maintained mirror of a source
// property is precisely the bookkeeping that #314 shows goes stale silently —
// except that here a stale entry does not merely hide a test, it UNDER-CHARGES
// a ~5 GiB row by 2.5 GiB and over-commits the box. Deriving it means a new
// gucman-family e2e is weighted and pre-baked correctly the day it lands, with
// nothing to remember.
//
// This NARROWS the stale-bookkeeping window; it does not close it. The match is
// textual, so a member reaching the helper through a WRAPPER would not match.
// That fails to the 4.5 default — safe-ish, though it also skips the pre-bake —
// but a row that is ALSO tagged BOOT would land at 2 GiB, which is not safe. No
// current member is misclassified (checked, not assumed). So "call
// ensureMinimalImage by name" is a convention here, not an enforced invariant.
const PKG_RE = /ensureMinimalImage/;
for (const e of entries) {
  // e.src (sibling members, #613) is where the source actually lives; joining
  // __dirname with a prefixed key would always throw and land every sibling
  // row in the expensive class silently.
  try { e.pkg = PKG_RE.test(fs.readFileSync(e.src || path.join(__dirname, e.file), 'utf-8')); }
  catch (err) { e.pkg = true; }   // unreadable -> assume the expensive class
}

// Weight assignment, most-specific first. Anything that matches nothing gets
// HEAVY_GB, so a brand-new e2e is over-charged rather than under-charged.
for (const e of entries) {
  const xl = e.pkg || e.file === 'test_punes_e2e.js';
  e.gb = e.file === 'test_os_boot.js' ? OSBOOT_GB
       : xl ? XL_GB
       : e.light ? LIGHT_GB
       : e.boot ? BOOT_GB
       : HEAVY_GB;
  // Only the mkpkg users need the exclusion; test_punes_e2e.js is XL for its
  // memory alone, so it stays free to overlap a gucman row on a host with the
  // RAM for both.
  if (e.pkg) e.exclusive = XL_EXCL;
}

// Longest-first hints for a FRESH artifact dir (#576 A1): a lane worktree
// has no build/test-kernel/summary.json, and without one the pool used to
// run in declaration order — the 700s files landing mid-list left a long
// serial tail. timings.json is a committed snapshot of real full-run
// timings (regenerate: node tests/lib/update-timings.js). Scheduling hint
// ONLY — staleness costs a little makespan, never correctness; a file
// absent from it schedules first (unknown = assumed expensive).
let hints = {};
try { hints = JSON.parse(fs.readFileSync(path.join(__dirname, 'timings.json'), 'utf-8')).files || {}; }
catch (e) { /* missing/unreadable hints -> unknown-first scheduling */ }

// 0082 pre-step: only when the (filtered) run actually contains fixture
// consumers — a --filter=test_tlsf-style quick run never pays a bake here.
if (!opts.list && entries.some(e => e.image && matchesFilter(e.file, opts.filter))) {
  ensurePrebakedImage();
}

// The same pre-step for the MINIMAL (no-packages) blob (#579). Every PKG row
// calls ensureMinimalImage() lazily against one cached path with NO lock, so
// without this the blob is baked INSIDE the pool by whichever row wins the
// race, and two rows admitted together can each run a full mkimage.
//
// 🔴 What this does NOT do: make the XL rows cheaper. That was the original
// rationale and it was WRONG — it rested on a misread figure (a 1.05 GiB
// "warm" number that belonged to a different row). Measured properly, solo
// and serial, with the blob and the mkpkg pool both already warm,
// test_gucman_e2e.js still peaks 4.59-4.88 GiB (build/rss-579-pkgsolo.json,
// 3 runs), against 4.80 with a cold bake. The bake is NOT the dominant cost;
// a full boot plus a second heavy node process beside it is. So XL_GB is
// sized for the row's intrinsic cost, and this hoist is kept for what it
// actually buys: the unlocked double-bake is gone, and a cold tree pays that
// bake once, up front and visibly, instead of inside one arbitrary row.
if (!opts.list && entries.some(e => e.pkg && matchesFilter(e.file, opts.filter))) {
  require('./lib/gucman.js').ensureMinimalImage();
}

runSuite(entries, {
  name: 'kernel suite',
  dir: __dirname,
  artifactDir: path.resolve(__dirname, '../../build/test-kernel'),
  jobs: opts.jobs, timeoutMs: opts.timeoutMs, filter: opts.filter,
  failFast: opts.failFast, resume: opts.resume, list: opts.list,
  repeat: opts.repeat, underLoad: opts.underLoad,
  budgetGb: ramBudgetGb(), defaultGb: HEAVY_GB, hints,
  // The sibling-member contract (#613): children run with cwd = THIS dir
  // (the tree guard in os/boot.js et al. demands a c-compiler cwd), a
  // sibling test finds its own repo via __dirname and this repo via CC_ROOT.
  env: { CC_ROOT },
  // evidence.extra makes the sibling dir part of the EXPECTED set — without
  // it a sibling member that silently never ran would leave the evidence
  // line green (the #314 defect class, one level up).
  evidence: {
    pattern: MEMBER_RE, exclude: EXCLUDED,
    extra: sibling.status === 'ok'
      ? [{ dir: sibling.testsDir, pattern: sibling.pattern, exclude: sibling.exclude, prefix: sibling.prefix }]
      : [],
  },
  // The artifact states whether sibling tests joined or were skipped — a
  // shipper must be able to tell a sibling-less green from a full one.
  summaryExtra: {
    sibling: sibling.status === 'ok'
      ? { repo: sibling.name, status: 'ok', root: sibling.root, via: sibling.via, members: sibling.entries.length }
      : { repo: sibling.name, status: 'absent' },
  },
}).then(r => process.exit(r.failed ? 1 : 0))
  .catch(e => { process.stderr.write(`Fatal: ${e.stack || e.message}\n`); process.exit(2); });
