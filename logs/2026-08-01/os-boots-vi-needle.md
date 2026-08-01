# #356 — os-boots vi leg: the needle that matched its own echo

## The bug (0171 class)

`os-boots.mjs` typed `cat /tmp/b.txt && echo VI-CAT-OK` and then waited
for `VI-CAT-OK`. The tty ECHOES the typed command, so the needle was in
`__osOut` before cat produced a single byte; ~10% of runs then captured
`viSeg` before the file content arrived — failure signature: viSeg ends
at the echoed command line. Measured pre-existing (worktree 11/13 vs
origin-main 12/13 on the #353/#354 diff), i.e. not a regression, just a
wait that never proved anything.

## The fix

The split-needle rule: type `echo VI-CAT""-OK`, wait for `VI-CAT-OK`.
hush glues the empty string back together, so only the command's real
output matches; because `&&` orders cat before echo, seeing the needle
now guarantees cat's output is in the transcript.

Sweep of the file's other waits found one more echo-satisfiable needle:
the two-tab guard leg's `echo GUARD-SHELL-OK` waiting on
`GUARD-SHELL-OK\n` (whether the echoed CR renders as `\n` decides if it
false-matches — split it rather than depend on line-discipline detail).
That wait IS the leg's assertion, so a false match weakened it to
vacuous. Same split applied. All other waits are multi-line needles,
escape sequences, or text disjoint from their typed line.

The ticket's candidate 2 (the 600ms insert settle / 300ms ESC air fixed
sleeps) was left alone: with the needle split, the repeat/under-load runs
came back stable, so the sleeps were not the operative flake. They stay
annotated timing subjects. (Results in the lane report / ticket close.)
