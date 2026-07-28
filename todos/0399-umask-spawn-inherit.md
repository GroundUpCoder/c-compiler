# 0399 — umask is per-process but does not survive __spawn (POSIX inherits it)

- **Status**: open
- **Design**: this file.
- **Provenance**: fallout of `todos/0382`, which landed a real `umask(2)`. Filed in the
  same commit as the gap comment that describes it (the `LIABILITIES.md` enrolment rule).

## Goal

`umask(2)` is now real per-process state in the libc (`__posix.c`), applied by
`open(O_CREAT)`, `creat()`, `mkdir()` and `mkdirat()`. That is correct **within** a
process.

POSIX also says the mask is **inherited**: a child starts with its parent's mask. Here it
does not. Every process starts at the built-in default `022` regardless of what its parent
set, so `umask 077 && some-program-that-creates-files` still yields `0644`, and the shell's
`umask` builtin is advisory-only across a spawn boundary.

### Why this is not simply a bug in 0382

There is no `fork()` here — `todos/OS.md`'s owner-brokered `posix_spawn` model is
deliberate, and a child is a **fresh wasm instance**, not a memory copy. Inherited process
state has to be carried explicitly, and today the only carrier is `struct __spawn_spec`
(the host reads it straight out of wasm memory at spawn time). Nothing currently propagates
libc-level state across that boundary at all, so this is a new seam rather than a missed line.

## Plan

Options, not yet decided:

1. **Spec field.** Add `mode_t umask` to `__spawn_spec` under a new `__SPAWN_UMASK` flag
   (the spec-grows-by-field precedent is `trace`/`__SPAWN_TRACE`, todos/0046). The host
   would then have to hand the value to the child's libc **before `main`** — which is the
   part that does not exist yet. Cleanest, but needs a pre-main init channel.
2. **Environment carrier.** Propagate through `environ` as a reserved variable. Cheap and
   needs no host change, but it is visible to the program and to `env`, which is wrong: the
   mask is not an environment variable, and a child clearing its environment would silently
   reset it.
3. **Kernel-owned.** Make the mask a kernel object (like the tty and the fd table) read via
   an RPC at libc init. Correct for a multi-process OS and consistent with where the rest of
   inherited process state lives, but it costs an RPC per process start and does not work in
   the no-kernel standalone flavour, which would need a local fallback.

Option 3 fits the existing architecture best; option 1 is the smallest. Both need the
pre-main hook, which is the actual work.

## Acceptance

- A child spawned after `umask(077)` creates files at `0600`.
- The standalone (no-kernel) flavour keeps working, with its own documented answer.
- A test that spawns a real child and stats what it created — behaviour, not linkage.
