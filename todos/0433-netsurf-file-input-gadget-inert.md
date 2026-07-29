# 0433 — netsurf: <input type=file> is inert (file_gadget_open unset)

- **Status**: open
- **Design**: design pass, 2026-07-30

## Goal

A click on `<input type="file">` in the gucOS browser does nothing, so no page that
uploads a file is usable.

`todos/0422` diagnosed this while it diagnosed the dead `<select>` menu. The two faults
have the same shape and the same cause, but they do NOT have the same fix. A gadget click
sends `CONTENT_MSG_GADGETCLICK`, which `browser_window.c` routes to
`guit->window->file_gadget_open`. The gucOS window table (`vendor/netsurf/gucos/gui.c`)
does not supply that entry, so `gui_factory.c` installs its empty default and the click
ends there.

## Plan

1. Confirm the diagnosis still holds at HEAD. Read the gucOS window table and
   `gui_factory.c`, and check that `file_gadget_open` is still unset.
2. Design the file dialogue. This is the part `todos/0422` deliberately did not do.
   A file gadget needs a file CHOOSER, which is frontend window furniture, not a content
   popup. Decide what that dialogue is in gucOS: how it lists a directory, how it reads
   the selection back, and which kfs path it starts from.
3. Supply `file_gadget_open` in the gucOS window table and return the chosen path to the
   engine.
4. Cover it: open the dialogue, choose a file, cancel the dialogue, and submit a form that
   carries the chosen file.

## Notes

`todos/0422` takes the CORE select menu (`core_select_menu` in
`vendor/netsurf/gucos/options.h`), so it never supplies a window-table entry at all. The
apparent shared seam between the select menu and the file gadget is a shared TABLE SLOT,
not a shared implementation. Do not wait for 0422 and do not copy its approach.

Any edit to a vendored engine file must land in `vendor/netsurf/patches/` in the same
commit — see `todos/0423`.

## Acceptance

- A click on `<input type="file">` opens a file dialogue.
- Choosing a file sets the gadget's displayed value, and submitting the form carries it.
- Cancelling the dialogue leaves the gadget unchanged.

## Design

Design pass 2026-07-30, at `e99b2ec4`. Steps 1 and 2 of the Plan. The dev log
(`logs/2026-07-30/0433-file-dialogue-design.md`) holds the rejected
alternatives and the full rationale.

### Step 1 — the diagnosis holds at HEAD

- `vendor/netsurf/gucos/gui.c:673-696` — `window_table` has no
  `.file_gadget_open` member.
- `vendor/netsurf/netsurf/desktop/gui_factory.c:191-192` — the factory installs
  `gui_default_window_file_gadget_open`; its body (`gui_factory.c:102-106`) is
  empty.
- `vendor/netsurf/netsurf/desktop/browser_window.c:1762-1769` —
  `CONTENT_MSG_GADGETCLICK` on a `GADGET_FILE` gadget calls
  `guit->window->file_gadget_open(root->window, c, gadget)`.
- `vendor/netsurf/netsurf/content/handlers/html/interaction.c:992-1000` — a
  button-1 click on the gadget broadcasts `CONTENT_MSG_GADGETCLICK`.

The click path is live and ends in the empty default. The diagnosis holds.

### The decision — an out-of-process picker

The dialogue is `/bin/filepick`, a new small win32 app. It calls
`GetOpenFileNameW` (`os/win32/comdlg32.c:279` `file_dialog`, `:371` the export)
and prints the accepted path on stdout. The netsurf frontend spawns it, keeps
its own loop live, and applies the result when the child exits.

The reused mechanism is the comdlg32 file dialog — the platform's ONE file
chooser. notepad, paint and sameboy already open files through it, and three
kernel e2e tests already drive it by label (`test_notepad_e2e.js`,
`test_paint_e2e.js`, `test_sameboy_e2e.js`). This design adds no second
dialogue implementation: `filepick.c` is an argv shell around one
`GetOpenFileNameW` call (template: `vendor/sameboy/src/main.c:440`).

The picker is a separate process because netsurf is an SDL-native app and the
win32 veneer cannot share its process:

- `pump_sdl` (`os/win32/user32.c:1759`) drains the one process SDL queue. It
  drops mouse and window events whose windowID it does not map, and it routes
  unmapped key events to `g_activeTop` (`user32.c:1766`). An in-process modal
  pump would eat the browser window's resize and expose events and misroute
  its keys.
