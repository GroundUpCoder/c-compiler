# 0401 — FIFOs: mkfifo(3) and path-named rendezvous (todos/0382 gap 9)

- **Status**: open
- **Design**: this file.
- **Provenance**: `todos/0382` gap 9, carried out of the combined 0382+0325 libc lane.
  Filed in the same commit as the code comment describing the gap (`LIABILITIES.md`
  enrolment rule). **`todos/0382` stays open on this**: eight of its nine gaps shipped,
  and this is the ninth.

## Goal

`mkfifo(3)` is the one symbol from the 0382 gap list that was **deliberately NOT added**,
and the reason is the ticket's own warning, applied honestly:

> an `umask` that links and returns 0 unconditionally is worse than an absent one,
> because it silences the probe that would have caught it

A `mkfifo` that creates the inode without working FIFO semantics — or one that simply
returns `ENOSYS` — is strictly **worse than its absence**. An autoconf probe link-tests
the symbol, finds it, and sets `HAVE_MKFIFO`; the consumer then takes its FIFO path.
libarchive's `archive_write_disk` (the concrete motivating consumer, from the `todos/0350`
zip measurement) would start trying to *restore* FIFO entries from archives and fail at
run time, instead of skipping them at configure time as it does now. The absence is
currently doing useful work, so it stays until the semantics are real.

## What "real" requires

1. **The inode.** Cheap and already possible: `BlockFS` has `mknod`, and it already
   creates `S_IFCHR` device nodes (`ensureDevNodes`), so an `S_IFIFO` inode with a mode is
   a small step. `S_IFIFO`/`S_ISFIFO` are already defined in `<sys/stat.h>`.
2. **The rendezvous — the actual work.** POSIX `open()` on a FIFO blocks: `O_RDONLY`
   waits for a writer, `O_WRONLY` waits for a reader (unless `O_NONBLOCK`), and thereafter
   the pair behaves as a pipe with `EOF`/`EPIPE`/`SIGPIPE` and select/poll readiness.
   That is kernel work, not libc work. The machinery mostly exists and would be reused
   rather than invented:
   - kernel pipes already provide buffers, wait queues, `EOF`/`EPIPE`/`SIGPIPE`, and
     `FS_SELECT`/`FS_WAIT` readiness (`kernel.js`, the `PIPE_CREATE` OFD kind);
   - `AF_UNIX` sockets already provide *path-named* rendezvous (`todos/0008`), which is
     the half pipes lack.
   A FIFO is close to "a pipe whose two ends find each other by path" — so the design
   question is whether to build it as a new OFD kind or as a socket-rendezvous front end
   over the existing pipe buffer.
3. **The standalone flavour.** Processes without a kernel get in-process fs; a FIFO with
   exactly one process has degenerate but well-defined semantics that need stating rather
   than falling over.
4. **`mknod`** currently always fails (`<sys/stat.h>`); with FIFOs real it should support
   `S_IFIFO` and keep failing for device nodes.

## Acceptance

- `mkfifo(path, mode)` creates a node for which `S_ISFIFO(st.st_mode)` holds, with the
  mode masked by the process umask like every other creation call (`todos/0382`).
- Two processes rendezvous through it: a writer's bytes reach a reader opened by path.
- `open(O_RDONLY|O_NONBLOCK)` with no writer succeeds; `open(O_WRONLY|O_NONBLOCK)` with no
  reader is `ENXIO`.
- Last-writer close gives the reader `EOF`; writing with no reader gives `EPIPE` +
  `SIGPIPE`.
- A FIFO fd is selectable in `FS_SELECT`/`FS_WAIT` like a pipe.
- `tools/libcprobe/probe.js` reports `0382/9 mkfifo` PRESENT, and the probe's gap list
  goes empty.
