# 0045 — two-tab boot guard (Web Locks)

- **Status**: open
- **Depends**: —
- **Design**: discussion in `logs/2026-07-09/roadmap-network-desktop.md`

## Goal

Correctness: today two browser tabs would run two kernels over the same
OPFS images. BlockFS survived dual-*instance* fuzzing, but two kernels
(two process tables, two compositors, two fd brokers) over one store is
undefined. Second tab must get a clean "already running" screen.

## Plan

- `navigator.locks.request(<lock name>, {ifAvailable: true})` in the
  boot path BEFORE mounting OPFS; hold for the tab's lifetime. Name the
  lock after the image pair (the v5 names) so unrelated dev pages don't
  collide.
- On failure: plain message + retry button (the lock frees when the
  other tab closes). No steal option in v1.
- Headless is out of scope (two `node os/boot.js` over one file-backed
  store — a flock-style guard is a possible follow-up; note only).
- **Non-goal, recorded for later ("seats v2")**: extra tabs as remote
  seats. Genuinely possible — os.html is already a dumb postMessage
  bridge (tty bytes, input events, ImageBitmap frames) — but SABs don't
  cross agent clusters, so seat tabs would run clone-based transports;
  a SharedWorker kernel is blocked by `createSyncAccessHandle` being
  dedicated-worker-only. Design-doc material if ever scheduled.

## Acceptance

- Two tabs: first boots, second shows the guard message; closing the
  first lets the second boot via retry. Manual check + an
  `os-boots.mjs` leg if a second page context in the same browser can
  automate it.
- Single-tab boot behavior unchanged (browser + headless suites green).
