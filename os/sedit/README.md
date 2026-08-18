# sedit provenance and scope

`sedit` and its fixtures were independently authored for ticket #718 from the
tracked gucOS contracts and the approved independently reviewed design. The
implementation is an Apache-2.0 repository contribution under the top-level
`LICENSE`.

The styled EDIT extension in `os/win32/gucedit.h` is a private, synchronous,
same-process gucOS message ABI. It is not RichEdit, a kernel ABI, or a
cross-process wire format. `user32.c` was introduced by repository author
`josephkimgpt`; its existing notices are preserved. No ReactOS Notepad,
CodeMirror, BusyBox vi, or other editor code or fixture was copied.

The lexer is an independently authored streaming state machine based on ISO C11
lexical categories (C11 6.4). Its explicit keyword tables are language facts,
not copied implementation. It makes no typedef inference, parser, semantic,
C++, or validity claim. File hashing reuses the tracked `os/sha256.h` FIPS
180-4 implementation under its existing repository provenance.

The user-owned untracked `projects/` tree and all user-owned
`tests/browser/*sedit*` paths were excluded: they were not read, run, copied,
adopted, edited, cleaned, staged, or used to produce this implementation.

Rollback removes the image binary, Development-menu entry, `.c`/`.h`
associations and image version bump first, then this app/docs/tests. Remove the
private styled EDIT ABI only after confirming no remaining tracked consumer.
`default.gui` and `default.term` remain notepad and vi throughout.
