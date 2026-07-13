# 0174 — /bin/code lands in gucOS (the HTTP-stack epic completes)

The three-layer HTTP epic (0172 kernel transport → 0173 libcurl veneer →
0174 /bin/code) closed today. This entry covers the in-OS leg of code.

## What shipped

- `run_command()` grew its gucOS flavor (`#ifdef __MTOTS__`): posix_spawn
  of `/bin/sh -c` with pipe fd-actions (envp NULL = kernel inherit), and
  the 120s cap via setitimer+SIGALRM — the same EINTR-a-parked-RPC
  mechanism 0173's curl timeouts use. After SIGKILLing the timed-out
  child we keep DRAINING the pipe to EOF (grandchildren may hold the
  write end); the native fork/exec/poll flavor is untouched.
- `/usr/bin/code` seeded (os/code/bin.json = code.c + vendor/cjson +
  os/curl/lib.json), image v86.
- Login shells: pid 1 (both embedders) and term's default spawn pass
  argv[0]="-sh". hush's own rule (hush.c:10523 `argv[0][0] == '-'`)
  flips OPT_login → it sources /etc/profile AND THEN ~/.profile itself
  (hush.c:10675). **So the seeded /etc/profile deliberately does NOT
  source ~/.profile** — the plan's "profile sources ~/.profile" step was
  wrong on hush and would double-run it; recorded in the item.
- test_code_e2e.js: the fake /v1/messages SSE server runs as a SEPARATE
  process (tests/kernel/lib/fake_anthropic.js) because driveBoot is
  spawnSync — the exact inverse of the smoke.mjs deadlock rule. Two
  sessions over one image prove the seed-once /etc/profile, the
  ~/.profile pickup at next login, and envp inheritance down to code.

## The detour: todos/0176

code SEGV'd in-OS with ZERO output. The bisect (cJSON alone fine, veneer
fine, then pure C) landed on `const char *r[] = {"command"}` — the
compiler's `{ "str" }` byte-copy shortcut firing for a POINTER-element
array. Fixed test-first as its own P0 (see
logs/2026-07-13/0176-charptr-array-init-bug.md). Worth remembering WHY
the whole vendor corpus never hit it: real-world string tables are
almost always multi-element, and the shortcut only pattern-matches a
single-element list.

## Live validation

Against DeepSeek's Anthropic-compatible endpoint in a real booted OS:
the acceptance prompt ("create hello.c that prints hi, compile it with
cc, run it") produced a working ./hello via write_file + bash(cc -o) —
verified by running ./hello in the same session AFTER code exited.
Final pong against api.anthropic.com (claude-opus-4-8 default; the
anthropic-dangerous-direct-browser-access header rides every request).
Secrets stayed in the invoking shell: the export line travels through
boot.js's piped stdin (piped tty runs don't echo), never through tooling.
