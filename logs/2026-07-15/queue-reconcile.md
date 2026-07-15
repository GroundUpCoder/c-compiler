# Queue reconciliation — the deferred pile vs what 0160–0181 already shipped

The open queue showed 52 items, all `deferred` (the 2026-07-12 mass-defer),
predating the 0160–0181 wave. Several deferred entries had since been
re-filed under new ids and completed, so "open" was dishonest. This turn
audited all 52 against `todos/done/` and `logs/2026-07-1[2-5]/` and
reconciled. 52 → 44 open (+1 new residue item). No product code changed;
the only code touch is the `queue.js --manual-ux` scaffold's reseed rule.

## Closed as superseded / overtaken (no new work under these ids)

- **0071** (tty transient VEOF) → the identical fix landed as
  `done/0163-tty-veof-transient.md` (2026-07-12): `_eofFlag` one-shot split
  from latched `_hupFlag`, regression in `tests/kernel/test_pty.js`.
- **0053** (curl-over-fetch) → `done/0172-kernel-http.md` (the 0x06xx fetch
  RPC family) + `done/0173-libcurl-veneer.md` (the `<curl/curl.h>` easy
  subset, landed app-side as `os/curl/` rather than in-libc — a better
  shape: upstream ABI values + native-clang differential smoke). The one
  unshipped sliver, the `/bin/curl` CLI tool, is re-filed as **0182**
  (P2/light). NETWORK.md tier 2 marked LANDED.
- **0153** (run the 0146-converted browser sweep once) → overtaken: the
  converted sweep has run repeatedly since — the `done/0170` five-red triage
  (all five legs were stale test asserts, not conversion bugs; a shared
  harness bug would have failed many files at once) and the idle-power
  Stage-4 close-out's full 25/25 sweep (`logs/2026-07-14/idle-power-stage4.md`).

## Consolidated: seven human sweeps → one (0127)

0073 + 0127 + 0128 + 0129 + 0142 + 0143 + 0144 were seven largely-identical
self-reseeding dogfood items — queue noise created by the `--manual-ux`
scaffold's "top up to 3–4 open copies" kickoff rule. Now:

- **0127** is THE manual sweep: rotating checklist (shell/WM, desktop apps,
  games/media, plus 0073's app-BEHAVIOR depth slice), 0073's still-live
  seeded findings carried over (EM_GETHANDLE padding, OFN hooks, MessageBox
  BTNSETS, size grip, the owed notepad-open lock-in test, ctlpanel
  master-only volume; EDIT-undo → 0135, fileman ops → shipped 0092/0106).
- The other six closed pointing at 0127.
- The scaffold rule in `todos/queue.js` changed to **one successor, seeded
  at close** — exactly one open copy at any time. (0148, the test-tightness
  sweep, has the same shape but only one open copy; left alone.)

## Rewritten

- **0126** difficulty spike: was "spike 0117 AND 0119"; 0119 shipped
  outright (`done/0119`, /bin/mgp at v80), so the spike is 0117
  (MicroPython)-only now. File renamed to `0126-difficulty-spike-0117.md`.

## Audit method + non-findings

Every remaining open item's subject was grepped against
`todos/done/016*..018*` and `logs/2026-07-13..15`; all other hits were
incidental (os-paint.mjs legs in sweep logs, the screensaver as an
idle-power wake case). Notably NOT superseded: 0062 (zero-copy present —
distinct from 0160/0169's idle damage-skip), 0052/0054 (sockets — 0172 is
fetch-shaped, not sockets), 0148 (test estate quality — 0175 was the loud
sync gates). The stale `os/os-system.img.tmp-*` artifacts were already
cleaned up before this turn.

## The authoritative remaining order (44 open)

`node todos/queue.js list` is normative; grouped view as of this close:

- **P1 core/features** (1–23): 0079 dep-dedup, 0080 cairo-pdf/svg, 0052
  loopback AF_INET, 0064 WM sweep r3, 0049 wallpaper, 0050 pdpmake, 0054
  relay (blocked by 0052), 0051 halt/reboot, 0145 comdlg32 feedback, 0062
  zero-copy present, 0086 sameboy save states, 0087 GNU-ext triage, 0097
  ss module cache (after 0079), 0109/0110 desktop properties+confirms,
  0126 spike → 0117 micropython, 0122 chibi scheme, 0134/0135 EDIT
  wheel/undo, 0149→0150 keymap+emacs, 0157 icon set.
- **P2** (24–36): 0113 sounds v2, 0116 sysmenu right-click, 0120 overlay
  smoke leg, 0125 host.js IIFE, 0127 THE manual sweep, 0130 default-programs
  applet, 0133 EDIT umbrella (blocked by 0134–0137), 0136→0137 EDIT
  scrollbars→wrap, 0138 ChooseFont, 0148 test-tightness sweep, 0152 clang
  overlay browser boot (after 0064), 0182 /bin/curl CLI (new).
- **P3 background** (37–44): 0115 screensavers, 0121 reproducible bakes,
  0123 fileman auto-refresh, 0124 paint v2, 0131 ctlpanel restyle, 0139
  win32 printing, 0140 mGBA miscompile hunt, 0162 registry-sqlite option.
