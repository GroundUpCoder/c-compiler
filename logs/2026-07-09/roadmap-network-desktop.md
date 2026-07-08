# Roadmap session: networking tiers + the desktop wave (0043–0054)

A planning discussion against the north star ("as close to POSIX as the
platform allows, as Windows-95 as possible") produced 12 new queue items
+ `todos/NETWORK.md`. The *why* behind the non-obvious calls:

## Networking (NETWORK.md is the design record)

- The web platform has no raw TCP/UDP; everything builds from fetch /
  WebSocket / WebTransport / WebRTC. Direct Sockets is IWA-only —
  ignored.
- **Four independent tiers**, ordered by value/effort: loopback AF_INET
  in-kernel (0052, no web constraint at all), curl-easy facade over a
  kernel fetch RPC (0053 — POSIX has no HTTP API; libcurl's easy
  interface is the de-facto standard header, and since we own the libc
  we implement it natively instead of porting libcurl), getaddrinfo via
  DoH (tier 3, folds in later), and a pluggable websockify relay (0054).
- **The localhost relay survives public hosting**: `ws://localhost` from
  an https page is allowed (trustworthy-origin carve-out; Chrome/Firefox
  yes, Safari holdout), WS isn't CORS-gated, PNA preflight headers are
  ours to send since we ship the relay. Server-side wss relay =
  open-proxy abuse surface → NOT the default; transport stays pluggable
  (the Dawn-tier pattern).

## Kernel POSIX batch

- **0043 procfs**: synthetic MountFS volume (routing is prefix-based and
  doesn't care what's behind a prefix), Linux-compatible file formats so
  busybox ps/top/pgrep parse unmodified; per-process CPU time reports
  zeros (workers run on their own threads — nothing tracks it).
- **0044 timers**: ITIMER_REAL only; VIRTUAL/PROF → EINVAL (no CPU
  accounting). Delivery rides the settled cooperative signal path.
- **0045 two-tab guard**: two tabs today = two KERNELS over one OPFS
  store (dual-instance BlockFS coherence doesn't cover two process
  tables/compositors). Web Locks mutex now; "seats v2" (extra tabs as
  clone-transport remote seats) sketched in the item — possible because
  os.html is already a dumb postMessage bridge, constrained because SABs
  don't cross agent clusters and SyncAccessHandle is
  dedicated-worker-only.
- **0046 strace**: the kernel already brokers every syscall — a per-pcb
  flag + a trace pipe + a decode table is nearly free and serves the
  agent-friendly pillar.

## Desktop wave

- **Toolkit trade study**: microui (~1.1k lines, renderer-agnostic
  command list → our SDL surface + freetype; reskinning = editing a tiny
  draw layer we own) over nuklear (much richer — menus, styling,
  multi-line edit — and much bigger). Decision: **microui first**
  (0047); nuklear stays the recorded trade-up if 0048's file
  manager/notepad outgrow it. Same immediate-mode model either way, so
  app code migrates.
- **0048 apps**: fileman, notepad, calc, minesweeper, control panel.
  Control panel pulls a small kernel addition (mixer gain op — 0017's
  mixer has no volume control today).
- **0049 wallpaper**: `/etc/wallpaper/` + `current` symlink
  (first-existing-dir pattern like /etc/menu); GIF = first-frame-only
  (animation would re-damage the fullscreen desktop layer at gif
  framerate — standing composite burn, deferred); no `current` = solid
  teal so existing pixel asserts hold.
- **git**: real git.git is possible (NO_PTHREADS, compat/mmap.c,
  spawn-shaped subprocesses) but heavy; the pragmatic path is a
  `/bin/git` porcelain over the already-vendored libgit2, with
  clone/fetch/push later via libgit2 custom transport over 0053's curl
  facade. Left unnumbered until the porcelain gets scheduled.
- **0050 pdpmake**: POSIX make built to pair with busybox; depends on
  0035's exec seam. busybox diff/patch ride the same item as a 0034-style
  applet batch.

## Queue mechanics

Next-up order updated in `todos/README.md`: 0045 jumped to #2
(correctness); the existing 0035/0036/0037/WebGPU/0041/0042 order was
preserved; new items grouped behind them (kernel-POSIX batch →
networking → desktop wave → tail). OS.md Phase 4 + open questions now
point at NETWORK.md and the 0045 seats sketch.
