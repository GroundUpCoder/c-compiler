# 0433 — the gucOS file dialogue: design pass

Design-only lane on `todos/0433` (the inert `<input type=file>`), at base
`e99b2ec4`. No engine code. The design itself is in the ticket's `## Design`
section; this log records why the decision fell the way it did, and what was
rejected.

## What step 1 found

The diagnosis holds unchanged. The click path is fully live —
`interaction.c:992` broadcasts, `browser_window.c:1762` routes — and dies in
`gui_factory.c:102`'s empty default because `gucos/gui.c:673`'s table supplies
no entry. One additional fact matters more than the hole itself: the gucOS
netsurf build has **no http fetcher at all** (`netsurf-core.json` is
"fetchers-minus-curl"; the exclusion is deliberate and documented in
`vendor/netsurf/README.md`). That bounds acceptance line 2: the form DATA can
carry the chosen value today, the file BYTES cannot leave the machine. Filed
`todos/0437` so the deferral is funded, not prose.

## The decision, in one line

Reuse the platform's one existing file chooser — comdlg32's
`GetOpenFileNameW` — but run it **out of process** as `/bin/filepick`,
spawned by the frontend, result on a pipe, applied asynchronously with a
liveness proof.

## Why out-of-process won

The tempting shape was to link user32+comdlg32 into netsurf and call
`GetOpenFileNameW` inline — modal, three lines, no lifetime questions. It
loses on facts of the veneer, not on taste:

1. **One SDL queue, two owners.** netsurf drains SDL events itself
   (`gucos_process_events`). user32's `pump_sdl` (`user32.c:1759`) also
   drains the whole queue, drops events for windowIDs it does not map, and
   routes unmapped KEY events to `g_activeTop`. During a modal pump the
   browser window's resize/expose events would be consumed and lost — the
   frontend would come back from the dialogue with stale geometry and no way
   to know. Key events for the browser surface would be misrouted INTO the
   dialogue.
2. **The engine starves.** Every fetch and layout step rides scheduled
   callbacks fired by `gucos_run`. A nested modal pump stops the world for
   the dialogue's whole life. A mid-load page freezes; real browsers do not.
3. **The part-time-user32 tail.** First `CreateWindowEx` binds
   `/run/win32/agent.<pid>.sock`, served only from `GetMessage`. After the
   dialogue closes, netsurf never pumps again — the socket file stays,
   unserved, and any connector hangs. Fixable only by teaching user32 a new
   teardown mode, which is veneer surgery this ticket has no business doing.
4. What the in-process shape bought — kernel-free modality and no gadget
   lifetime question — the async design recovers cheaply: a per-window
   picker guard, and a two-check liveness proof at completion (window still
   listed; `browser_window_get_content(bw)` still equals the retained
   handle).

Out-of-process also turns the dialogue into a first-class win32 app: its own
agent socket for its own lifetime, so the existing notepad/paint/sameboy
`wmctl` test vocabulary drives it, and a picker crash is a cancelled pick,
not a dead browser. Process-per-task is what this OS is; the brokered
`posix_spawn` model is the platform's core decision.

## The lifetime question (the part worth remembering)

`browser_window_set_gadget_filename(bw, gadget, fn)` carries no liveness
token, so an async pick must prove the `gadget` pointer still means
something. Two hazards:

- **Navigation** replaces `bw->current_content`. Detectable: retain the `hl`
  the callback handed over, compare `browser_window_get_content(bw)` at
  completion (public API, `browser_window.h:296`). Mismatch → drop.
- **Live re-conversion** (the 0434 class) rebuilds the box tree while the
  content stays current — the scary case. It turns out NOT to dangle the
  control: `html_forms_get_control_for_node` (`forms.c:545`) caches controls
  per (content, node) and its "Step one" returns the existing one, so
  reconversion reuses the same `form_control` for the same DOM node. This is
  the same mechanism that let 0386 carry the textarea caret across
  recreation. So: content check passes ⇒ gadget pointer valid. No
  by-node re-lookup needed (that API is `private.h` anyway).

Completion wake is term's flag-then-park SIGCHLD pattern — the kernel WAIT
wakes on a pending signal, so checking the flag before the
`SDL_WaitEventTimeout` park is gap-free (`test_wait_e2e.js` is the
precedent). No polling interval, no fd-composed wait needed: the result is
read after exit, and one path line cannot fill a 256K pipe.

## Rejected alternatives

- **In-process comdlg32 link** — above. The event-queue and agent-socket
  facts are disqualifying, not merely inconvenient.
- **A frontend-drawn chooser over libnsfb** — a second dialogue system next
  to comdlg32's, with its own list widget, scroll, keyboard nav, and its own
  bugs. Exactly the failure mode this ticket warns about. Rejected on
  principle before cost.
- **A fileman picker mode** (`fileman --pick`, path on stdout) — same
  process shape as filepick, but fileman is a file MANAGER: its window is a
  browsing surface with ops (cut/rename/delete) that a chooser must not
  offer, so a picker mode means forking its UI for one caller. The chooser
  the platform already standardised on IS the comdlg32 dialog. filepick at
  ~100 lines is smaller than the fileman diff would be.
- **Waiting for / copying 0422's select-menu seam** — explicitly fenced off
  by the ticket: shared TABLE SLOT, not shared implementation. The core
  select menu is content-area furniture the engine draws; a file chooser is
  frontend window furniture. Nothing to share but the struct.

## Scope calls and their price

- **Multi-select: out**, because the ENGINE models one value per file gadget
  (`form.c:664` reads one value + one rawfile; no `multiple` in the box
  model). Not a demo shortcut — the substrate lacks the vocabulary. The
  stdout protocol is newline-separated paths from day one, so the seam does
  not move when the engine grows it.
- **`accept` filter: out**, because comdlg32 has no filter UI for ANY app
  (notepad's type combo is absent for the same reason) and the engine does
  not parse the attribute. A netsurf-only filter would put the browser ahead
  of the platform's own dialog. Seam named: `--filter` argv + `lpstrFilter`.
- **Bytes-carrying POST: out to `todos/0437`** (no http fetcher — deliberate
  exclusion). The GET-form leg still proves end to end that a submit carries
  the chosen value.
- **kfs `..`**: no new handling. The dialog never emits a `..` segment
  (`fd_navigate`/`fd_up` normalise by string); a typed `..` collapses
  lexically like everywhere else in the OS.

## Notes for the implementation lane

- `gucos/` and `os/win32/` are OUTSIDE the patch fence (`pristine.json`
  names upstream trees only). The plan touches zero vendored engine files;
  if that changes, the `patches/netsurf.diff` section lands in the same
  commit (todos/0423).
- The new kernel test moves the total 133 → 134 — register it in
  `tests/kernel/run.js` and report the NEW total.
- `os/image.json` needs a `version` bump for the seeded `/usr/bin/filepick`.
- The stderr `console.log` oracle (`gui_window_console_log`,
  `gucos/gui.c:590`) is the strong assertion channel: the `input` event that
  `form_gadget_update_value` fires (`form.c:2325`) is directly observable by
  page JS.
