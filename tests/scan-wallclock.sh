#!/bin/sh
# todos/0361 — the survey command. Lists every tests/unit/** source that READS A
# CLOCK, which is the necessary condition for pass/fail to depend on elapsed
# wall-clock time. Run from the repo root; classify the hits by hand (the
# classification of the current 22 lives in logs/2026-07-28/0361-wallclock.md).
#
# This is a scan whose "nothing else found" is meant to be load-bearing, so it
# is written to be over-inclusive: it matches every clock source reachable from
# a unit test, including SDL's, and accepts false positives (a comment saying
# "at compile time (rejects-valid)" matches `time\s*\(`) rather than misses.
# Its positive control is in the same log entry.
grep -rlE '\b(clock_gettime|gettimeofday|time[[:space:]]*\(|clock[[:space:]]*\(|times[[:space:]]*\(|difftime|timespec_get|st_[amc]tim|st_[amc]time|alarm[[:space:]]*\(|setitimer|getitimer|CLOCK_[A-Z_]+|SDL_GetTicks|SDL_GetPerformanceCounter|emscripten_get_now|__builtin_readcyclecounter|rdtsc)' \
  tests/unit --include='*.c' --include='*.h' | sort
