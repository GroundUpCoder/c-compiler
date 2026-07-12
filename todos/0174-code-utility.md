# 0174 — /bin/code: minimal agentic coding assistant (native-first)

- **Status**: open (soft-dep: 0173 for the in-OS leg; native leg has NO deps
  and is being developed first)
- **Design**: logs/2026-07-13/0172-http-stack-plan.md; source lives at
  os/code/code.c (single file, dual-target)

## Goal

A bundled `code` tool: a line-oriented agentic coding assistant speaking the
Anthropic Messages API (streaming SSE, tool use) — no fullscreen ANSI, just
SGR colors, so it works identically on VT1 and over a pty in /bin/term.
Enough tools to explore, make, and edit; every tool result hard-capped so
contexts don't explode on large files or large shell output.

Primary dev/test backend: **DeepSeek's Anthropic-compatible endpoint**
(`ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`, verified live
2026-07-13 — proper Anthropic error envelopes). Final validation pass against
the real Anthropic API before calling it done. Deterministic CI never touches
the network: a scripted fake `/v1/messages` SSE server (os/code/test/).

## Shape (v1)

- **Tools**: `bash` (spawn `/bin/sh -c`, stdout+stderr merged, output cap +
  timeout + kill), `read_file` (line offset/limit + byte cap, truncation
  markers), `write_file`, `edit_file` (unique-string replace; 0 or >1
  occurrences = error), `list_dir` (capped). grep/find/etc. ride the bash
  tool.
- **Loop**: manual agentic loop; stream `text_delta` to stdout as it
  arrives; accumulate `tool_use` via `input_json_delta`; execute; append
  `tool_result`s; repeat until `end_turn` (max-turns cap). Handles
  `pause_turn` (re-send) and `refusal` (notice, stop).
- **Env/flags**: `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` (Bearer),
  `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL`; flags `-p` (one-shot print mode —
  also the test entry point), `--model`, `--system-prompt`, `--max-turns`,
  `--max-tokens`, `--verbose`, `--no-color`. Interactive mode is a plain
  line REPL (tty line discipline provides editing) with /clear, /quit.
- **JSON**: vendor/cjson (pinned; ILP32-clean).
- **Transport**: libcurl easy interface only — builds native (clang
  -lcurl, macOS SDK libcurl) today; builds for gucOS against the 0173
  veneer unchanged. The ONE platform seam is process spawning for the bash
  tool (fork/exec native vs posix_spawn/__spawn in-OS), behind
  `run_command()`.
- **Caps** (constants at top of code.c): file read 48KB / 2000 lines
  default, bash output 24KB, bash timeout 120s, list_dir 500 entries,
  whole-file load 4MB.

## Plan

1. ✔ native-first code.c + build-native.sh + fake-server test (this item's
   opening commit; developed and green on macOS with clang+libcurl).
2. Live smoke vs DeepSeek (user-run: key stays in ~/.guc/creds, exported by
   the invoking shell).
3. After 0173: gucOS seam (posix_spawn run_command), bin.json + image.json
   entries (bump image version), openwith/menu not needed (tty tool).
4. hush env plumbing so `code` finds its config in-OS: spawn pid-1 and term
   shells as LOGIN shells (`argv[0] = "-sh"` — hush sources /etc/profile
   only when login, vendor/busybox/src/shell/hush.c:10667), seed a default
   /etc/profile (user section — writable root volume; sources ~/.profile)
   where ANTHROPIC_* exports live. envp already flows through spawn.
5. `tests/kernel/test_code_e2e.js` against the fake server + RULES entry;
   native smoke stays runnable standalone (os/code/test/smoke.mjs).
6. Final pass against api.anthropic.com (browser flavor needs the
   `anthropic-dangerous-direct-browser-access: true` header — CORS
   preflight verified allowed 2026-07-13).

## Acceptance

- Native: smoke.mjs green (text turn, tool-use turn round-trip, truncation
  markers on oversized outputs, non-zero exit surfaced, API-error handling).
- In-OS: same smoke via test_code_e2e.js on the fake server; interactively
  usable at the hush prompt and in a term window against DeepSeek.
- A fresh boot with ANTHROPIC_* set in ~/.profile can `code -p "create
  hello.c that prints hi, compile it with cc, run it"` and get a working
  binary.
