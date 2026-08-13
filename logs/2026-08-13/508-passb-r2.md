# #508 Pass B round 2 — dogfood-via-agent (gcode builds the game), 2026-08-13/14

Lane `lane/508-passb-r2` @ base e704f078. Report-and-file pass: **no production code
written by this lane; gcode wrote all game code.** Findings filed as #668–#677; round 3
is #678, hard-blocked on all ten (verified by re-read: blockedBy=10, derived.ready=false).
Evidence: `s3://groundupcoder/gucos/508-passb-r2/2026-08-13/` (74 objects).

## Instrument

`passb/driver.mjs`: spawns `node os/boot.js --image=build/passb/os-system.img --tty-out
--wait-lock=900` and drives the tty from a JSON step list (send / waitFor-regex / sleep),
like a human at the keyboard. The DeepSeek key is read by the driver process and scrubbed
from every logged byte — after an early leak (tty echo split across stdout chunks defeated
per-chunk scrubbing), the scrubber became wrap-tolerant-regex + holdback-window; the three
leaked logs were scrubbed on disk and the key flagged to jku for rotation. Warm boots are
~0.4 s, so one boot per driver run with `gcode -c` carrying the session is free (the #488
pattern). Files are pulled out of the root image with `passb/extract.mjs` (BlockFS walk).

## What gcode built (deepseek-v4-flash, interactive REPL, 7 turns, 235 API rounds)

A complete 865-line SDL3 Asteroids in `/root/asteroids`: rotation/thrust/momentum/wrap,
asteroid splitting (20/50/100 scoring), lives/respawn/invulnerability, game over/restart,
HUD, title screen with a 24-cell sprite-sheet spinning ship, three synthesized sound
effects pushed through SDL audio streams. It compiled via `cc`, launched windowed,
play-tested itself via `wmctl` key injection + screenshot analyzers it wrote on the spot
(libpng cluster/centroid tools), proved animation by frame-diff, proved sounds by
waveform-dumping its own synthesis, and diagnosed a user-reported rendering bug to a
one-line fix with a before/after comparator. Turn shape: build turn 301 s / 34 rounds;
play-test 373 s / 38 rounds; audio+title 540 s+ / 50 rounds; focused bug fix 381 s / 15.

## The two headline findings

- **#668 (P0)**: the software SDL tier draws RenderLine diagonals as filled bboxes and
  RenderGeometry as a silent success no-op (host.js:7986-7992; comment at 7806 knows —
  "a noted follow-up" — but no ticket, no LIABILITIES entry, no doc caveat). gcode hit it
  in its first game, called it "a broken line renderer", and Bresenham'd everything
  through RenderPoints. Browser tier is correct, so output diverges between tiers.
- **#670 (P2)**: gcode's self-verification passed MIRRORED HUD/title text as "confirmed"
  — pixel statistics are mirror-blind and its ground-truth comparator initially shared
  the renderer's bit-order bug. A human eyeball caught it in one glance. The agent has no
  way to see pixels; that is the gcode arm's verify-loop ceiling today.

## REPL nulls worth keeping (all solid)

^C mid-turn (mid-API and mid-tool) interrupts cleanly and the session resumes with
nothing lost (even after a SIGKILLed boot: 132 messages resumed); ^C at prompt
re-prompts; up-arrow history recall works; auto-compact fired mid-turn twice (85%
threshold; 108 and 71 messages folded) and the turns continued coherently; manual
/compact works; a post-compact one-liner turn answered in 2.3 s. #503/#504 fixes held.

## Gotchas for the next round

- Driver step timeouts must exceed 480 s for feature turns, and the first waitFor must
  tolerate heavy-lock waits (a sibling lane's gate held the lock 54-195 s; `--wait-lock`
  queued politely as designed).
- `python - <<EOF` works in-OS; the s1 "ImportError" was the agent's own script importing
  a module MicroPython lacks. Positive-control before filing.
- `wmctl key` without an explicit KEYSYM injects keysym 0 — no app sees it (#676).
- Session JSONL `api_round` records carry only second-granularity timestamps — no
  first-byte timing, so wait-vs-tool attribution needs the driver's own clock.
