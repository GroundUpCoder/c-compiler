# 0400 — directory file descriptors: O_DIRECTORY, dirfd(3), fdopendir(3) — what the *at family needs

- **Status**: open
- **Design**: this file.
- **Provenance**: surfaced while landing the `*at()` family for `todos/0325` Group B /
  `todos/0382` gaps 7-8. Filed in the same commit as the code comment that describes the
  limit (`todos/LIABILITIES.md` enrolment rule).

## Goal

**No file descriptor on this system can refer to a directory.** Three separate facts
combine to make that true:

- `BlockFS.open` answers `EISDIR` for any directory target (`host.js`), so `open("/etc",
  O_RDONLY)` fails — which POSIX actually permits for write intent but *requires to
  succeed* for `O_RDONLY`.
- There is no `O_DIRECTORY`.
- `opendir(3)` returns a `DIR *` backed by the `__opendir`/`__readdir` handle namespace,
  which is disjoint from the fd table — so there is no `dirfd(3)` to extract, and no
  `fdopendir(3)` to go the other way.

The consequence, and the reason this is filed rather than absorbed: the `*at()` family
landed with POSIX-exact behaviour for `AT_FDCWD` and absolute paths, and returns
`ENOTDIR` (or `EBADF` for a closed fd) for a real `dirfd`. Those errnos are **literally
true** for every fd this system can produce, so the family is correct rather than
stubbed — but the third resolution mode POSIX defines is unreachable, and portable code
that walks a tree with `openat`-relative descriptors (the modern default: `fts`, `find`,
libarchive's extraction, CPython's `os.*` dir_fd arguments) cannot use it.

`fchdir(2)` is absent for exactly the same reason and lands with this.

## Plan

Sketch, not a decision:

1. **`open()` on a directory.** POSIX: `O_RDONLY` on a directory succeeds; write intent is
   `EISDIR`. The one-line rejection in `BlockFS.open` becomes a mode check, and the fd
   entry gains a `dir` kind (the `dev` kind is the precedent — it already carries `inoId`
   with no data extent). `read(2)` on it must be `EISDIR`; `fstat`/`close`/`dup` already
   work off `inoId`. `O_DIRECTORY` then means "`ENOTDIR` unless it is one".
2. **The kernel side.** `FS_OPEN` already forwards to `fs.open`, so a directory fd becomes
   an ordinary `file` OFD carrying `path`. Check the paths that assume a file: `FS_READ`,
   `FS_SELECT`/`FS_WAIT` readiness, spawn fd-actions, and the `RemoteFS` sealed-`/usr`
   local-fd promotion (`RO_FD_BASE`).
3. **`dirfd`/`fdopendir`.** Either give `DIR` a real fd, or keep the handle namespace and
   have `dirfd()` open a companion fd. The former is cleaner and makes `fdopendir` trivial.
4. **Wire `__at_ok`.** With directory fds real, `__at_ok()` in `compiler.js`'s `__posix.c`
   becomes a path recovery (`fstat` says it is a directory; the OFD already stores its
   absolute `path`) and the **entire `*at` family becomes dirfd-capable with no other
   change** — that is the point of routing all ten calls through one function.
   `fchdir(fd)` falls out as `chdir(path-of-fd)`.

Note that path recovery gives the API but not `*at`'s TOCTOU guarantee. That is an
acceptable trade here (single-user, no adversary between processes) but should be written
down rather than assumed.

## Acceptance

- `open("/some/dir", O_RDONLY)` succeeds; `read()` on it is `EISDIR`; write intent is `EISDIR`.
- `O_DIRECTORY` on a non-directory is `ENOTDIR`.
- `dirfd(opendir(p))` and `fdopendir()` round-trip.
- The `*at` tests grow real-dirfd cases — the ones `tests/unit/stdlib/at_family` currently
  pins as `ENOTDIR` become working relative resolutions, and that test is the regression
  guard for the transition.
- `fchdir(2)`.
