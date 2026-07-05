# Recording the repo's north star: a wasm-native browser OS

Until today the repo's docs described the compiler and its auxiliary pieces but
never said what they're all *for*. The owner articulated the medium-term goal:
a full-fledged, almost-POSIX environment with GUI + window manager that is
WebAssembly **native** (every binary a real wasm module from this compiler, not
an emulation of another machine), feeling like a complete OS in a browser tab,
with persistence.

Landed `todos/OS.md` capturing:

- The north star and non-goals (not an emulator, not a Linux ABI — we own the
  libc and patch ports at source).
- **The fork/exec decision, recorded as settled**: `posix_spawn` (the
  owner-brokered model already implemented in host.js/spawn.h) is the process
  primitive; `fork` stays a failing stub. Rationale leans on precedent — WSL1
  (fork via NT pico-process COW: worked, was the slow painful part), WSL2
  (Microsoft's verdict: stop translating, ship the real kernel — an exit we
  reject by design), Cygwin (copy-the-address-space fork: slow, fragile),
  WASIX (fork via linear-memory snapshot + asyncify: possible but expensive).
  Escape hatches noted (fork+exec idiom lowering; snapshot-fork) but per-port
  patching is expected to stay cheaper.
- A phased roadmap with an explicit sequencing principle: **shell before
  window manager** — the shell forces signals/termios/job-control/spawn
  composition to become real, and libc already reserves `/bin/sh`
  (`popen`/`system`/`_PATH_BSHELL` all point at it, with "once /bin/sh exists"
  comments). Then threads/atomics, then compositor+WM (Wayland-shaped: host
  composites per-process surfaces; WM is a client; existing SDL vendor apps
  become windowed apps for free), then networking (AF_UNIX first).

Also added a north-star paragraph at the top of `CLAUDE.md` pointing at the
doc, so future sessions don't have to rediscover the direction (or re-litigate
fork).

State-of-the-union at time of writing: compiler ~85–90% for this goal
(694/694 tests; sqlite/doom/quake/lua/micropython/libgit2 build; tinyemu boots
Linux), persistence done (BlockFS + fsck + fuzzer), spawn model done, SDL3/
WebGPU well along; missing entirely: shell, signals/termios backing, threads,
WM, sockets.
