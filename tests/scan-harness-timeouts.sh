#!/bin/sh
# todos/0369 — step 2, the STATIC half: every fixed timeout in the test
# HARNESS layer. Run from the repo root; classify the hits by hand (the
# classification of the current population lives in
# logs/2026-07-28/0369-timeout-survey.md).
#
# The population is the HARNESS set — runners, the dispatcher, and tests/lib/
# — NOT the tests themselves (0361 owns wall-clock assertions inside tests;
# waits inside individual test files are a different layer). The tests/lib/*.js
# glob is deliberate: a NEW lib file joins the population without editing this
# script.
#
# Like tests/scan-wallclock.sh this is written to be over-inclusive — it
# matches every timeout-shaped site (enforcement caps, kill-grace timers,
# poll intervals, plumbing, usage text) and accepts false positives rather
# than misses. NB the pattern matches `timeoutMs:` with ANY right-hand side,
# not just a numeric literal: `timeoutMs: long ? 3600000 : 600000`
# (tests/blockfs/run.js) is a real per-file cap that a digit-anchored
# pattern provably missed during authoring.
#
# Second leg: run-unit.js accepts a per-test `"timeoutMs"` override in a
# test's config.json — that channel is part of the cap surface, so the scan
# covers it even while it has zero users (its emptiness is load-bearing and
# is under the same positive control).
HARNESS="tests/run.js tests/run.py tests/run-unit.js tests/flake.js
  tests/kernel/run.js tests/host/run.js tests/blockfs/run.js
  tests/todos/run.js tests/ext/run.js tests/browser/os-sweep.mjs"
grep -nE '(setTimeout|setInterval)[[:space:]]*\(|AbortSignal\.timeout|Atomics\.wait[[:space:]]*\(|[Tt]imeout[A-Za-z_]*[[:space:]]*[:=]|[A-Z_]*TIMEOUT[A-Z_]*[[:space:]]*[:=]|_MS[[:space:]]*=[[:space:]]*[0-9]|_SECS?[[:space:]]*=[[:space:]]*[0-9]|Date\.now\(\)[[:space:]]*\+[[:space:]]*[0-9]' \
  $HARNESS tests/lib/*.js
grep -rn '"timeoutMs"' tests/unit --include=config.json