- The engine stalls inside a modal callback. `gucos_run`
  (`vendor/netsurf/gucos/main.c:246`) fires the scheduled callbacks that carry
  every fetch and layout step. A nested pump starves them for the dialogue's
  whole life.
- A part-time user32 process leaves `/run/win32/agent.<pid>.sock` behind,
  bound but unserved, after the dialogue closes. A later connector hangs.
- Process-per-task is the platform's model. As its own process the picker is a
  full win32 app: it serves its own agent socket for its lifetime, so `wmctl`
  drives it with the existing comdlg32 vocabulary, and a picker crash cannot
  take the browser.

The trade is that the kernel does not enforce modality. The frontend enforces
it: one picker per `gui_window`, and a gadget click while the picker lives is
ignored (the Windows behaviour for a second click under an open dialogue).

### The protocol

- Spawn: `/bin/filepick --title "File Upload" --dir DIR`, stdout on a pipe.
- Accept: one absolute path plus `\n` on fd 1, exit 0.
- Cancel: no output, exit 1. A crash or a signal death counts as cancel.
- The stream is newline-separated paths. Version 1 emits one line. A future
  multi-select emits N lines with no protocol change.

### Frontend plumbing (`gucos/gui.c`, `gui.h`, `main.c`)

- `window_table` gains `.file_gadget_open = gui_window_file_gadget_open`.
- The handler: if `gw->picker_pid` is live, ignore the click. Else `pipe(2)`,
  `posix_spawn` with the write end dup2-ed to fd 1, and record
  `{pid, read fd, hl, gadget}` on the `struct gui_window`. Retain `hl` with
  `hlcache_handle_retain`.
- A SIGCHLD handler sets a flag — term's flag-then-park pattern
  (`test_wait_e2e.js`); the kernel WAIT wakes on a pending signal, so the
  `SDL_WaitEventTimeout` park in `gucos_run` is gap-free.
- Each loop pass calls `gucos_pickers_poll()`: `waitpid(pid, WNOHANG)` per
  live picker; on exit, read the pipe to EOF, close it, and release the state.
- Liveness proof before the result applies:
  1. The `gui_window` is still on `window_list` (`gui_window_destroy` reaps
     its picker first, so this holds structurally).
  2. `browser_window_get_content(gw->bw)` still equals the retained `hl`
     (public, `include/netsurf/browser_window.h:296`). Navigation replaced
     the content → drop the result silently.
  3. Re-conversion cannot dangle the gadget: form controls are cached per
     (content, node) on the `html_content`
     (`content/handlers/html/forms.c:545` — "Step one" returns the existing
     control), and the retain keeps that content alive. The pointer is valid
     while check 2 passes.
- Apply: `browser_window_set_gadget_filename(gw->bw, gadget, path)`. The
  engine sets `gadget->value` (drawn by `html_redraw_file`), stores the raw
  path as DOM node user data (`html.c:2213-2221`), redraws the box, and fires
  the JS `input` event (`form.c:2325`).
- `gui_window_destroy`: `kill(SIGTERM)` the picker, `waitpid`, close the fd,
  release `hl`.
- Cancel leaves everything untouched: no engine call, no event, the gadget
  keeps its value.

### The start directory

The first open starts at `$HOME` (`/root` — the user's writable territory;
`/usr` is sealed). Later opens start at the directory of the last accepted
pick, held in one frontend static — the Windows rule. The dialogue never sends
a `..` segment to the engine: `fd_navigate`/`fd_up`
(`os/win32/comdlg32.c:136,147`) normalise by string, and a typed path that
contains `..` collapses lexically in kfs exactly as it does in fileman's path
box (the `todos/0135` rule). No new handling is needed.

### The listing (inherited from comdlg32, tested under todos/0255)

`os/listdir.h` `list_dir`; directories first, then files, each name-sorted
(`fd_entcmp`, `comdlg32.c:90`). Directories carry a trailing `/`; `../` is the
first row. An unreadable directory shows the "(cannot open directory)" row, an
allocation failure shows its own row, a listing past 512 entries shows
"(N more entries not shown)", and an empty directory shows only `../`. A path
longer than the read-only Directory field clips; the gadget's own display
clips at its box edge. All of this ships today and none of it changes.

### Failure cases

- A typed name that names no file: `OFN_FILEMUSTEXIST` refuses with a
  "File not found." box and the dialogue stays open (`comdlg32.c:186`).
- `/bin/filepick` missing or the spawn fails: log at ERROR and treat as
  cancel. The binary is baked, so absence is an image bug — loud in the log,
  no fallback UI.
