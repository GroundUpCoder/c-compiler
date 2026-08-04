# GAMEDEV-EPIC — game development inside gucOS is THE primary epic

**Status: ACTIVE — jku, 2026-08-04. This is the north star. Every batch of
work falls under this epic until jku redirects.** Companion principle:
`todos/OS.md` "Dev-experience first" (commit `3fc46971`).

> **jku, 2026-08-04, verbatim:** *"The gamedev in gucOS is the primary focus
> indefinitely until otherwise specified."*

That directive is **not scoped to a batch or a cycle** — it stands until he
says otherwise. **Operative reading for queue selection: gamedev primacy is a
FILTER APPLIED BEFORE the weight sort.** Select the gamedev-advancing tickets
first, *then* order them light → medium → heavy with Pn breaking ties inside a
tier. It does **not** override bug-fix-first (which applies within a tier) and
it does **not** override broken-build preemption (a build that blocks lands is
still the top immediate priority).

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

## Critically required game infrastructure (jku, 2026-08-04)

Beyond stability, the epic explicitly includes the infrastructure games
**critically require**. Named so far:

- **Text rendering: FreeType, properly supported for game/app use.** Clean
  text is table stakes for games. FreeType is already vendored
  (`vendor/freetype`, the 0275 ksvc kernel text service uses it); the gap is
  app-side linkability — **#464 (P0): FreeType as a standalone srclib
  package with automatic source linking** is the vehicle. "Properly" means
  the app-facing path, not just the kernel service.
- **SDL3_ttf: great if we can, honest escape hatch if not.** jku verbatim:
  if the complexity is too high and the workaround is reasonable, we may
  work around it (e.g. games use FreeType directly, or a small custom text
  helper). **#468** (SDL_ttf classic API as a veneer over FreeType,
  `TTF_Text` deliberately excluded) is the scoped-honest shape of this.

**API honesty (jku, 2026-08-04 — general principle, not just text):**
*"It's better to not implement at all or have a custom API rather than
incorrectly implement or lie with API."* A standard-named function that
subtly diverges poisons every port and every dogfood signal; an absent
symbol fails loud at link time; a custom-named API tells the truth about
what it is. Scoped-but-honest subsets are fine when the boundary is explicit
(SDL_ttf classic API without TTF_Text is the model; the VLA "real or absent,
never faked" ruling is prior art). Pass A/B findings proposing new SDL3
surface must respect this: implement correctly, or file it as
custom/deferred — never approximately.

## The two recurring pass types

Each batch includes dogfood passes. Each pass is its own thread with a fresh
context; findings become tickets (both keys set — `--difficulty` AND
`--priority`), and fixes ride normal lanes.

### 🔴 These passes are TICKETS now — prose here has no scheduling force

**Round 1 is `#487` (Pass A) and `#488` (Pass B).** Until 2026-08-04 both
passes existed *only* as the prose below, and prose does not schedule
anything: the foundation batch would have merged, shipped and closed with no
investigative pass ever firing. If you add a pass type here, **file it as a
ticket in the same breath.**

**PROMOTED — jku, 2026-08-04, verbatim:** *"Yes I want these passes to run
right after. And I want this to repeat after doing the pass and identifying
things to fix."* So: round 1 runs **immediately after `#484`/`#485`/`#486`
merge**, by explicit manual heavy-promotion. Read as a **standing promotion
for the Pass A / Pass B family only** — each later round is pre-promoted to
run when its dependency edge clears, with no fresh ask per round. It does not
generalise to any other heavy ticket.

**The recurrence is a `blockedBy` chain, NOT the word "recurring".** That word
has a perfect zero-for-three record in this tracker (`#4` is stalled literally
*at* "round 3"; `#37` and `#109` say "recurring" and never recurred; `#220`
was a hand re-file that collided and was dropped). **Definition of done for
round N is three things:** (1) file every finding with both keys and evidence;
(2) **file round N+1**; (3) **set a hard `blockedBy` edge from round N+1 onto
round N's finding tickets**. Only then may round N close. This is
self-perpetuating, it encodes jku's sentence exactly (N+1 cannot start until
N's fixes land), and it terminates — cc rejects cycles. Full rationale:
`~/git/meta/meta/notes/gamedev-dogfood-loop-2026-08-04.md`.

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
