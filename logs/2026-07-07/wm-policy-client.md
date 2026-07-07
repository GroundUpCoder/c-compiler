# 0014 — /bin/wm policy client + wmctl (WM policy leaves the kernel)

Second thread of the day: WM v1 (0013) landed this morning with a
deliberate deviation — all window-management policy lived in the kernel as
"kernel-chrome". 0014 moves policy where the design wants it: an ordinary
wasm process, talking a framed protocol over AF_UNIX. This log records the
decisions and the two genuinely new mechanisms.

## The kernel as a socket peer (the missing primitive)

0008's sockets were strictly process↔process; the design said "a
kernel-owned endpoint" and nothing provided one. Options considered:

1. A synthetic PCB owning a listener OFD — mirrors the process model, but
   invents a fake process (fake pid, fake fd table) just to hold a queue.
2. A kernel-side peer seam — connect() resolves against a kernel registry
   first; the kernel holds the server half of the crossed pipe pair
   natively.

Went with (2): `sockServe(path, onConnect)`. It cost exactly one hook —
`_pipeNotify` drains a direction to a callback when `dir.drain` is set
(the kernel never parks a read, so waiters can't exist on that side) plus
a once-only EOF signal. Everything else — client blocking, select
readiness, EOF/EPIPE, close bookkeeping — is the unchanged pipe machinery.
`peer.send()` deliberately ignores the 64KB direction cap: kernel replies
include megabyte screenshots, the peers are trusted system software
(wm/wmctl), and a slow reader costs memory, not correctness.

`Kernel.service()` came out of the same work: the wm autostart needs a
parentless process, and a parentless non-init process would zombie forever
(nobody waits on ppid 0). One-line fix in `_exitProcess`: auto-reap ppid-0
exits.

## One protocol, not two surfaces

The item text implied two things: a WM socket protocol AND "agent RPC
exposure" for wmctl. Landed as ONE: the socket protocol carries the whole
agent op set (LIST/INJECT_*/SHOT included), and wmctl is just another
client that doesn't subscribe. Zero new 0x1xxx opcodes; "one op set,
defined once, exposed twice" (WM.md) held literally — outside agents call
the kernel-JS methods, inside agents run wmctl. Dogfoods 0008 harder too:
the protocol exercised partial frames, coalesced frames, parked reads
woken by pushes, and >PIPE_CAP replies, all through the standard fd layer.

Framing is length-prefixed little-endian with a fixed 72-byte window
record — wasm is LE, so the C client reads raw structs (`wmp_rec`), no
marshalling. Client discipline worth remembering: an action's event echo
(EV_MOVED from a MOVE) is emitted DURING the action, so it lands on a
subscribed connection BEFORE the R_OK — clients queue events aside while
awaiting replies (wmp_next_reply / the test's readReply).

## Borderless surfaces must not steal focus (found by the browser test)

The taskbar is a borderless (flags bit0) SDL shm surface — the WM is its
own client, no special casing. First browser run exposed a real design
bug: kernel click-to-focus fired for the taskbar itself, so clicking a
button moved focus to the taskbar *before* the wm processed the click —
the "minimize the focused window" toggle could never see the window as
focused. Fix (decision): borderless surfaces receive clicks but never
take focus via the kernel default; they get focus only through the WM
protocol. Win95 agrees. This is exactly the class of thing the headless
tests couldn't catch (they inject post-hit-test) and the pixel-asserting
browser test exists for.

## The missing-sleep detour (self-inflicted, documented as a warning)

An hour of "the wm's frame loop stops processing events" turned out to be:
`sleep` was not a coreutils applet, every `sleep 1` in my boot-driving
test scripts failed instantly (stderr discarded), hush hit EOF, pid 1
exited, and the kernel halted the system before background processes
finished instantiating (~300ms for an SDL binary). The wm was correct the
whole time. Morals: (a) don't discard stderr while debugging; (b) a
missing applet fails a script silently at 127. `sleep` is now applet #29
(hand-rolled in port/multicall_main.c — upstream sleep.c wasn't vendored;
fractional seconds supported).

## Also in this landing

- `entry.hdrs` in image.json: local headers staged beside the seeded
  source (quoted includes resolve relative to the including file), so
  wm.c/wmctl.c share wm_proto.h at seed time. image.json → v10.
- SDL_WINDOW_BORDERLESS defined in the SDL header, mapped through both
  createSurfaceSDL flavors to surface flags bit0.
- SUBSCRIBE's R_OK carries the screen dims (the taskbar needs them;
  nothing else provided them). EV_MINIMIZED both ways so subscribers can
  track wmctl-initiated minimize.
- Minimize/restore semantics: minimized surfaces leave hit-test and both
  composites; focus falls to the top non-minimized; focus restores.
- Taskbar text: baked 5×7 HD44780-style font in wm.c (A–Z 0–9 - .),
  uppercased labels. No freetype dependency for a taskbar.

## Verification

- `test_wm_policy.js` (kernel suite): 53 checks, scripted client over the
  real SAB protocol — framing splits/coalescing, snapshot, every command,
  parked-read wake, 1.2MB R_SHOT, crash fallback + respawn, service reap.
- `test_wm_service_e2e.js` (kernel suite): the real seeded binaries over
  os/boot.js — autostart, placement, taskbar-click restore via injection,
  kill → fallback → respawn, PPM screenshot.
- `tests/browser/os-wm.mjs` extended: taskbar strip pixels, borderless (no
  chrome band), WM placement, button sunken-state, click minimize/restore,
  button removal on close, wmctl from the in-browser shell. PASS, plus
  os-boots.mjs.
- Full sweep green: unit 697, kernel 18 files, blockfs, host.

Refs: todos/0014 (→ done/), todos/WM.md "Implementation status — the WM
client", todos/KERNEL.md "Kernel-owned endpoints".
