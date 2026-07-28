# 0397 — pbcopy and pbpaste over the kernel clipboard slot

## What landed

`/usr/bin/pbcopy` and `/usr/bin/pbpaste` are real programs in the image. They
use the macOS names for the two operations that `/bin/clip` already did:

```
cmd | pbcopy      stdin -> the clipboard
pbpaste           clipboard -> stdout
```

The clipboard is the kernel's one slot (todos/0090). All three programs write
and read that same slot. `os/image.json` is at version 190.

## The factoring

The ticket made the decision, and the code follows it. There are two new
programs, not one multi-call binary.

`os/clipio.h` holds the two operations. `clipio_set_from_fd` reads a file
descriptor to the end and puts the bytes in the slot. `clipio_get_to_file`
writes the slot to a stream. Each function returns a process exit status and
reports its own cause to stderr. A front-end's `main` is one line.

`os/clip.c`, `os/pbcopy.c` and `os/pbpaste.c` include that header. The manifest
stages the header beside each source through the existing `hdrs` field. This is
the factoring the tree already uses for `/usr/bin/open` and for `os/fileops.h`.

The manifest maps one path to one source. It has no alias mechanism. A
busybox-style `argv[0]` switch would therefore compile the same code into two
independent binaries, and the switch would be dead weight. This is the evidence
for the decision, recorded again here.

## Behaviour

`os/clip.c` keeps its contract exactly. `clip` writes the slot, `clip -o` reads
it, `clip -o` on an empty slot exits 1 and prints nothing, and any other
argument gives usage and exit 2. The test asserts all four after the refactor.

`pbpaste` on an empty slot exits 1 and prints nothing. Both new programs refuse
every argument with usage and exit 2. macOS has `-pboard` flavours. This system
has one slot, so a board selector has nothing to select. The usage string says
so. A refusal is better than silence, because a script that asks for a board it
will not get must hear about it.

## The limit that stays

The slot is `SDL_SetClipboardText`, which takes a C string. Bytes at or after a
NUL do not ride. `clipio.h` records this in a comment. It is a constraint of the
one-slot design, not a defect to repair in this ticket. A binary-safe clipboard
needs a second format on the slot. The file-list format in `os/fileops.h` is the
precedent for that work.

The test pins the limit with a negative control. It first counts the bytes the
shell feeds (3, with the NUL in the middle), then counts the bytes that come
back (1). Without the first count, a lost shell escape would look the same as
truncation.

## The test

`tests/kernel/test_pbcopy_e2e.js`, registered in `tests/kernel/run.js`. An
unregistered test was the whole defect of todos/0396, so the registration is
part of the same commit.

Session A covers the command line: the round trip, both interop directions, the
empty slot, the argument refusals, `clip`'s unchanged contract, 170 KB through
the 64 KB kernel page, the absent trailing newline, and the NUL limit.

Session B covers the graphical side. `pbcopy` feeds notepad's paste, and
notepad's Copy fills the slot that `pbpaste` reads. This proves the win32 veneer
is on the same slot, not on a parallel one.

The poll helper reads through `pbpaste`. The poll is therefore itself an
assertion that the new program sees what another process wrote.
