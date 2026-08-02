# #412 — gcode: ^C during a batched tool call now stops the agent loop

**Ticket:** #412 (P0). jku's report: "ctrl+c doesn't really kill it. It seems
to kill temporarily or partially? But the loop seems to keep going."

## The bug

gcode treated interruption as a property of the HTTP *transfer*, not of the
*agent loop*: the only mid-turn reader of `g_interrupted` was the curl
progress callback. So a ^C during a batched tool round killed the running
`sh -c` child (the visible "partial kill") but the remaining `tool_use`
blocks of the round ran anyway, and the next POST went out — reproduced in
the browser repro as `POSTs 8 -> 9` with tool 2's result
`[exit 0]\nSECOND-TOOL-RAN-ANYWAY\n` on the wire.

## The fix (all three shapes from the ticket)

- **(a)** The tool loop checks `g_interrupted` before executing each block.
  Skipped blocks get a SUBSTITUTED `tool_result`
  (`[interrupted by user (^C) — tool not executed]`) — never dropped, so
  every `tool_use` keeps its `tool_result`, the history stays API-valid and
  the session stays resumable. The round returns -2 (interrupted) after
  appending + persisting the results.
- **(b)** `do_turn` refuses to build/send a POST when `g_interrupted` is
  already set — the window between a round's last tool finishing and the
  next POST.
- **(c)** `run_command` (both flavors) kills the child on an interrupted
  wait. The edge is REAL, confirmed two ways in-OS:
  - `kill -INT <gcode pid>` signals gcode alone — the child never sees it
    (the new kernel e2e leg t6; pre-fix gcode drained the child's full 30s
    sleep before continuing).
  - hush `trap "" INT` works: a `sh -c 'trap "" INT; sleep 3; echo
    SURVIVED-TRAP'` child survives a direct SIGINT (probe: SURVIVED-TRAP,
    rc=0; the no-trap control dies with 130). So a SIGINT-ignoring tool
    survives a real tty ^C too.

  **Shape gotcha, measured:** kill-then-drain-to-EOF still stalled 30s,
  because hush runs `sleep 30` as its own child which inherits the pipe
  write end and survives the `sh` kill. The interrupt path therefore kills
  AND STOPS READING (everything the tool printed before the ^C was already
  drained by earlier reads; `waitpid` on the SIGKILLed sh cannot block).
  The 120s-timeout path keeps its drain-to-EOF behavior — same latent
  grandchild-hostage shape there, but out of scope here and its "keep
  draining so the child can exit" capture semantics are deliberate.

## Tests (red-first, both observed red on main @1fc44236)

- `tests/browser/os-gcode.mjs` leg 4b — the committed re-creation of the
  2026-08-02 repro: batched two-tool round via the new `multiToolUseResponse`
  fixture shape, real page-keyboard Ctrl+C ~3.5s into tool 1's 20s sleep.
  Asserts: no further POST after the ^C; tool 1's result is partial; tool
  2's result is the substituted marker (not its output); a follow-up send
  reaches the API from the same gcode (prompt usable). The file's stale
  header claim ("no progress callback, g_interrupted never consulted
  in-OS") was corrected — false since #306/`0f7782c2`.
- `tests/kernel/test_gcode_step2_e2e.js` t6 + a `kind: 'tools'` script
  shape in `lib/fake_anthropic.js` — the fast in-OS twin, and the (c)
  regression guard: `kill -INT $pid` mid-tool-1, asserts prompt return
  (≤10s vs the 30s pre-fix drain), tool 1 killed, tool 2 never executed,
  substituted tool_result in the persisted session log, `turn_end` status
  `interrupted`, and exactly 7 POSTs (no tool_results round).

Out of scope, untouched: #305 REPL semantics (^C re-prompts, only /quit
exits), double-^C-to-exit (#414, needs jku's ruling).

Image v220 → v221 (gcode.c is a baked source).
