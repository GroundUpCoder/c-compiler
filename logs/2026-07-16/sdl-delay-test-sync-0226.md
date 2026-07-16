# unit/sdl_delay_throws → sdl_delay_sleeps (todos/0226)

The unit suite was red at HEAD: `unit/sdl_delay_throws` pinned the pre-0224
contract (SDL_Delay always throws without JSPI, "after delay" unreachable,
exit 1). todos/0224 deliberately changed the runtime: SDL_Delay is now a real
cooperative/blocking sleep wherever blocking is legal — and the unit runner
(`tests/run-unit.js`, worker_threads) is such a place, so the delay succeeds,
both lines print, and the golden mismatched. Pure test staleness, not a
runtime bug: `tests/kernel/test_sdl_delay_e2e.js` (which pins BOTH sides —
worker/null flavors sleep, standalone-browser flavor still throws loud) stays
green untouched.

Fix: renamed the test to `unit/sdl_delay_sleeps` and flipped it to pin the
NEW contract for the unit-runner flavor — both lines print, exit 0, and the
sleep is a real assertion (SDL_GetTicks around SDL_Delay(50), fail if < 40ms)
rather than just "didn't throw". The browser-flavor throw contract is not
re-assertable from the unit runner (wrong flavor by construction); it lives in
the kernel e2e, and the test comment points there.

Also filled in the stale `Status: open` headers on the 0224 and 0226 done
items (both had been moved to todos/done/ without the date/summary line).

Gate: `node tests/run.js unit ast` green; full unit runner 745 passed /
0 failed / 8 xfailed / 3 skipped (xfail set unmoved);
`node tests/kernel/run.js --filter=sdl_delay` green.
