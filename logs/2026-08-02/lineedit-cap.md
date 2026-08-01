# #315 — in-OS line-length cap: FEATURE_EDITING_MAX_LEN 1024 → 8192

The in-OS gcode prompt (and hush, and every other busybox lineedit consumer)
silently truncated interactive input at 1023 bytes: gcode already asks
`read_line_input` for 8192 (`os/gcode/gcode.c` — `char line[8192]`), but
lineedit clamps the caller's request to `MAX_LINELEN` =
`CONFIG_FEATURE_EDITING_MAX_LEN` (`lineedit.c:2506`, upstream's own
`// FIXME: audit & improve this`), which was 1024. Native gcode reads with
`fgets(buf, 8192, stdin)`, so in-OS and native diverged — the exact class
#315 names. Nothing in `os/gcode/` needed to change; the whole fix is the
one constant.

## The value: 8192, and why

- Matches native gcode's `fgets` buffer exactly, closing the divergence the
  ticket names rather than moving it.
- Legal: lineedit's hard ceiling is `0x7ff0` (32752); 8192 sits far under it.
- The cost is heap-only. The constant has exactly TWO consumers (grepped):
  1. `hush.c:1037` `char user_input_buf[...]` — a member of `struct globals`,
     allocated via `SET_PTR_TO_GLOBALS(xzalloc(sizeof(G)))`, so **heap**:
     +7 KB per hush instance, paid once at startup.
  2. `lineedit.c:133` `MAX_LINELEN` — `match_buf = xmalloc(MAX_LINELEN *
     sizeof(int16_t))` (**heap**, transient, tab-completion only, 16 KB at
     8192), the history-line clamp at `:1547`, and the `:2506` clamp itself.
- **No stack cost**: the only stack array sized by `MAX_LINELEN` is `tbuf`
  at `lineedit.c:1424`, inside `# if ENABLE_UNICODE_SUPPORT` — and
  `autoconf.h` has `ENABLE_UNICODE_SUPPORT 0`, so it is compiled out. (The
  `buff[MAX_LINELEN]` at `:3058` is the `#ifdef TEST` self-test main, not
  shipped.)

## Two files edited BY HAND, no kconfig regeneration

The constant lives in **two** places and only one is a build input:

- `vendor/busybox/src/include/autoconf.h:442` — what every TU actually
  compiles against (via `platform.h`). Editing only `busybox.config` is a
  silent no-op.
- `vendor/busybox/busybox.config:108` — the configuration record, kept
  consistent so a future kconfig round-trip reproduces this tree.

The documented regeneration path (kconfig `conf -o`/`conf -s` in
`/tmp/busybox-1.37.0` + re-applying the two `WASM PORT` hand patches, per
`vendor/busybox/README.md`) was NOT used: that tree no longer exists, the
round-trip risks clobbering the hand patches, and this key is a bare integer
whose value nothing else in kconfig depends on — the cascade machinery buys
nothing for a one-token change. Both files were edited by hand and verified
consistent.

## Regression test + red control

New leg 1c in `tests/browser/os-gcode.mjs`: a 2072-char single-line input
delivered by the REAL paste path — `navigator.clipboard.writeText` (host
copy) → term **Ctrl+Shift+V** (`KA_PASTE`, windows keymap, `os/keys.h`) →
the CLIP_GET seam refreshes the kernel slot → `paste_clipboard` writes the
pty → lineedit raw mode — then Enter, judged by the fake SSE server seeing
the **entire** string in the new POST. The tail marker starts past byte
2000, so the assertion proves the END survived, not merely that bytes
arrived. (So the term DOES have a paste consumer — the ticket-side open
question — and the truest reproduction was usable; no typed fallback
needed.)

**Red control ran and failed correctly**: with `autoconf.h` reverted to
1024 and the image rebaked, the leg fails `head=true tail=false` — payload
reached lineedit, tail truncated, every other leg green. With 8192 the full
sweep file passes 22/22. The queue-position bump (one extra scripted
response) shifts every later `waitBodies` count by one; all downstream legs
re-verified green in the same runs.

hush re-gate: there is no hush-named suite — hush is exercised through the
kernel e2es and the browser sweep (every `os-*.mjs` that types at a shell:
os-boots, os-shell, os-term, os-gcode, …), so the standard full gate on this
lane IS the hush re-gate.

# #316 — persistent cross-run gcode history: DECLINED (decision recorded)

`SAVEHISTORY` stays off. The three ticket questions, answered against the
actual plumbing rather than in the abstract:

1. **Location/persistence**: with `SAVEHISTORY` on, hush derives
   `hist_file` from `$HISTFILE` (default `$HOME/.hush_history`,
   `hush.c:10852-10861`); `/root` is on the writable root volume, so it
   WOULD survive boots. But gcode's editor is
   `new_line_input_t(LI_DO_HISTORY)` with **no `hist_file` set**
   (`os/gcode/gcode.c:457`) — flipping the config gives gcode nothing.
   Real delivery needs gcode-side plumbing (its own file, its own
   location policy) on top of the config flip.
2. **Sharing**: hush and gcode must NOT share a file (shell commands
   leaking into model-prompt recall and vice versa — the ticket's own
   read, confirmed). So the feature also implies a naming/config decision
   per consumer, not just the flip.
3. **Privacy**: persisting model prompts to disk by default, in a
   browser-persisted OPFS image, is a real cost with no requester —
   in-session recall (64 lines, hush parity) already covers the observed
   UX need, verified by the leg-1b browser test.

Against those three costs the feature has no demand, and enabling
`SAVEHISTORY` turns on a materially larger second code path in lineedit
(`load_history`/`save_history`/atomic-rename trim, `lineedit.c:1502-1629`)
that would need its own evidence and gating. Declining is cheap to revisit:
the config is one line, and ALL of the real work (file locations, sharing
policy, gcode plumbing, tests) is unchanged whenever someone actually asks
for cross-run history. Recorded in ticket #316 so it is not rediscovered a
third time.
