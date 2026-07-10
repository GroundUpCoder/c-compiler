#!/usr/bin/env node
'use strict';
// Runs the kernel (process control plane) test suite. See todos/KERNEL.md.
//   node tests/kernel/run.js
var { spawnSync } = require('child_process');
var path = require('path');

var tests = [
  ['test_kernel.js', []],       // process-table semantics over the real SAB protocol
  ['test_e2e.js', []],          // real C programs in worker_threads via nodeCreateWorker
  ['test_signals_e2e.js', []],  // Phase 2: async delivery, EINTR/SA_RESTART, pause, exit handshake
  ['test_itimer_e2e.js', []],   // 0044: alarm/setitimer(ITIMER_REAL) -> SIGALRM — EINTR on blocked read, interval reload, DFL terminate
  ['test_tty.js', []],          // Phase 3: line discipline semantics (kernel-side, no wasm)
  ['test_tty_e2e.js', []],      // Phase 3: real C driven by a scripted UI bridge
  ['test_fs_e2e.js', []],       // 0009: brokered fs — shared offsets, fd_actions, SIGKILL+fsck, winsize
  ['test_mounts.js', []],       // 0026: MountFS — prefix routing, EXDEV/EBUSY, symlink escapes (no wasm)
  ['test_module_cache.js', []], // 0037: compiled-Module cache on spawn — RO-volume policy, ss/rw exclusions, real clone e2e
  ['test_procfs.js', []],       // 0043: synthetic /proc — Linux formats, snapshot-at-open, zombies, EROFS, GETSID (no wasm)
  ['test_pipes.js', []],        // Phase 4: pipe OFD semantics over the SAB protocol (no wasm)
  ['test_pipes_e2e.js', []],    // Phase 4: real C pipelines — blocking wake, EOF, SIGPIPE death
  ['test_pty.js', []],          // 0020: pty pair semantics over the SAB protocol (no wasm)
  ['test_pty_e2e.js', []],      // 0020: real C over a pty — openpty, spawn-on-slave, winsize, SIGHUP
  ['test_sockets.js', []],      // 0008: AF_UNIX OFD semantics over the SAB protocol (no wasm)
  ['test_sockets_e2e.js', []],  // 0008: real C client/server — accept/connect/send/recv, poll
  ['test_jobctl_e2e.js', []],   // Phase 4: real C stop/cont — WUNTRACED/WCONTINUED, output halts
  ['test_jobctl_tty_e2e.js', []], // interactive Ctrl-Z/fg/bg/kill %1 through hush + the kernel tty
  ['test_os_boot.js', []],      // 0004: headless OS boot — seed, protoshell, cc, persistence
  ['test_vi_e2e.js', []],       // 0011: busybox vi through the real tty — raw mode, edit sessions
  ['test_repl_pty_e2e.js', []], // 0036: lua/micropython/sqlite3 interactive on a kernel pty — prompt, eval, LD erase, ^D exit
  ['test_wm.js', []],           // WM.md: surface registry, input routing, chrome, screenshots (no wasm)
  ['test_wm_e2e.js', []],       // WM.md: real C SDL app windowed — shm present, ring input, QUIT
  ['test_audio.js', []],        // 0017: the kernel mixer — exact-value mixes, resample, lifecycle (no wasm)
  ['test_audio_e2e.js', []],    // 0017: real C SDL audio streams — AUDIO_OPEN handshake, mix, SIGKILL drain
  ['test_wm_policy.js', []],    // 0014: the WM protocol over the kernel-owned /run/wm.sock (no wasm)
  ['test_wm_service_e2e.js', []], // 0014: real /bin/wm + wmctl through os/boot.js — autostart, taskbar, crash+respawn
  ['test_os_apps_e2e.js', []],  // 0015: seeded vendor apps windowed in-OS — bin-entry game data, real frames via wmctl shot
  ['test_gdi32_e2e.js', []],    // 0057: win32 gdi32 — in-OS selftest (GDI semantics + leak check), windowed scene probed via wmctl shot, bit-exact repaints
  ['test_user32_e2e.js', []],   // 0058: win32 user32 — blocking GetMessage loop, lifecycle order, controls, MessageBox modal, wmctl tree/click-by-label agent path
  ['test_kernel32_e2e.js', []], // 0059: win32 kernel32/advapi32/wide-CRT — in-OS selftest, POSIX-twin identity, registry persistence across boots
  ['test_win32_ports.js', []],  // 0060: port corpus compile-check — controls still link clean, PORTS.md (the 0059+ backlog) current
  ['test_winmine_e2e.js', []],  // 0068: winmine playable — sidecar resources, menu bar/popups, SURFACE_RESIZE, dialogs from templates, WM_TIMER, registry persistence
  ['test_term_e2e.js', []],     // 0020: /bin/term — hush on a pty in a window, vi inside, resize reflow, shot pixels
  ['test_gpubox_dawn_e2e.js', []], // 0016 tier 1: gpubox (webgpu.h) under Dawn — readback->shm shots, tolerance-diff; SKIPs without the webgpu pkg
];

var failures = 0;
for (var [file, args] of tests) {
  console.log('\n===== ' + file + (args.length ? ' ' + args.join(' ') : '') + ' =====');
  var r = spawnSync(process.execPath, [path.join(__dirname, file)].concat(args), { stdio: 'inherit' });
  if (r.status !== 0) failures++;
}
console.log('\n========================================');
console.log(failures ? failures + ' kernel test file(s) FAILED' : 'All kernel tests passed');
process.exit(failures ? 1 : 0);
