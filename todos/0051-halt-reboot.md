# 0051 — halt / reboot

- **Status**: open (low priority)
- **Design**: discussion in `logs/2026-07-09/roadmap-network-desktop.md`

## Goal

Clean shutdown and in-OS reboot — the upgrade flow's missing verb
(0040 made upgrades "swap the blob"; `reboot` makes that a command
instead of "refresh the page"). Also defines pid-1-exit semantics,
which are currently unspecified.

## Plan

- `/bin/halt` + `/bin/reboot` → one kernel RPC: SIGTERM sweep with a
  short grace, sync the stores, then an embedder hook —
  headless: `process.exit(0)` (reboot: re-boot in-process or exit with
  a distinguishing code, decide at implementation); browser:
  kernel-worker posts `halted`/`reboot` to os.html → a "halted" screen
  or worker re-creation.
- pid 1 exiting gets defined behavior at the same time (treat as halt).

## Acceptance

- Headless: a scripted `reboot` boots twice in one invocation (marker
  in /tmp gone after reboot, marker in /root persists); `halt` exits 0
  with stores synced (fsck clean on the images afterward).
- Browser: manual — reboot from the shell lands back at a fresh VT1
  prompt without a page reload.
