# gcode band B — #302 chat-style presentation, #303 colour gating, readline

Branch `gcode-band-b`, off `origin/main` @34fefc84 (Lane A already merged).
This lane carries the whole band's single `os/image.json` bump (203 → 204):
Lane A deliberately did not bump, and the compiler ↔ image pair is a
link-time ABI, so this bump is what makes the band shippable.

## Why "#302 as filed" was a fifth of the ask

`#302` was filed as a palette ticket. jku's actual words — "the cli doesn't
look as nice as what ~/git/chat looks like" — are mostly about LAYOUT, not
colour (router-to-master note, read from `~/git/chat/src/chat/ui.py`). The
lane delivers all six pieces of chat's style:

1. **Named speaker headers, indented body.** `You:` (bold green) on its own
   line before the prompt; `gcode:` (bold cyan) before the streamed reply,
   with the body indented 2 spaces. The indent is applied to the *streamed*
   text by a tiny stateful emitter (`emit_body` tracks `at_bol`), so it stays
   an append-only byte stream — no redraw.
2. **Rule separators.** The REPL intro is framed with `====` in bold yellow
   (ui.py's info-message rules).
3. **Labelled tool blocks.** The tool line is `● <name>` in bold magenta; the
   primary argument (command/path) prints indented under it; the result is a
   bold-yellow `Result` label + a capped preview.
4. **Per-turn Cost line.** gcode held the token counters since 0174 but never
   priced them. `price_usage()` is a small USD/MTok table matched by model
   substring, with cache-write at 1.25× input and cache-read at 0.1× (the
   ephemeral-cache economics). `report_usage` prints `turn cost: $…` /
   `session cost: $…`.
5. **A real coloured diff.** `render_diff()` mirrors `diffvis.py`: a bold
   `Diff +N -M` summary, removed lines red with `-`, added green with `+`.
   Rendered for every `edit_file` — its old_string→new_string IS the change,
   so no LCS is needed.
6. **The 8 bold semantic roles** — the part the ticket already had.

### Deviations, ruled by master (not silent)

- **Did NOT copy** chat's `Text Block` / `Thinking Block (signature: …)`
  labels or its `(id: toolu_…)` echoes — the router ruled those developer
  scaffolding that make gcode *busier*, not nicer.
- **Append-only preserved.** `ui.py` redraws with `\033[H\033[J\033[3J`,
  which erases scrollback — the exact thing #301 proved gcode gets right and
  jku asked to keep. Every new line is emitted forward; there is no cursor
  motion or clear anywhere in the change. This was the single most likely way
  to fail the lane while every test passed, so it was the first constraint.

## #303 — colour gating (the filed defect: piped output embeds raw escapes)

Colour is now resolved **per stream**: `g_color` gates stdout (assistant
content), `g_color_err` gates stderr (chrome/prompt/tool lines). `--color`
forces both on; `--no-color` or a non-empty `NO_COLOR` (no-color.org) forces
both off; otherwise each defaults from `isatty()` on its own fd. The
two-flag split is what lets `gcode -p x > f` leave `f` byte-clean (stdout not
a tty) while a tty stderr still shows colour. The single-flag `C()` was
replaced by `Co()`/`Ce()`; the existing `CDIM/CCYAN/…` macros now route
through `Ce`, so all pre-existing stderr chrome gates on `g_color_err` with no
call-site churn.

## readline — busybox lineedit reused, no third editor written

Lane A's probe proved the tty raw-mode plumbing works (Up-arrow recalls at the
hush prompt). The gap was that gcode still called bare `fgets` at the prompt.
gcode now drives **the same `src/libbb/lineedit.c` hush runs**, linked via a
new `vendor/busybox/lineedit.json` (type `lib`, deps `libbb-core.json`) that
`os/gcode/bin.json` pulls in through the established `lib.json <- bin.json`
`deps` convention — exactly how gcode already links curl.

Closure notes worth keeping:
- The libbb sources reach libc through `wasm_port.h`, which remaps
  `close`/`open`/`signal`/… to `pv_*` veneers defined in
  `port/vfork_spawn.c`. That file had to join the lib. It is safe: when
  `pv_state.in_child` is 0 — always, for gcode, which never enters the
  vfork-journal region — every `pv_*` wrapper forwards straight to libc.
  `vfork_spawn.c` defines `PV_NO_INTERCEPT`, so it does not remap its own
  bodies (no recursion). `gcode.c` does **not** include `wasm_port.h`, so
  gcode's own `close`/`signal`/`posix_spawn` stay libc — the veneer touches
  only the libbb TUs.
- `gcode.c` declares only `new_line_input_t` / `read_line_input` (and the
  `DO_HISTORY` flag), NOT via `libbb.h` — including that header would drag the
  entire libbb macro world into gcode. `FAST_FUNC` is empty on this target
  (it is `regparm/stdcall` only on i386), so the thin plain declarations match
  the definitions' ABI.
- The editor runs with `DO_HISTORY` only (not `FOR_SHELL`): in-session arrow
  history + full line editing, no tab-completion callbacks to wire. History
  is in-memory (64 lines) — the same as hush; cross-run persistence would need
  busybox's `SAVEHISTORY`, which is hardcoded off in the shared `autoconf.h`
  and would change hush too, so it's left as a possible follow-up.
- Native keeps `fgets`. Native is the reference oracle, driven
  non-interactively, where lineedit would fall back to fgets anyway; the
  seam is `read_input_line()`. #305's ^C-re-prompt behaviour is preserved:
  `read_line_input` returns 0 on ^C (raw mode, ISIG cleared), and the fgets
  fallback path still consults `g_interrupted` to tell a ^C EINTR from a real
  EOF.

## Tests

- **Native oracle** (`os/gcode/test/smoke.mjs`, 22 checks): added the layout
  (header + 2-space indent), the priced Cost line, the coloured diff
  (`- OLDLINE` / `+ NEWLINE`), the isatty gate (`gcode -p hi` down a pipe has
  no `\033[`), and `--color` forcing escapes on a pipe. The last pair is the
  #303 differential: colour leaks down a pipe when forced on, and is absent
  when the gate decides. The diff/Cost/header checks are red controls by
  construction — none of those bytes existed pre-change.
- **Browser sweep** (`tests/browser/os-gcode.mjs`): leg 1's cyan check was
  **stale after #302** — it claimed "the · bash tool line, SGR 36", but the
  tool line moved to bold magenta and the cyan now comes from the `gcode:`
  speaker header. Split into an honest bold-cyan (header) check plus a new
  bold-magenta (tool line) check. Added **leg 1b**: at the `You:` prompt,
  ArrowUp recalls the prior input and Enter resubmits it — judged by the fake
  server seeing that exact text in a new POST (a term is a real pty, so
  lineedit engages raw mode; a piped stdin would fall back to fgets — the
  Lane A caveat).

## Findings surfaced, not silently fixed

- `os-gcode.mjs` header comment (lines ~21-27) still says Ctrl+C is "NOT
  asserted as an interrupt" — stale since Lane A made leg 4 judged
  (`srv.stall.closedEarly`). Left for the owning lane; noted here.
- gucOS input line length is capped at busybox's `FEATURE_EDITING_MAX_LEN`
  (1024) once lineedit engages, vs the native `fgets` 8192. A >1KB paste at
  the interactive prompt truncates in-OS. Accepted for the feature win;
  raising it means a busybox config change.
