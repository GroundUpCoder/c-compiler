# 0226 — unit/sdl_delay_throws red at HEAD: 0224 made SDL_Delay really sleep in worker runners

- **Status**: done (2026-07-16) — test renamed to `unit/sdl_delay_sleeps`, pins the 0224 sleep-succeeds contract (both lines print, SDL_GetTicks-measured duration honoured, exit 0); the throw contract stays pinned by `tests/kernel/test_sdl_delay_e2e.js`
- **Design**: `todos/done/0224-sdl-delay-worker-cooperative.md`

## Goal

`node tests/run.js unit` is red at HEAD (2b7e37a, i.e. BEFORE any 0225 work):
`unit/sdl_delay_throws` pins the pre-0224 contract — SDL_Delay without JSPI
always throws, "after delay" never prints. 0224 made SDL_Delay a real sleep
"wherever blocking is legal", and the in-process worker runner
(`tests/run-unit.js`, worker_threads) is such a place: the delay now
succeeds, both lines print, and the test fails on stdout + exit code.

Found incidentally while gating 0225 (verified red on a clean stash of
HEAD, so not 0225 fallout).

## Plan

Decide which side is right and sync test to behavior (the 0224 semantics
are the feature; the test's throw expectation looks stale). Either update
the golden to the sleep-succeeds contract, or if the throw is still the
intended contract for the UNIT runner flavor specifically, make the veneer
throw there and keep 0224's e2e coverage for the worker flavors.

## Acceptance

- `node tests/run.js unit` green at HEAD with no other test moved.
