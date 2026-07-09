# 2026-07-09 — Win32 as the primary UI toolkit

Continuation of the toolkit design arc (`roadmap-network-desktop.md` →
`webgpu-mvu-direction.md`). The user locked **agent-drivability as a HARD
requirement**, which decides the toolkit:

- **Immediate mode (microui/Clay) is out** — no persistent tree to query,
  so no accessibility / agent-drive without pixel injection.
- **Elm/MVU (0056) is dropped as primary** — genuinely viable in C, but
  Win32 gives the same closure-free message-switch shape (`WndProc` =
  `update(state, msg)`) AND a queryable HWND tree AND source portability
  AND a real OSS corpus.
- **Win32 is the primary toolkit**: user32 windowing + gdi32 drawing + a
  kernel32 subset, app-side over the surface protocol + POSIX kernel.
  Design doc: `WIN32.md`.

## Key resolutions this session

- **0047 (microui) and 0056 (MVU) superseded / dropped.** The one microui
  deliverable that carries over is the shared freetype text-draw helper
  (gdi32's `TextOut` reuses it); the rest is retired. `TOOLKIT.md` rewritten
  to point at `WIN32.md`. `0048` reframed — the Win95 organ set arrives as
  real ReactOS C ports (0060), not hand-written widgets.
- **"Fully GPU" clarified.** GDI is a CPU rasterizer; CPU-draw → shm →
  GPU-composite (0055) *is* the DWM model — not a fallback, and there is no
  "GPU GDI". "Fully GPU" applies only to `webgpu.h` apps (already GPU) and
  new 2D apps on the Cairo track. **No zombie**: gdi32-CPU and GPU-2D serve
  different corpora.
- **Drawing API for new apps = Cairo (0061)**, not an invented Direct2D
  analog — pure C, real corpus, image backend = shm for free, GPU backend
  optional. (Direct2D/DirectWrite are C++/COM; a toolkit-backing subset
  would be NanoVG-scale, but Cairo's corpus wins.)
- **kernel32 over POSIX is additive** (Wine/Cygwin model), no kernel
  change; frictions = UTF-16, registry-as-file-store; threads OUT.
- **Threads (0006) dropped from the queue entirely** per user — clutter;
  deferred indefinitely, note only (README + `threads-atomics-deferral.md`);
  the todo file removed.
- **Priority**: the Win32 batch (0057–0060) + drawing/compositor track
  (0061–0063) jumps to #1 in *Next up*, ahead of gcstr/wc/strace/
  networking/the old desktop wave.
- **Corpus**: raw-C Win32/GDI only (MFC/Qt/wx/.NET out). Primary source
  ReactOS applets; Petzold samples set bring-up order; first wave
  winmine/sol/notepad/calc → metapad → PuTTY (the milestone).

## New / changed files

New: `WIN32.md`, `0057`–`0063`, this log. Changed: `TOOLKIT.md` (redirect),
`0047`/`0056` (dropped status), `0048` (reframed to Win32 ports),
`README.md` (*Next up* re-sequenced, doc map, threads note); `0006` removed.
