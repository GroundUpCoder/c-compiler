# 0424 — netsurf: an uncaught JS exception reaches no console, no log, no tty

- **Status**: open
- **Design**: —

## Goal

Route every uncaught JavaScript exception to `browser_window_console_log`
with source `BW_CS_SCRIPT_ERROR`. A frontend that implements `console_log`
then shows the exception the same way it shows `console.error`.

## The gap

`BW_CS_SCRIPT_ERROR` is an enum value that **nothing in the tree emits**.
The only reference to it outside its own declaration is one NSLOG line in
`desktop/browser_window.c`. dukky reports its exceptions itself instead, at
four sites, and none of them is visible in a gucOS build:

| site | report |
| --- | --- |
| `dukky_dump_error` (compile failure, `js_exec`, `dukky_pcall`) | `NSLOG(jserrors, WARNING, ...)` |
| the listener call at `dukky.c:1285` | `NSLOG(dukky, DEBUG, ...)` |
| the listener call at `dukky.c:1409` | `NSLOG(dukky, DEBUG, ...)` |
| the handler call at `dukky.c:1833` | `NSLOG(dukky, DEBUG, ...)` |

The build compiles NSLOG at `NETSURF_LOG_LEVEL` `INFO`, so the three DEBUG
sites are **compiled out**. The WARNING site survives compilation but says
nothing without the `-v` first argument, which turns on every category at
once. So a thrown error inside a click listener — the common case — is
invisible in gucOS.

Found while todos/0421 implemented the gucOS `console_log`. It also cost
the `netsurf-bughunt` lane a wasted instrument-against-target check: a
silent exception looks exactly like a feature that does not work.

## Plan

1. Add one helper in `content/handlers/javascript/duktape/dukky.c` that
   takes the error object on the duktape stack, reads the window through
   `PRIVATE_MAGIC` (the lookup `genjs/duktape/console.c`'s
   `write_log_entry` already does), and calls
   `browser_window_console_log(win, BW_CS_SCRIPT_ERROR, text, len,
   BW_CS_FLAG_LEVEL_ERROR)`. Set `BW_CS_FLAG_FOLDABLE` for a stack trace.
2. Call it from all four sites. Keep the NSLOG lines.
3. A kernel e2e leg: a page whose click listener throws, and the exception
   text on the captured boot tty as `js: exception: error: ...`.

## Why it is not part of 0421

The change is in the vendored upstream tree, so it must also land in
`vendor/netsurf/patches/netsurf.diff`. That record is shared, and sibling
lanes were regenerating it the same day (`form.c` and `html.c` carry
2026-07-29 stamps). 0421 owns only `vendor/netsurf/gucos/gui.c`, so it
implemented the gucOS end and filed this.

The gucOS `console_log` already classifies `BW_CS_SCRIPT_ERROR` and prints
it as `exception`, so this ticket needs no frontend change.
