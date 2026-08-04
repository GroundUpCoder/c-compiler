# GAMEDEV-EPIC — game development inside gucOS is THE primary epic

**Status: ACTIVE — jku, 2026-08-04. This is the north star. Every batch of
work falls under this epic until jku redirects.** Companion principle:
`todos/OS.md` "Dev-experience first" (commit `3fc46971`).

## The goal

gucOS is judged by whether a person can sit inside it and **actually develop
games** — in **C with SDL3**, using **gcode** (the in-OS DeepSeek coding
agent) — with a good developer experience. Not "the demo compiles": the whole
loop — write, build, run, crash, diagnose, iterate — has to feel good, for a
human working directly and for a human working through the in-OS agent.

The backlog is rescrubbed against this goal (jku, 2026-08-04): the next
batches select work that advances SDL3/C gamedev DX in-OS. Unrelated work is
deprioritized — not deleted — subject to the standing bug-fix-first and
broken-build-preemption rules.

## Foundation tickets (jku manual promotion, 2026-08-04)

Pulled to the **front of P0 and scheduled for the next cycle** by explicit
jku intervention (the sanctioned weight-sort override). All three come out of
the measured SDL3 busy-loop incident (a legal poll-only render loop crashed
the whole tab):

1. **GPU present transport backpressure** (absorb) — clamp/coalesce presents
   at the producer seam (`presentTo`, host.js browser flavor) to ~vsync rate;
   mailbox newest-wins preserved. Kills the tab-crash class outright.
2. **`SDL_PollEvent` pumps the input ring** (SDL3 conformance) — poll-only
   loops are currently input-dead and unclosable; upstream SDL3 pumps inside
   PollEvent, we must too.
3. **Hung-app contain** — kernel detects a close request that sits undrained
   (~seconds) and force-quits that process with a legible "not responding"
   reason. The platform kills the offender; the OS never dies with it.

These are also the epic's first real content: the first thing every naive
game does is a poll-only render loop.

## The two recurring pass types

Each batch includes dogfood passes. Each pass is its own thread with a fresh
context; findings become tickets (both keys set — `--difficulty` AND
`--priority`), and fixes ride normal lanes.

### Pass A — dogfood-direct (Opus plays the game developer)

An **Opus agent manually creates and runs games inside gucOS** using C +
SDL3 itself (terminal, gcode as editor, cc, run in a window). It plays the
role of a human game developer: picks a small game (pong, breakout, snake,
asteroids…), builds it up, runs it, iterates. What it hunts:

- **Stability**: anything that crashes, wedges, or corrupts — the app, the
  window, or the OS. A platform crash from userland is always P0-class
  (OS.md principle).
- **Missing-but-expected SDL3 surface**: common functions a real game
  reaches for that we lack — useful, expected, and **not too difficult to
  implement** (that triple is the filter; a hard/rare API gets a ticket
  tagged for discussion, not an implementation).
- **Performance**: frame pacing, input latency, compile turnaround —
  anything that makes the loop feel bad.
- **DX friction**: error messages, crash diagnostics, the build-run-debug
  loop, file management.

### Pass B — dogfood-via-agent (Opus plays the human, DeepSeek writes the code)

An **Opus agent drives the in-OS DeepSeek agent (gcode) to do the coding** —
the Opus agent does NOT write code itself. It behaves exactly like a human
who wants a game built: prompts gcode, reviews what appears, asks for
changes, runs the result. What it hunts: **every blocker that would make it
difficult or annoying for a HUMAN to develop games with DeepSeek inside
gucOS** — agent iteration latency, gcode tooling gaps, how build/runtime
errors surface back into the agent loop, run/debug ergonomics, context the
agent can't see but needs.

### Pass mechanics

- Findings are filed as tickets in this repo's tracker with evidence
  (screenshots to `s3://groundupcoder/gucos/<topic>/<date>/`, transcripts,
  exact repro C source).
- Passes REPORT and FILE; they do not land platform fixes mid-pass. (An
  Opus-written fix, when one is assigned later, carries the standing
  independent-review rule — Codex, else Kimi K3; Fable implementations
  skip it.)
- A pass that finds nothing new shrinks the finding bar, not the pass: try a
  harder game, a new SDL3 subsystem (audio, textures, sprites, text), or a
  longer session.

## EPIC 2 (QUEUED — later, do not start until jku says)

The same epic shape on **CPython (cpython-clang) + pygame**: dogfood-direct
and dogfood-via-agent passes for Python game development inside gucOS.
Interpreter state: `todos/CPYTHON.md`. Queued behind Epic 1 by design — no
pygame work rides the current batches.