- A path past the `lpstrFile` capacity: comdlg32 returns FALSE
  (`FNERR_BUFFERTOOSMALL`), which reads as cancel. filepick sizes the buffer
  at `PATH_MAX`.

### Scope decisions, priced

- **Multiple selection: out.** The engine models one value per `GADGET_FILE`
  (`form.c:664` `form_dom_to_data_input_file` reads one value and one
  `rawfile`; the box model has no `multiple` support). The stdout protocol
  already carries N lines, so the frontend seam does not move when the engine
  grows it. The price today is zero: the engine cannot consume a second path.
- **The `accept` filter: out.** The engine does not parse `accept`
  (`form_internal.h` has no field for it). The frontend could read the
  attribute from `gadget->node`, but comdlg32 has no filter UI for any app —
  notepad's file-type combo is absent for the same reason. This is a
  platform-wide comdlg32 gap, not a cut in this ticket. The seam when it
  lands: a `--filter` argv plus `lpstrFilter`.
- **A typed path: in.** The comdlg32 name field accepts absolute paths — free.
- **A multipart POST that carries the file BYTES: blocked on `todos/0437`.**
  The gucOS build registers no http fetcher (a deliberate exclusion,
  `vendor/netsurf/README.md`). The engine builds the multipart list with
  `rawfile` set either way; only a network fetcher can read the file and send
  it. The reachable half of acceptance line 2 — the submitted form data
  carries the gadget value — tests through a GET form (below).

### Implementation plan (Plan steps 3-4, concrete)

Files to edit or add:

1. `os/win32/filepick.c` + `os/win32/filepick.json` — the picker app.
2. `os/image.json` — seed `/usr/bin/filepick`, and bump `version` (a new
   seeded binary; a persistent browser image re-fetches only on a bump).
3. `vendor/netsurf/gucos/gui.h` — picker fields on `struct gui_window`;
   `gucos_pickers_poll` declaration.
4. `vendor/netsurf/gucos/gui.c` — the table entry, the handler, the poll, the
   destroy teardown.
5. `vendor/netsurf/gucos/main.c` — the SIGCHLD flag and the poll call in
   `gucos_run`.
6. `vendor/netsurf/test/file-input.html` (+ a `file-input-result.html` for the
   GET-submit leg).
7. `tests/kernel/test_netsurf_filegadget_e2e.js` + its registry line in
   `tests/kernel/run.js`.

`gucos/` and `os/win32/` sit outside the patch fence — `patches/pristine.json`
names the upstream trees only. The plan touches no vendored engine file. If
the implementation must touch one, the matching `patches/netsurf.diff` section
lands in the SAME commit (`todos/0423`; the pre-commit hook runs
`patchcheck.mjs --staged` and it tells the truth).

⚠ The new test file moves the kernel total from 133 to 134. Register it in
`tests/kernel/run.js` and report the NEW total — a 133 pass means the new test
did not run.

### Test plan (the four coverage cases)

Home: the kernel suite, in the `test_netsurf_*_e2e` family. Oracle: page-JS
`console.log` lines reach netsurf's stderr through `gui_window_console_log`
(`gucos/gui.c:590`; precedent `test_netsurf_console_e2e.js`). The dialogue is
driven by its own agent socket with the comdlg32 `wmctl` vocabulary.

1. **Open** — click the gadget box (content-coordinate injection, the
   `test_netsurf_select_e2e.js` pattern); wait for the picker window to
   appear.
2. **Choose** — `wmctl settext` the name field, `wmctl click "Open"`; wait for
   the page's `input`-listener marker `VALUE:/root/up.txt` on stderr.
3. **Cancel** — open again; `wmctl click "Cancel"`; wait on a window-absence
   condition (absence conditions succeed on absence, never on the clock);
   then choose a real file and assert exactly the one later marker — the
   earlier cancel provably fired no event.
4. **Submit** — the form is `method=GET`; the action page logs
   `location.search`; assert the query marker carries the encoded path. The
   bytes-carrying POST stays with `todos/0437`.

No browser-sweep leg: the change adds no compositor or pixel behaviour, and
the dialogue app class is already swept elsewhere. That omission is a
decision, not a miss.

### Difficulty

`P2 / medium` confirmed — a ~100-line app that reuses comdlg32 wholesale,
~150 lines of frontend plumbing, one kernel e2e, no engine patch. No
`set-difficulty` change.
