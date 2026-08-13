# Pass B — dogfood-via-agent, ROUND 3

**Round 2 was #508** (run 2026-08-13/14, lane/508-passb-r2). It filed **#668, #669, #670,
#671, #672, #673, #674, #675, #676, #677** and this ticket carries a HARD `blockedBy` edge
onto every one of them, so round 3 cannot start until round 2's fixes have landed. That edge —
not the word "recurring" — is the loop mechanism (GAMEDEV-EPIC.md, "The two recurring pass
types"). Standing Pass A/B promotion (jku 2026-08-04): this round is pre-promoted to run when
its edge clears, no fresh ask needed.

🔴 **Blocking mechanics, corrected (2026-08-13):** the verb is
`cc-meta ticket block <ref> --project <P> --hard <uuid,uuid,…>`.
**`cc-meta ticket update --blocked-by` is a SILENT NO-OP** (HTTP 400 with exit 0) — older
copies of this body (including #508's) still name it; do not use it. Verify every edge by
re-reading the ticket: `blockedBy` count must equal the finding count and `derived.ready`
must be false.

## What round 2 found, so round 3 does not re-run it

An Opus-family agent drove live deepseek-v4-flash through gcode's **interactive REPL**
(headless boot.js, tty driver) and gcode built a complete, verified SDL3 **Asteroids**
(865 lines: rotation/thrust/momentum, splitting, HUD, title screen with sprite-sheet spin,
3 synthesized sound effects) across 7 turns / 235 API rounds — including finding, diagnosing
and fixing a text-rendering bug after a human report. Findings, severity order:

- **#668 (P0)** — software SDL tier: RenderLine diagonals fill their bbox, RenderGeometry is
  a silent success no-op (host.js:7986-7992); browser tier correct; undocumented, untracked.
- **#670 (P2)** — gcode cannot see screenshots: its pixel-stat verify passed MIRRORED HUD text
  as "confirmed" (the verifier shared the renderer's bit-convention bug).
- **#669 (P2)** — the #507 "waiting for model" heartbeat never fires in-OS (curl veneer parks
  indefinitely); 7 rounds >60s (max 180s) of total silence measured.
- **#671/#672/#673 (P2)** — render targets absent (with a dangling SDL_TEXTUREACCESS_TARGET
  enum), SDL_RenderTextureRotated absent, no SDL_ttf/text path (2-for-2 games hand-rolled
  fonts; the hand-rolled font is where the mirror bug came from).
- **#674 (P2)** — sdl-gucos.md silent on headless audio-sink absence + software-tier caveats.
- **#676 (P2)** — wmctl key with omitted KEYSYM injects keysym 0 (invisible to apps).
- **#677 (P2)** — no SDL API index; ~15 rounds/session of header re-archaeology measured.
- **#675 (P3)** — gamepad surface absent + untracked (static evidence; not exercised live).

Round 2's explicit NULLS: **REPL fundamentals are solid** — ^C mid-turn interrupts cleanly
(both mid-API-wait and mid-tool), ^C at the prompt re-prompts, up-arrow history recall works,
manual and auto /compact work (two mid-turn auto-compactions folded 108/71 messages and the
turns continued correctly), resume after a SIGKILLed boot lost nothing (132 messages), and a
post-compact small turn answered in 2.3 s. **The bash tool cap and backgrounded-launch fixes
(#503/#504) held** all session. **`python -` works** (a round-2 suspicion that positive-
controlled clean: the failure was a missing MicroPython module in the agent's own script).
No OS crash, wedge, or corruption; the heavy-lock wait (`--wait-lock`) queued politely behind
a sibling lane's gate.

## What round 3 should do differently

1. Round 2 still ran headless. The **windowed axis is now the unexamined one**: gcode inside
   `/bin/term` under real-browser Chromium (VT2), where scrollback, the term escape parser,
   and the browser compositor meet the REPL. State it, cover it.
2. Push a subsystem round 2 didn't: the fixed render path (verify #668's fix with a line-art
   game), or gamepad if #675 landed, or multi-file/project-scale builds (every game so far is
   one file).
3. Turn-length ergonomics: round 2's feature turns ran 5-9 minutes; probe whether the fixed
   heartbeat (#669) and API index (#677) actually moved the felt experience.

---

The standing charter (verbatim mechanics from GAMEDEV-EPIC.md § "The two recurring pass
types" and #488/#508): an Opus agent plays the HUMAN driving gcode — it writes no code
itself; report-and-file only, every finding ticketed with `--priority` AND `--difficulty`
plus evidence; evidence to `s3://groundupcoder/gucos/<topic>/<date>/`; round N closes only
when (1) findings are filed, (2) round N+1 exists, and (3) round N+1 is hard-blocked on every
round-N finding **via `ticket block --hard`, verified by re-read**.

Round-2 evidence: `s3://groundupcoder/gucos/508-passb-r2/2026-08-13/`.
