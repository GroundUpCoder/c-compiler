# todos/0433 — the file gadget opens /bin/filepick

The gucOS window table had no `file_gadget_open` entry. A click on
`<input type=file>` ended in gui_factory's empty default. The design
pass (in the ticket) chose an out-of-process picker. This log records
the implementation findings.

## What landed

- `os/win32/filepick.c` + `filepick.json` — a ~60-line app around one
  `GetOpenFileNameW` call. Accept prints the absolute path and exits 0.
  Cancel prints nothing and exits 1. The stdout stream is
  newline-separated paths, so a future multi-select adds lines, not a
  new protocol.
- `vendor/netsurf/gucos/gui.c` — the table entry, the spawn (pipe +
  `posix_spawn`, stdout dup2-ed to the pipe), the poll that reaps and
  applies, and the cancel path. `gui.h` holds the per-window picker
  state. `main.c` holds the SIGCHLD flag and the poll call.
- `os/image.json` v197 → v198 (a new seeded binary).
- `tests/kernel/test_netsurf_filegadget_e2e.js` — kernel 134 → 135.

## The design named a retain API that does not exist

The design said: retain the content with `hlcache_handle_retain`.
That function is not in the tree. `hlcache_handle_clone` exists but
always returns `NSERROR_CLONE_FAILED` — it is a stub. There is no
public way to hold a content reference from a frontend.

The compensation keeps the design's intent with a stronger rule:

1. `GW_EVENT_NEW_CONTENT` cancels a live picker (SIGTERM + reap). A
   navigation kills the dialogue, so a stale result cannot exist on
   the main path. This is also the Windows behaviour.
2. The apply still checks `browser_window_get_content(gw->bw) ==
   picker_hl`. This catches any replacement path that fires no
   NEW_CONTENT on this window. The check compares pointers and does
   not dereference the recorded one.
3. `gui_window_destroy` cancels first, so a pick never applies to a
   dead window.

The gadget pointer stays valid while check 2 passes: form controls are
cached per (content, node) — `forms.c` "Step one" returns the existing
control across re-conversions.

## The SIGCHLD wake is flag-then-park

The browser parks in `SDL_WaitEventTimeout`, possibly with no deadline.
A SIGCHLD claimed at an import return between the poll and the park
clears the kernel's pending bit. Without a flag the park then sleeps
its full timeout with the child already dead. The handler sets a
`sig_atomic_t` flag; the loop polls when the flag is set and refuses
to park while it is set. A signal still pending at the park makes the
kernel WAIT return at once. Both claim orders reach the poll promptly.
This is term's pattern (todos/0161 notes).

## Gotchas for the next reader

- `wmctl tree` output starts with `== pid N`. drive.js `section()`
  ends a section at the next `==`, so a tree inside a section reads as
  empty. Assert on the raw output instead.
- `wmctl wait win` proves the window exists, not that the picker's
  agent socket serves. Wait on a LABEL before tree/settext/gettext —
  the notepad pattern.
- The worktree setup note "symlink node_modules twice" is not enough:
  the main tree's `tests/browser/node_modules` is a SEPARATE pinned
  install (playwright 1.61.0), and the root `node_modules` carries
  1.61.1. Point the second symlink at the main tree's
  `tests/browser/node_modules`, or every sweep file fails the pin
  check (0/42).
- `form_gadget_update_value` handles GADGET_FILE: it sets the DOM
  value and fires `input`, so page JS sees `input.value` as the full
  path. The GET query carries it URL-encoded. `location.search` in
  dukky returns the query WITHOUT the leading `?`.

## Scope kept out (per the design)

Multi-select (the engine models one value per file gadget), the
`accept` filter (a platform-wide comdlg32 gap), and the multipart POST
that carries the file BYTES (`todos/0437` — the gucOS build registers
no http fetcher).
