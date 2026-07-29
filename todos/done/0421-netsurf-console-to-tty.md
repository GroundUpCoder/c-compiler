# 0421 — netsurf gucos: page console output reaches no tty

- **Status**: done
- **Design**: —

## Goal

`console.log` from a page script is invisible in the OS. The gucos frontend
window table has no `console_log` entry, so the core's
`browser_window_console_log` only feeds NSLOG, and NSLOG output is not routed
to the process tty either. The monkey (host-side) frontend DOES surface the
console, which is why every demo page self-reports on the console — in the OS
those reports go nowhere.

Found by the `netsurf-bughunt` lane (2026-07-29): the paint demo logs one line
per stroke; a real stroke in a booted OS produced ink on the pad and NO line on
the tty (`tests/browser/nsdemos-paint-probe.mjs`, "console.log stroke line
visible on tty" — informational leg).

## Why it matters

A page author inside gucOS has no way to see a script error or a log line.
The demos document the console as their own evidence channel. Debugging a page
in the OS today means "add a DOM readout", which is what the demos do — that
workaround should not be mandatory.

## Plan

1. Implement `console_log` in `vendor/netsurf/gucos/gui.c`'s window table:
   write `js: <src>: <msg>` lines to stderr (the shell's tty when launched
   with `&`).
2. Decide whether JS ERRORS (uncaught exceptions) get the same route — they
   should; a silent exception cost this lane an instrument-vs-target check.
3. A kernel e2e leg: open a page that logs a marker, assert the marker on the
   captured boot tty.

The fix touches `vendor/netsurf/gucos/`, so it owes an image bump.

## Result (2026-07-29)

`gui.c` implements `console_log`. Each entry becomes one
`js: SOURCE: LEVEL: TEXT` line on stderr, which is the shell's tty when
the browser runs as `netsurf page.html &`. The line carries the level as
well as the source, because both change what the reader does. Every line
of a multi-line entry carries the full prefix, so one grep finds all of a
stack trace and no continuation line can pass for the page's own output.
The channel is always on; `2>/dev/null` is the off-switch.

Step 2 is answered: uncaught exceptions SHOULD take the same route, and
they cannot be routed from this seam. Nothing in the tree emits
`BW_CS_SCRIPT_ERROR`. dukky reports its four error sites itself, three at
NSLOG DEBUG — which the INFO build level compiles out — and one at
WARNING, which is silent without `-v`. So an exception in a click
listener is invisible, not merely un-routed. The fix belongs at those
four sites, in the vendored upstream tree this lane does not own, and it
needs the shared `patches/netsurf.diff` that sibling lanes were
regenerating the same day. Filed as todos/0424 with register entry L63.
`gui.c` already classifies `BW_CS_SCRIPT_ERROR` and prints it as
`exception`, so 0424 needs no frontend change.

Step 3: `tests/kernel/test_netsurf_console_e2e.js`, 18 assertions. The
wait is a real completion marker — the console calls sit in a `<head>`
script and the `<title>` the test waits on comes after them.

No image bump: `os/image.json` was already at 193 and production was at
192, so this change rides the unshipped bump.
