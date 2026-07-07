# 0014 — /bin/wm policy client + wmctl

- **Status**: done (2026-07-07; dev log `logs/2026-07-07/wm-policy-client.md`)
- **Depends**: 0013 (WM v1 — kernel surfaces, compositor, default policy)
- **Design**: `todos/WM.md` ("The WM client", "Agent control channel";
  protocol carrier decision: AF_UNIX socket to a kernel-owned endpoint —
  dogfoods todos/0008)

All acceptance criteria met — see WM.md "Implementation status — the WM
client" and KERNEL.md "Kernel-owned endpoints". Notable deltas from the
plan below: wmctl rides the SAME socket protocol instead of new RPC
opcodes (one op set, zero new opcodes), and borderless surfaces
deliberately don't take kernel click-to-focus (the taskbar minimize
toggle needs the focus state it acts on).

## Goal

Move window-management POLICY out of the kernel into a wasm client, per
the design's staging (the v1 kernel-chrome/default policy becomes the
WM-crashed fallback):

- Kernel-owned AF_UNIX endpoint (e.g. `/run/wm.sock`): framed protocol —
  events (surface created/destroyed/title/focus) out, commands
  (move/restack/focus/minimize/request-close) in.
- `/bin/wm` (seeded): placement policy, taskbar as an ordinary shm
  surface, drag policy; Win95 look grows here (frame surfaces are v2).
- `wmctl` binary + agent RPC exposure of the existing kernel op set
  (wmList/focus/inject/screenshot) so in-OS agents get
  xdotool-as-a-syscall.

## Acceptance

- WM client connects at boot, receives the scene, places new windows;
  killing it leaves the system usable (fallback policy) and it can be
  respawned.
- `wmctl list` / `wmctl focus` / `wmctl shot` work from hush.
- Existing tests stay green; new kernel test drives the socket protocol
  with a scripted client.
