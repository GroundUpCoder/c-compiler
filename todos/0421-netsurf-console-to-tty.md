# 0421 — netsurf gucos: page console output reaches no tty

- **Status**: open
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
