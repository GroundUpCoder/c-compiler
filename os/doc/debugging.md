# Debugging

## strace

The kernel brokers every syscall, so tracing needs no setup:

```
strace [-f] [-o FILE] COMMAND [ARGS...]
```

- `-f` follows spawned children; each line gets a `[pid N]` prefix.
- `-o FILE` writes the trace to FILE instead of stderr.

One line prints per syscall: `NAME(args) = result`. The trace ends with
`+++ exited with N +++` or `+++ killed by SIGX +++`. When the trace pipe
overflows, lines drop and the count is reported — the traced program is
never slowed.

Use strace first when a program fails silently: the last lines show the
failing syscall and its errno.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success. |
| 1–125 | The program's own error code. |
| 126 | Found but not runnable. |
| 127 | Command not found — check PATH, or the package is not installed. |
| 128+N | Killed by signal N (example: 137 = SIGKILL, 139 = SIGSEGV). |

`echo $?` in the shell prints the last command's code. A fresh boot's
`python` exits 127 on purpose — the message names the package to
install.

## Processes and /proc

`/proc` is a live, kernel-rendered volume in Linux format. The standard
tools work over it:

- `ps` — process list; `top` — live view.
- `pgrep NAME` / `pkill NAME` — find or kill by name.
- `free`, `uptime` — memory and uptime.
- `/proc/PID/cmdline`, `/proc/PID/status` — read them directly.

Per-process CPU time reads 0 by design.

## GUI programs without pixels

`wmctl` inspects and drives windows from the shell:

| Command | Effect |
|---|---|
| `wmctl list` | Open windows; first column is the window id (SID). |
| `wmctl wait win TITLE` | Block until a window with TITLE exists. |
| `wmctl tree` | Dump a win32 app's widgets and their live text. |
| `wmctl click "LABEL"` | Press a button by its label. |
| `wmctl shot SID FILE` | Screenshot a window (`screen` for all). |

Use `wmctl wait` in scripts instead of sleeping.

## Compiler and linker failures

Read `toolchain.md`, "Diagnostics" — the common error shapes are listed
there with their usual causes.

## What does not exist

There is no interactive debugger and no core dump. Use `printf` to
stderr, `strace`, and `cc -g` (readable function names in a crash's
stack trace).
