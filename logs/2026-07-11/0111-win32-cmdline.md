# 0111 — win32 cmdline: quote every arg (abs POSIX paths vs /-options)

The openwith `default.gui → /bin/notepad` routes (fileman Open on an
unassociated extension, desktop double-click; terminal `open foo.md` goes
to `default.term`/vi by design and was never exposed) landed on an
ERROR MessageBox ("…does not exist / create?") plus an "Untitled -
Notepad" window instead of the file. 0108 saw it while realigning
test_openwith_e2e and deliberately left the check loose (guarding launch,
not load) with the fix queued here.

## Mechanism

kernel32's `proc_info_init` rebuilt `GetCommandLineW` from
`/proc/<pid>/cmdline` by space-joining argv and quoting only args WITH
SPACES. So notepad's `lpCmdLine` was the bare `/root/owtest/readme.md` —
and ReactOS `HandleCommandLine` treats a leading `/` as a Windows option
prefix: it consumed `/r`, then tried to open `oot/owtest/readme.md`,
which of course doesn't exist. Every UNICODE port that parses `/`-options
off its command line has the same exposure — a veneer-vs-POSIX-paths
convention gap, not a notepad bug.

## Fix (the todo's preferred option)

The cmdline builder now quotes EVERY arg after argv0 unconditionally
(argv0 keeps quote-only-if-spaces); embedded `"` is escaped as `\"`,
matching `cmdline_split`'s escape. Windows-canonical: a `"…"`-first arg
skips the ports' option loops, and notepad's existing quote-strip branch
(`cmdline[0] == '"'` → strip both) hands `FileExists` the real path.
No port patch needed — the alternative (dropping `/` from notepad's
option-prefix set) stays unused.

Consumer audit before flipping:

- `os/win32/wwinmain.c` already skips a *quoted* argv0 when deriving
  `lpCmdLine` — unchanged, still correct for the unquoted argv0 case.
- winmine's `wWinMain` and calc's `_tWinMain` ignore their cmdline.
- k32demo only *prints* `GetCommandLineW()` (no format assertion), and
  its CreateProcess leg feeds `cmdline_split` a caller-authored string —
  the split side is untouched; only the builder's rendering changed.
- Children spawned by CreateProcessW get a real argv via `__spawn`, and
  their own kernel32 re-renders quoting from `/proc` — round-trip safe.

`os/image.json` bumped to **v58** (kernel32.c is baked into every win32
binary).

## Test tightened

`test_openwith_e2e` default.gui leg now asserts the REAL title
(`readme.md - Notepad`, the `UpdateWindowCaption` format with
`szFileTitle` = base name) and zero windows titled `ERROR` (notepad's
error-box caption, `STRING_ERROR`) in list3 — the 0108 looseness is gone.

## Verified

- `node tests/kernel/run.js --filter=openwith` — pass with the tightened
  checks (fresh v58 bake).
- The win32-adjacent sweep — notepad/winmine/calc/kernel32/user32/gdi32/
  win32_ports/fileman/clipboard/ctxmenu/recycle — green.
- Direct terminal-spawn probe: `notepad /root/hello.md &` under boot.js
  shows `hello.md - Notepad` in `wmctl list`, no ERROR window.
- Full kernel suite green after the change.
