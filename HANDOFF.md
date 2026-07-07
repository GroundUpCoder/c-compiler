# Handoff — start of thread (updated 2026-07-07, after WM v1 landed)

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Where the repo stands

**The OS has windows.** 2026-07-07 landed, in one thread: the WM design
(`todos/WM.md`, 0007), the platform spikes (0012), and **WM v1**
(0013) — kernel surface registry + shm/bitmap transports + input rings +
agent channel (kernel.js "WM surfaces"), `createSurfaceSDL` in host.js
(SDL windows become kernel surfaces, app code unchanged), the Canvas2D
compositor in the kernel worker (`os/compositor.js`), the os.html desktop
pane, and `/bin/winbox` seeded (image.json **v9**). `winbox &` in hush
opens a draggable, clickable, closable window — in the browser AND
headless (kernel screenshots, injected input). Dev logs:
`logs/2026-07-07/wm-design.md` + `wm-v1-implementation.md`.

Two host.js changes with blast radius beyond the WM (both verified against
all suites + standalone browser SDL):
- **Exit-ordering fix**: with a main-loop callback registered, the C exit
  path (atexits + the OS EXIT handshake) runs AFTER the frame loop stops.
- **Nested-worker rAF latch**: rAF throws in workers-of-workers; SDL's
  pacer falls back to setTimeout(16) on first failure.

All green at hand-off: unit 697✓ (3 skipped, pre-existing), blockfs✓,
kernel✓ (16 files, incl. test_wm + test_wm_e2e), host✓, browser
os-boots.mjs✓ and os-wm.mjs✓, spikes (wm-spikes.mjs, s3_dawn.mjs)✓.

The repo now has a root **package.json** (first ever): devDeps-only, just
`webgpu` (prebuilt Dawn) for optional headless GPU work; node_modules
gitignored; **nothing in core imports it**. Keep it that way.

## The queue (todos/README.md is authoritative)

1. **`0014` /bin/wm policy client + wmctl** — WM policy out of the kernel
   over an AF_UNIX protocol (design: WM.md "The WM client"); taskbar;
   agent RPC exposure of the existing kernel op set. The v1 kernel-chrome
   default policy stays as the WM-crashed fallback.
2. `0015` windowed vendor apps (doom/snake/gameboy + binary-asset seeding)
3. `0016` SDL+WebGPU demo app + Dawn tier-1 suite
4. `0017` audio mixing (kernel sound server)
5. `0018` quake (relative-mouse/pointer-lock flag + pak0.pak seeding)
6. `0019` client resize (SURFACE_CONFIGURE)
7. `0020` wasm terminal + ptys

(Queue planned 2026-07-07, second thread — items 0015–0020 in todos/ with
rationale; a real-world WebGPU app port is a wanted follow-up after 0016,
unnumbered until scheduled.)

(`0006` threads + atomics stays deferred indefinitely.)

## Gotchas discovered this thread (details in the dev log)

- Kernel→process SABs can't ride postMessage to a PARKED worker — the
  process allocates and posts `{type:'wm-sabs'}` before the RPC (FIFO
  pairing). Reuse this pattern.
- Spike in the REAL topology: page-level-worker results (rAF!) don't
  transfer to nested workers.
- Dawn: `worker.terminate()` with pending Dawn events aborts the whole
  Node process — Dawn-tier processes must exit gracefully (WM.md caveat).

## Conventions to keep (bite-sized reminders)

- Queue discipline: work = `todos/NNNN`, done → `todos/done/`, dev log per
  landing, README next-up current.
- Seeded OS sources changed? **Bump `os/image.json` `version`** (v9 now).
- compiler.js must stay browser-clean (no bare `process.*`).
- WM layout constants (SH_*/IR_*/WM_*) are duplicated kernel.js ↔ host.js
  with MUST-MATCH comments (the SI_* precedent) — change both or tests
  will tell you.
- `tests/browser/os-wm.mjs` + `os-boots.mjs` are manual — run after
  touching os/, kernel.js, host.js SDL/fd paths.
- Don't re-litigate: posix_spawn-not-fork, kernel-owned fds, WM.md's
  invariants (no GPU virtualization, no software rasterizer, one app
  interface, kernel pixel authority, present-is-not-an-RPC).

## Suggested opening for the new thread

"Read HANDOFF.md, then give me a one-paragraph status and ask what I want
to tackle: 0014 (/bin/wm + wmctl), a lingering item, or something else."
