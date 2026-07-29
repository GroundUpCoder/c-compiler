# NetSurf: the page console reaches the tty (todos/0421)

A page author inside gucOS had no evidence channel. The gucOS window
table had no `console_log`, so every `console.log` from a page stopped at
the core. The demos document the console as their own evidence channel;
in the OS those reports went nowhere. The `netsurf-bughunt` lane proved
it: a real stroke put ink on the paint demo and no line on the tty.

## Why NSLOG is not a channel

The core does log each entry through NSLOG before it calls the window
table. That looks like a fallback. It is not one.

The build does not define `WITH_NSLOG`, so `NSLOG` is the plain
`nslog_log` in `utils/log.c`. That function writes nothing unless the
global `verbose_log` is true, and only `-v` as the FIRST argument sets
it. `-v` then enables every category at once. The build also compiles
NSLOG at `NETSURF_LOG_LEVEL` `INFO`, so DEBUG and VERBOSE entries are not
in the binary at all — `console.log` maps to VERBOSE, so it is compiled
out even under `-v`.

So the frontend entry is the only route, and it must be always on.

## The line

`gui.c` writes one `js: SOURCE: LEVEL: TEXT` line per entry to stderr.
Three decisions are worth recording.

**Both classifications are on the line.** The LEVEL is the page's own
severity (`console.warn` against `console.log`). The SOURCE says who
spoke — the page's console, an uncaught exception, or the client. Each
changes what the reader does, so neither one substitutes for the other.

**Every line of a multi-line entry carries the full prefix.** The text is
counted, not NUL terminated, and it may hold newlines; a stack trace is
the usual case. A bare continuation line is un-greppable and can pass for
the page's own output on the same tty. One trailing newline ends the
writer's last line and does not add an empty one; a deliberately empty
entry keeps its line, because the core permits one.

**The entry carries no window tag.** This seam has no window name the
reader can correlate. The SDL window id is not the kernel surface id that
`wmctl list` prints, and the title is unbounded and changes under the
page. A tag that cannot be matched to a window is noise.

## Uncaught exceptions: the answer is yes, but not from here

Exceptions belong on the same route. They cannot be put there from the
frontend.

`BW_CS_SCRIPT_ERROR` is an enum value that nothing in the tree emits.
dukky reports its own errors at four sites instead. Three of them are
`NSLOG(dukky, DEBUG, ...)`, which the INFO build level compiles out, and
two of those three are the event-listener call paths. So an exception
thrown inside a click handler produces nothing anywhere — it is invisible,
not merely un-routed. That is exactly what cost the bug-hunt lane an
instrument-against-target check.

The fix is one helper at those four sites, in
`content/handlers/javascript/duktape/dukky.c`. That file is the vendored
upstream tree, so the change also lands in the shared
`patches/netsurf.diff`, which sibling lanes were regenerating the same
day. This lane owns `gucos/gui.c` only. Filed as todos/0424, register
entry L63. `gui.c` already classifies `BW_CS_SCRIPT_ERROR` and prints it
as `exception`, so 0424 needs no frontend change.

## The test, and what it found

`tests/kernel/test_netsurf_console_e2e.js` opens a page that logs at
every level, logs a multi-line entry, logs an entry ending in a newline,
and logs an empty entry.

The wait is a real completion marker, not a clock. The console calls sit
in a `<head>` script and the `<title>` the test waits on comes AFTER
them, so `wmctl wait win ConsoleDone` cannot be satisfied until every
call has run and flushed. `document.title` is not usable here: its
duktape setter is a no-op stub.

The first run failed on every tty leg while every redirected leg passed —
which located the fault immediately. The headless twin splits the tty by
descriptor: `os/boot.js` `onOutput` sends fd 2 to the host's stderr and
everything else to its stdout. So the entries were on the boot's stderr,
where they belong. The test now reads that stream, echoes its section
markers to both streams, and adds a leg asserting no entry leaks onto
stdout.

## Gates

- `node tests/todos/run.js` — 5/5 passed.
- `node tests/run.js projects` — 29 passed, 0 failed (1 documented skip:
  `cpython-clang`).
- `node tests/kernel/run.js` — 130 passed, 0 failed; artifact
  `recorded 130 / total 130`, one run, 0 carried, 0 resumed.
- `node tests/browser/os-sweep.mjs` — 41 passed, 0 failed; artifact
  `recorded 41 / total 41`, one run, 0 carried, 0 resumed.

`os/image.json` is untouched. It was already at 193 while production was
at 192, so this change rides the unshipped bump.
