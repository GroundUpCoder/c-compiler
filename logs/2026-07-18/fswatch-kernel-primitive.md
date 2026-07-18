# FS_WATCH — the kernel file-watch primitive + its first two consumers (ticket #75, todos/0264)

The ask was the clean general primitive — explicitly not a throwaway mtime
poll, explicitly fixing inotify's rename-over-save trap — plus two real
consumers (mgp live-reload, fileman auto-refresh = the deferred 0123). The
design came pre-made from a dedicated study thread (gucos 019f7067:
inotify/kqueue/FSEvents post-mortem → a path-keyed recommendation grounded
in this kernel's actual choke points); this log records what implementation
added, changed, or discovered.

## Why gucOS gets to cheat (the design's core, held up in practice)

Every runtime fs mutation flows through ONE dispatch (`_fsRpc`) in ONE
kernel with the path present as a string. So watches key on **paths**, not
inodes: events carry names, a rename is one RPC in → one record out (both
names — no IN_MOVED_FROM/TO cookie pairing), and the editor atomic-save
(write tmp, rename onto the target) lands `FSW_CLOSE_WRITE` on the watched
path with the watch **surviving** — the single worst practical inotify trap
is structurally absent. Delivery is the existing OFD machinery: a `'watch'`
OFD readable in `_selectScan`, drained by ordinary FS_READ (EAGAIN when dry
— WAIT-first contract), killed by ordinary close. Zero new blocking
mechanism; the 0178 unified WAIT serves watch fds like any other.

The settled write has two feeders: a dirty open-file-description's LAST
release (`_ofdUnref` — dup/spawn-inherited fds can't fire premature
settles; O_TRUNC and creat count as dirty so `echo -n > file` settles),
and rename-onto (a rename publishes complete content by definition).
Overflow policy: clear + latch a single FSW_OVERFLOW — survivors after a
loss would be a plausible-looking lie, and the kernel NEVER blocks a
mutating RPC on a slow watcher (the strace 0046 rule). FSW_MODIFY exists
but is opt-in; the default mask is the settled set, inverting inotify's
IN_MODIFY-looks-right trap. FSWF_RECURSIVE is reserved+spec'd (a prefix
compare at the choke — cheap precisely because keys are strings), EINVAL
until a consumer exists.

## The one design deviation: lexical canonicalization

The design assumed symlink-resolving canonicalization at watch/emit time.
The fs surface has no physical resolver — `_resolvePath` is LEXICAL
(cwd-join + dot-collapse), the very todos/0263 realpath limitation. Rather
than build a resolver inside this ticket, watches key on the
lexically-canonical path: cheap (string ops, no fs walk per mutation), and
correct for every path-consistent consumer. The residual — a write through
a symlink/hardlink ALIAS attributes to the alias's path — joins the
design's own documented hardlink residual, and `_watchCanon` is the ONE
seam to upgrade when 0263 lands a physical resolver. Documented in
fswatch.h, KERNEL.md, and the 0264 item.

## Consumers

**mgp**: turned out upstream mgp ALREADY auto-reloads — `wantreload()` is
a per-idle-tick `stat()` ctime poll, and in this port ambient
SDL_EVENT_WINDOW_EXPOSED events feed an UNGATED reload path, so the naive
"add a watch, keep the poll" wiring was cosmetically redundant (and made a
consumer red→green undemonstrable — the first "red" run passed). The right
move per the ticket's own scrub directive (no mtime polls): the watch fd
is now `wantreload()`'s ONE source — the ctime poll and `srctimestamp` are
deleted, every upstream call site (idle tick, Expose, ConfigureNotify)
reacts to the drain, and `sdlx_wait_event_fd` composes the fd into the
settled-page park so a save WAKES the viewer instead of waiting out the 2s
cadence. `-R` now means "no watch opened".

**fileman** (0123 closed): a general user32 seam, not a fileman hack —
`RegisterFdWake(hwnd, fd, msg)` registers never-blocking fds into
GetMessage's unified WAIT; on an fd wake user32 drains them raw (read to
EAGAIN — format-agnostic, and the drain is what keeps the loop spin-free:
an undrained level-readable fd would turn every park into an immediate
return) and posts one message per readable episode. fileman's `watch_cwd`
re-arms per navigation; WM_FSCHANGE refills with the selection carried by
NAME (0123's rule — indexes shift under external churn).

## Found along the way (fixed here)

`newestBakeInput` didn't include packaged apps' project sources: since the
0262 split moved mgp/quake/etc out of image.json into packages/*.json, the
staleness scan walked the package *definitions* but never their
`files[].project` closures — an mgp.c edit left a fat fixture "fresh"
(surfaced by the consumer red run booting a wired image after a stash).
Fixed in os-common.js: package files' projects/bins are scanned like
manifest entries, unconditionally (over-invalidating a minimal bake is the
cheap direction).

## Tests

- `test_fswatch_e2e.js` (26 checks; red = instantiation fails on the old
  tree, demonstrated by stash): TWO real C processes — the watcher and a
  separate mutator — so every event crosses the process boundary through
  the RPC choke. Settle-on-close, FS_WAIT park wake, the headline
  rename-over settle, EAGAIN, SELF_GONE + re-arm across recreate,
  dir-watch names, the one-record rename ("a.txt\0b.txt" verified
  byte-wise), zero-write O_TRUNC settle, overflow → one record → EAGAIN
  with the spamming writer exiting 0, MODIFY opt-in, EINVAL/ENOENT.
  Deterministic: mutator legs run to waitpid before draining — no sleeps.
- `test_mgp_livereload_e2e.js`: background-color swaps prove WHICH deck
  rendered (MidnightBlue → DarkGreen via tmp+mv, → DarkSlateGray via
  truncate-rewrite), on page 1 of a 2-page deck.
- `test_fileman_watch_e2e.js` (red on the unwired tree: the unprompted-row
  wait times out loud): external create/rename-over/delete refresh with no
  keystroke, marker-based waits only (listbox text, status-bar counts);
  selection survival asserted via the Del confirm still naming the
  pre-change selection; navigation re-arm leg.

Gotcha for future fileman tests: `wmctl wait text LISTBOX:n` addresses the
n-th LISTBOX *control* (its text is ALL rows joined) — not row n. And
`wmctl tree` output starts with `== pid N`, which terminates a
`section()` slice immediately — don't wrap trees in `==marker` sections;
wait on the specific control's text instead.
