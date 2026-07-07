# Interactive job control e2e — and the input-stealing bug it caught

The HANDOFF lingering item: Ctrl-Z/fg/bg had no automated e2e (the existing
`test_jobctl_e2e.js` drives stop/cont from the EMBEDDER side —
`kernel.kill(pid, SIGSTOP)` from JS — never through the tty). The 0011 vi
harness (`boot.js --tty-out` + expect/marker discipline) was most of the
missing machinery, so this was cheap to close: `test_jobctl_tty_e2e.js`
drives busybox hush's real job control — VSUSP through the line
discipline, `jobs`/`fg`/`bg` builtins, `cat` as the tty reader, `kill %1`,
`$?` markers as the assertion channel (128|sig = 130 after Ctrl-C).

## The bug (0003-era, latent until now)

Scenario B failed on the FIRST run, and not as a test bug: after Ctrl-Z
stopped a foreground `cat`, the next typed line (`jobs\n`) vanished —
hush never saw it. Root cause: `_ttyNotify` serves the deferred-read
queue strictly FIFO with **no eligibility check at serve time**. The
stopped `cat`'s ttyread RPC stays parked (stopping doesn't cancel it —
correctly), sits at the head of `_ttyWaiters`, and eats the shell's
input. The dispatch-time job-control check (SIGTTIN for background
readers) never re-runs for already-parked reads, so the same hole covered
`bg`'d readers too.

Classic first-user-of-a-path bug, same class as 0010's FS_READLINK and
0011's TIOCGWINSZ: nothing before this test ever had a *stopped* process
with a parked tty read while another process typed.

Fix (kernel.js `_ttyNotify`): serve-time eligibility mirroring POSIX —

- STOPPED waiter → skip, keep queued (its read resumes consuming only
  after SIGCONT *and* foreground possession; a frozen read consumes
  nothing).
- Waiter whose pgroup lost the tty since parking → the dispatch-time
  treatment, applied late: SIGTTIN to its pgroup + EINTR (EIO if TTIN is
  ignored/blocked). Input belongs to the foreground pgroup, not to
  whoever parked first.

## What the test now proves end-to-end

- A: fg `cat` line roundtrip; Ctrl-C → SIGINT → `$?` = 130.
- B: Ctrl-Z stops the reader; `jobs` shows `Stopped`; the shell keeps the
  tty (the stolen-input case); `fg` → SIGCONT + tcsetpgrp → the SAME
  parked read completes with newly typed input; Ctrl-C ends it.
- C0: `cat &` finishes immediately — hush (unlike bash) /dev/null's the
  stdin of a backgrounded pipe's first command even when interactive, so
  there is no bg-tty-reader via `&` at all. First test draft assumed bash
  semantics and expected SIGTTIN; the port's own `WASM PORT` journal
  comment at that hush.c site says otherwise. Kept as an assertion so the
  semantics stay pinned.
- C: the REAL hush route to a background tty reader: Ctrl-Z then `bg`.
  The resumed job's still-parked read is now background; the next typed
  line SIGTTIN-stops it at serve time and the line reaches hush. `fg`
  rescues it into a working reader.
- D: `kill %1` terminates a STOPPED job (TERM acts on stopped processes);
  `wait` unblocks.

Harness notes for the next test: under `--tty-out` piped mode the tty
drops echo bytes, so stdout is byte-clean program output — a line typed
at `cat` appears exactly once, and `echo M:$?` markers can't be confused
with their own command line (it's never echoed).
