# Handoff — start of thread (updated 2026-07-07, after the WM design landed)

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Where the repo stands

2026-07-07 was a big day: 0008 AF_UNIX sockets + jobctl tty e2e, the
lingering-items sweep, the SAB ring fixes (see the day's `logs/2026-07-07/`
entries), and finally **the 0007 WM/compositor design doc — `todos/WM.md`**
(dev log: `logs/2026-07-07/wm-design.md`). Read WM.md before touching
anything WM-shaped; the short version:

- Apps see ONE interface (SDL3/`webgpu.h`); rendering is direct WebGPU on
  each process worker's own device (no GPU virtualization — the browser's
  GPU process already multiplexes).
- Two orthogonal axes: rendering **backend** (browser WebGPU / Dawn under
  Node via the `webgpu` npm pkg / null) × present **transport** (GPU bitmap
  handoff / shm SAB / reserved `direct` DOM-canvas). No software rasterizer,
  ever. No browser readback path.
- Kernel-worker compositing on a master OffscreenCanvas; kernel pixel
  authority (headless screenshots as kernel ops); WM is a wasm client over
  AF_UNIX; kernel-chrome decorations v1; no client resize v1; xterm.js as
  privileged DOM surface v1.
- Measured kernel overhead recorded in WM.md (~10µs/RPC, system-wide
  single-threaded ceiling) — it's why presents/input ride SABs, never RPCs.

All suites green as of the last landing: unit 700✓, blockfs✓, kernel✓,
host✓, browser os-boots.mjs✓ (design-doc-only changes since).

## The queue (todos/README.md is authoritative)

1. **`0012` WM platform spikes (S1–S5)** — throwaway harnesses verifying
   WM.md's platform assumptions. **S1 (transferToImageBitmap GPU-backedness)
   gates the `gpu` transport** — do it first. Results get written back into
   WM.md's spike appendix as verdicts.

After 0012: implementation units 2–7 in WM.md's plan get numbered as they
start (kernel surface registry → compositor → SDL retarget → agent
channel/wmctl → /bin/wm → windowed vendor apps acceptance).

(`0006` threads + atomics stays deferred indefinitely.)

## Lingering small items (none blocking; carried over)

- `tools/mkimage.js` (pre-baked image) if browser seeding time ever matters.
- Bare `$(trap)` doesn't report parent traps (vendor README).
- `tests/browser/os-boots.mjs` is manual — run after touching os/,
  kernel.js, host.js fd/fs paths, or the busybox port.
- `FEATURE_VI_REGEX_SEARCH` is HARD (GNU regex API absent from musl regex);
  details in the 2026-07-07 handoff history / vendor README.
- AF_INET / fetch()-HTTP are future Phase 4 items (need a relay design).

## Conventions to keep (bite-sized reminders)

- Queue discipline: work = `todos/NNNN`, done → `todos/done/`, dev log per
  landing, README next-up current.
- Conformance bugs: failing test first, commit, then fix — and prove the
  test fails pre-fix.
- Seeded OS sources changed? **Bump `os/image.json` `version`** (v8 now).
- compiler.js must stay browser-clean (no bare `process.*`).
- The repo has NO package.json yet — the planned `webgpu` (Dawn)
  devDependency lands with the tier-1 headless GPU suite, devDeps-only,
  node_modules gitignored, nothing in core may import it (WM.md "Headless
  testing tiers").
- Don't re-litigate: posix_spawn-not-fork, hush-not-ash, kernel-owned fds,
  connect-never-blocks, and now WM.md's invariants (no GPU virtualization,
  no software rasterizer, one app interface, kernel pixel authority
  default).

## Suggested opening for the new thread

"Read HANDOFF.md, then give me a one-paragraph status and ask what I want
to tackle: 0012 WM spikes, a lingering item, or something else."
