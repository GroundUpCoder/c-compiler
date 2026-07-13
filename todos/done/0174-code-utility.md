# 0174 — /bin/code: minimal agentic coding assistant (native-first)

- **Status**: done (2026-07-13)

## Resolution

Both legs landed. Native slice: 90b213d (code.c + build-native.sh +
os/code/test/smoke.mjs, 10/10). In-OS leg (this close):

- **Platform seam**: `run_command()` gucOS flavor under `#ifdef __MTOTS__` —
  posix_spawn of /bin/sh -c with pipe fd-actions (envp NULL = inherit),
  blocking pipe read, timeout via setitimer(ITIMER_REAL)+SIGALRM (the
  parked read EINTRs → SIGKILL the child, drain to EOF, keep the native
  contract: exit -1 + "[command killed...]" marker). Native build
  untouched — smoke.mjs stayed 10/10.
- **Seeded**: /usr/bin/code via os/code/bin.json (cJSON + the 0173 curl
  veneer lib.json); image v85 → v86.
- **Env plumbing**: pid 1 (boot.js + kernel-worker.js) and /bin/term's
  default shell spawn as LOGIN shells (argv[0] "-sh"); a default
  /etc/profile seeds via the manifest's user section. NOTE deviation from
  the plan: the seeded /etc/profile does NOT source ~/.profile — hush
  itself sources ~/.profile right after /etc/profile for login shells
  (vendor/busybox/src/shell/hush.c:10675), so doing it there would run it
  twice. ANTHROPIC_* exports go in ~/.profile.
- **Found + fixed todos/0176 (P0 miscompile)**: code.c's build_tools()
  exposed `const char *r[] = {"cmd"}` writing string BYTES into the
  pointer slot; fixed test-first in tests/unit/conformance/
  charptr_array_string_init (commits c34ef31 + 1892b48).
- **Tests**: tests/kernel/test_code_e2e.js (in the run.js manifest, IMG) —
  fake SSE server as its own process (tests/kernel/lib/fake_anthropic.js;
  driveBoot is spawnSync, an in-process server would deadlock — the
  smoke.mjs rule inverted), two boot sessions proving /etc/profile seed +
  ~/.profile login sourcing + envp flow, streamed text, write_file on
  BlockFS, bash tool with merged output + exit code, tool_result
  round-trips asserted from the server's body dump. Browser leg skipped
  (recorded: the kernel e2e is the load-bearing test; VT1 typing adds no
  coverage for the tty-only tool).
- **Live validation** (2026-07-13): DeepSeek Anthropic-compatible endpoint
  — `code -p` pong smoke AND the full acceptance ("create hello.c, compile
  with cc, run") drove write_file + bash(cc) + ./hello → "hi" in a booted
  OS; final pass against api.anthropic.com (default claude-opus-4-8) green.
  Keys read by the invoking shell from ~/.guc/creds (never by tooling).

- **Status (historical)**: open (soft-dep: 0173 for the in-OS leg; native
  leg has NO deps and is being developed first)
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
