# #504 — gcode "cannot launch a windowed app": mechanism pinned (lane-504)

Baseline: today's `main` = `576484bf` (== `origin/main` at measurement time; the
lane's merge-base). All measurements via the fake-Anthropic scripted server +
`os/boot.js` headless sessions with `GCODE_BASH_SECS=6` (the #503 seam — same
code path as the 120 s default). Probe scripts + full outputs:
`s3://groundupcoder/gucos/504/2026-08-10/`.

**Heavy-lock / contention annotation:** every number below was taken with the
host heavy lock held by the probe's OWN boot (the boot joins the lock at
startup) and no other heavy job running. The lane waited out a concurrent
`tests/run.js kernel --filter=test_os_boot.js` gate (worktree 614-617,
pid 45053) before measuring. The in-run cap timings are tight (6016–6032 ms
against a 6 s cap), which is itself evidence the rows were not contended.

## The re-measured control matrix (probe 1 + probe 3)

Each row is one scripted `bash` tool round inside one gcode run (command
strings byte-pinned by the fake server script — unlike the ticket's rows,
which a live model transcribed).

| bash-tool command | ticket (2026-08-04) | today (576484bf) |
|---|---|---|
| `echo PROBE-ALIVE` | 2.5 s | ms, `[exit 0]` |
| `sleep 600 >/dev/null 2>&1 </dev/null &` | 3.3 s | ~40 ms, `[exit 0]` |
| `true && sleep 600 >/dev/null 2>&1 </dev/null &` | **3.5 s** | **wedges to the cap** (`[exit -1]` + honest note) |
| `cd /root && sleep 600 >/dev/null 2>&1 </dev/null &` | — | wedges to the cap |
| `cd /root/bo && ./slp >/dev/null 2>&1 </dev/null &` (cc-compiled non-SDL) | — | wedges to the cap |
| `/root/bo/slp >/dev/null 2>&1 </dev/null &` | — | ~40 ms, `[exit 0]` |
| `cd /root && winbox >/tmp/w3.log 2>&1 &` | — | wedges to the cap |
| `/root/bo/boB >/tmp/b2.log 2>&1 &` (cc-compiled SDL, simple) | — | **~40 ms, `[exit 0]`, window up** |
| `cd /root/bo && ./boB … </dev/null &` (ticket row 4 form) | no return in 200 s | wedges to the cap, **bounded + honest** |
| `winbox >/tmp/w.log 2>&1 &` (simple windowed) | — | ~22 ms, `[exit 0]`, window up |

Verdicts on the ticket:

1. **The "infinite hang" is dead** (#503 landed): every wedge is bounded at
   `bash_cap_secs()` and reports `[exit -1]` + "shell killed; processes it
   spawned may still be running" — which is TRUE (ps shows the app alive,
   `wmctl list` shows its window).
2. **The "windowed SDL app specifically" attribution is REFUTED.** The axis
   that wedges is **compound vs simple background command** — nothing else.
   A cc-compiled SDL app launched as a *simple* background command
   (`/root/bo/boB >log 2>&1 &`) returns in ~40 ms with the window up. Every
   *compound* background command wedges, including `true && sleep 600 … &` —
   the ticket's own control row that "returned in 3.5 s" on 2026-08-04. That
   row does not reproduce; the likely explanation is that the live model
   paraphrased the command (the ticket's rows were run by gcode itself; ours
   are byte-pinned).
3. The primitive the ticket asks for — "launch this and hand me back
   control" — **already exists**: a simple `&` command. What remains is the
   ergonomic trap: the natural `cd /root/bo && ./bo … &` shape costs the full
   cap (120 s default) and returns `[exit -1]` for a launch that succeeded.

## The mechanism (probe 3 + probe 5b)

`LIST &` where LIST is compound (an AND-list, brace group, subshell — anything
that is not one simple command) makes hush run the list in a background
subshell. gucOS busybox is the NOMMU config: a subshell is a **re-exec of hush
itself** (`sh -$fd:…` state serialization — visible in ps). The chain:

1. The re-exec'd wrapper inherits the parent sh's fds 1/2 — which are
   gcode `run_command`'s capture-pipe write end (dup2'd by spawn actions).
2. The tail command's redirections (`>/tmp/bo.log 2>&1 </dev/null`) are
   journaled onto the *spawned grandchild* by the vfork-on-`__spawn` shim
   (`vendor/busybox/port/vfork_spawn.c`) — they are never applied to the
   wrapper's own fd table.
3. There is no real exec on this platform (`pv_execve` = spawn + wait +
   `_exit`; its own comment: "The lingering parent is invisible to scripts" —
   invisible to scripts, but NOT to a pipe reader waiting for EOF). On real
   Linux, hush's exec-tail optimization would collapse the wrapper into the
   redirected app and close the pipe; here the wrapper survives as a waiting
   shell for the app's whole lifetime, holding the pipe write end.
4. `run_command` reads to EOF → EOF never comes → pre-#503 unbounded hang
   (the ticket), post-#503 bounded at the cap.

**The pinning experiment (probe 5b):** reproduce the pipe shape without gcode
(`sh -c 'cd /root/bo && ./slp >/dev/null 2>&1 </dev/null &' | cat &`), then
`kill` ONLY the `sh -$` wrapper (pid 10):

- pre-kill: `cat` parked (pipe held), `./slp` running, wrapper parked;
- post-kill: `cat` exits **immediately** (EOF arrived) while `./slp` (pid 11)
  is **still running**.

