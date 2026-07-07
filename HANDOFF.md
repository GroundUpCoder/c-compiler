# Handoff — start of thread (updated 2026-07-07, after 0014 /bin/wm landed)

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Where the repo stands

**The OS has a real window manager.** Two threads on 2026-07-07: the first
landed WM v1 (0013 — kernel surfaces, compositor, `createSurfaceSDL`,
winbox). The second planned the queue through 0020 and landed **0014**:
WM policy is out of the kernel — `/bin/wm` (placement, taskbar with baked
font, minimize toggle) and `/bin/wmctl` (xdotool-as-a-syscall) speak a
framed protocol over the **kernel-owned AF_UNIX endpoint** `/run/wm.sock`
(`sockServe` — the kernel as a native socket peer; KERNEL.md "Kernel-owned
endpoints"). wm autostarts via `Kernel.service()` (parentless, auto-reaped);
killing it falls back to kernel-chrome and `wm &` respawns. image.json is
**v10** (adds /bin/wm, /bin/wmctl, /bin/sleep, /run). Dev log:
`logs/2026-07-07/wm-policy-client.md`.

Decisions made in 0014 (don't re-litigate): wmctl rides the SAME socket
protocol — zero new RPC opcodes; borderless surfaces (taskbar-class,
SDL_WINDOW_BORDERLESS → flags bit0) never take kernel click-to-focus;
kernel-side `peer.send()` ignores the pipe cap (trusted system peers).

All green at hand-off: unit 697✓ (3 pre-existing skips), kernel 18 files✓
(new: test_wm_policy 53 checks, test_wm_service_e2e), blockfs✓, host✓,
browser os-boots.mjs✓ + os-wm.mjs✓ (extended: taskbar pixels, minimize/
restore toggle, wmctl from the in-browser shell).

## The queue (todos/README.md is authoritative)

1. **`0015` windowed vendor apps** — doom/snake/gameboy in-OS. The real
   work is a binary-asset image.json entry type (doom1.wad ~4MB, gameboy
   ROMs → BlockFS at seed time); binaries seed via the existing `project`
   entries. Quake split to 0018 (needs relative-mouse). Audio stays
   gracefully silent until 0017.
2. `0016` SDL+WebGPU demo app + Dawn tier-1 suite
3. `0017` audio mixing (kernel sound server)
4. `0018` quake — relative-mouse/pointer-lock flag + pak0.pak seeding
5. `0019` client resize (SURFACE_CONFIGURE)
6. `0020` wasm terminal + ptys

(`0006` threads + atomics stays deferred indefinitely. A real-world WebGPU
app port is a wanted follow-up after 0016, unnumbered.)

## Gotchas from this thread (details in the dev log)

- **`sleep` was missing from the OS until now** — boot-driving test
  scripts with `sleep` silently no-oped (127) and EOF-halted the system
  before background wasm processes finished instantiating (~300ms for an
  SDL binary). It's applet #29 now. Don't discard stderr while debugging.
- WM protocol clients: an action's event echo arrives BEFORE the R_OK on a
  subscribed connection — queue events aside while awaiting replies
  (`wmp_next_reply` / test readReply pattern).
- image.json `c` entries take `hdrs:` for local quoted includes (staged
  beside the source at seed time).

## Conventions to keep (bite-sized reminders)

- Queue discipline: work = `todos/NNNN`, done → `todos/done/`, dev log per
  landing, README next-up current.
- Seeded OS sources changed? **Bump `os/image.json` `version`** (v10 now).
- compiler.js must stay browser-clean (no bare `process.*`).
- MUST-MATCH constant blocks now come in THREE places for the WM protocol:
  kernel.js (WMP block) ↔ os/wm_proto.h ↔ tests/kernel/test_wm_policy.js —
  change all or the tests will tell you. (SH_*/IR_*/WM_* stay duplicated
  kernel.js ↔ host.js as before.)
- `tests/browser/os-wm.mjs` + `os-boots.mjs` are manual — run after
  touching os/, kernel.js, host.js SDL/fd paths.
- Don't re-litigate: posix_spawn-not-fork, kernel-owned fds, WM.md's
  invariants (no GPU virtualization, no software rasterizer, one app
  interface, kernel pixel authority, present-is-not-an-RPC), 0014's
  decisions above.

## Suggested opening for the new thread

"Read HANDOFF.md, then give me a one-paragraph status and ask what I want
to tackle: 0015 (windowed DOOM), a lingering item, or something else."
