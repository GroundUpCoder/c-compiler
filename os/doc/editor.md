# Source Editor

`sedit` is the native single-document C source editor. Start it from the
terminal, the Development menu, or by opening a `.c` or `.h` file:

```sh
sedit game.c
sedit game.c:18
```

The optional suffix is a one-based line number. It matches gucOS `cc`
diagnostics (`FILE:LINE: error: ...` and `FILE:LINE: warning: ...`). Columns,
multi-diagnostic output, C++, project builds, and compiler-output capture are
not claimed.

The editor highlights C lexical tokens and matches `()`, `[]`, and `{}` outside
strings and comments. Ctrl+] jumps to a matching delimiter; add Shift to extend
the selection. Highlighting runs after edits in bounded deferred chunks. Text
remains editable if highlighting cannot be allocated.

## Files and saving

Only regular UTF-8/ASCII files up to 8 MiB are accepted. UTF-8 BOMs are
preserved. LF, CRLF, and CR files retain their whole-file line-ending policy.
For mixed input the editor asks for one deterministic whole-file policy before
editing; it never silently normalizes mixed input.

Save writes and fsyncs a same-directory temporary file and atomically renames
it over the physical target. Symlinks are followed and never replaced. If the
physical target changed since open, Source Editor names it and asks before
overwrite. Saving a multiply-linked inode also requires explicit permission,
because atomic replacement breaks that directory entry away from its peers.
This guarantees old-or-new complete bytes while BlockFS is live. Directory
entry persistence across a tab/power crash is not promised.

The global defaults remain unchanged: generic GUI files use notepad and
terminal files use vi. User `~/.config/openwith` rules still override baked
associations; a stale explicit `/bin/sedit` override fails loudly if the binary
is rolled back, and removing that override restores the baked/default resolver.