The wrapper — not the app — held the pipe. Windowedness never mattered; the
ticket's SDL rows wedged because `cd X && app &` is compound and its `sleep`
rows were (as measured today: mostly mis-) classified along the wrong axis.

Gotcha for future probes: `$( … )` command substitution ALSO re-execs on
NOMMU, so `ps | grep 'sh -\$'` inside a substitution sees its own transient
wrappers — select the LOWEST pid (the persistent one), not the highest.

## Fix shape (proposed to @master, not yet built)

- **A (os/gcode/gcode.c, in-lane file set): return on direct-shell exit.**
  `run_command` currently returns on pipe EOF; the direct sh exiting is the
  true "foreground work done" signal (sh waits its fg children; only
  backgrounded survivors can still hold the pipe). Both flavors already wake
  ~1/s (the #507 tick), so a `waitpid(pid, WNOHANG)` check at the loop top
  turns any backgrounded launch — compound or not — into a ≤1 s return with
  the real exit status, plus an honest note that survivors' further output is
  not captured. The 120 s-cap path remains for genuinely long foreground
  commands. Requires updating `test_gcode_timeout_e2e.js` round 3
  (`sleep 30 &` — currently pinned to `[exit -1]`, would become a fast
  `[exit 0]`, which is exactly the desired behavior).
- **B (os/gcode/GCODE.md): teach the launch idiom** — background a windowed
  app as a simple command (`./bo >/tmp/bo.log 2>&1 &` after a separate `cd`,
  or `cd X; app &` — `&` binds to the last list member), then verify via
  `wmctl shot`/inject.
- **C (vendor/busybox, OUT of lane file set): root-cause option** — an
  exec-tail path for background subshells (or closing the lingering
  `pv_execve` parent's fds after a successful spawn) would kill the
  wrapper-holds-pipe class for every pipe consumer, not just gcode. Bigger
  blast radius; needs its own ticket if wanted.

## Implementation (A + B, @master-approved; C filed separately by @master)

**A — `run_command` returns at direct-sh exit (os/gcode/gcode.c, both
flavors).** Blocking on pipe EOF was a defect in gcode's own capture logic
(@master's framing, adopted): the direct sh exiting already means the
foreground work is done — a shell waits its foreground children — so only
processes the command itself backgrounded can still hold the write end.
Both flavors now `waitpid(pid, WNOHANG)` at the existing ~1/s wake (the
#507 alarm tick in the gucOS flavor, the poll slice in the native one); on
reap they drain what is already buffered WITHOUT blocking (`select`/`poll`
with a zero timeout — EOF during the drain means survivor-free), then
return the child's real exit status. When the pipe is still held, the
result carries "[background processes spawned by this command are still
running; their further output is not captured]". The #503 cap path is
unchanged for genuinely long foreground commands, and the #510 ^C ordering
(interrupt checked before everything) is preserved. Also fixed en route:
the native flavor read `*exit_code` uninitialized in its `!= -1` guard on
every non-timeout path; it is now initialized to 0.

**B — GCODE.md launch idiom.** Background a windowed program with its
output in a log file; the tool returns at once; read the log for runtime
errors; verify with `wmctl wait win`/`shot`; `pkill` to stop. Verified
against the build: the new e2e rounds exercise exactly this recipe.

**Test (tests/kernel/test_gcode_timeout_e2e.js, edit approved).** Round 3
(`sleep 30 &`) re-pinned from "[exit -1] at the cap" to "[exit 0] + note in
~1s"; new round 5 (`cd /root && winbox >/tmp/w.log 2>&1 &` — the dogfood
shape) and round 6 (`wmctl wait win winbox && echo WIN-UP` — the early
return must not have lost the launch). The #504 checks assert on the
round's OWN tool_result: the whole-body substring check was vacuous, since
every request body accumulates the earlier rounds' results (found when the
red control's `[exit 0]` leg failed to go red).

**Red control (#97):** with the gcode.c fix stashed and the updated test in
place, the run fails 6/20 — both #504 rounds report `[exit -1]` + a cap
burn on their own tool_results — and goes 20/20 with the fix restored.
Outputs: `redcontrol-test-prefix-gcode.txt` / `green-test-postfix-gcode.txt`
in the S3 prefix. Wall time dropped 12.1 s → 7.9 s (the two reaped rounds
cost ~1 s instead of a 3 s cap each).

**image.json 249 → 250** — demanded by the persistent-browser-image gate:
`gcode.c` and `GCODE.md` are baked sources, and a persistent OPFS image
only re-fetches on a version bump.

**Gate (host + kernel + sweep per `--diff origin/main --dry-run`;
artifact dirs deleted before the first run; all foreground, `--filter`
batches, zero resumed):**

- host: pass, 97.6 s, exit 0.
- kernel: 170P/0F/0S, `files {total:171, executed:34(+136 carried from this
  gate's own 4 earlier batches), resumed:0, recorded:170}`, 5 runs. The one
  unrecorded member is `test_os_boot.js` — ticket #627 (needs ~730 s
  against the 600 s tool cap), pre-declared by @master as expected and
  handled by them.
- sweep: 59P/0F/0S, `files {total:59, executed:15(+44 carried from this
  gate's own 3 earlier batches), resumed:0, recorded:59}`, 4 runs,
  ~1268 s of real execution across the batches.

Bake gotcha that cost ~20 min of confused slow boots: a plain
`node tools/mkimage.js` bakes the MINIMAL image (package set `[]`), so
every subsequent test boot silently re-baked the FAT image in-worker
(~3.5 min each). The refresh a test tree wants is
`node tools/mkimage.js --packages=all`.
