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
