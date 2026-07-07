# TIOCGWINSZ never crossed the brokered fs — vi was the first to ask

User noticed vi only painted an 80×24 region of a much larger xterm.
Suspects checked in order: vi's own clamp (no — caps at 4096), the page
(no — FitAddon fits at init, 'ready' posts cols/rows, DOM showed 42 real
rows), the resize plumbing (looks right: one tty SAB, same SI_* words on
both sides). Empirical probes settled it: a TIOCGWINSZ C program in the
browser OS said **80×24** while the DOM said 42 rows, and a headless
repro (`tty.resize(120, 42)` after boot, then the same probe over
`Kernel({fs})`) reproduced it — kernel-side bug.

## Root cause

`host.js __ioctl_tiocgwinsz` guarded the winsize read with
`if (self._stdinSab)`. In brokered mode the process's fs is a RemoteFS,
which **deliberately** keeps `_stdinSab` null (stdin flows via FS_READ
RPCs — "keep _stdinSab null so no ring path ever engages") and wires
ONLY `_stdinCtrl` (the winsize words of the tty SAB header). Wrong-field
guard → the 80×24 fallback always won for every brokered process, i.e.
the whole OS. Fix: guard on `_stdinCtrl` — the thing actually read.

Same class as 0010's FS_READLINK find: a path that existed but had NO
first user until now. Ring-mode pages always had `_stdinSab` set, so
`test_tty_e2e.js`'s existing winch/winsize case passed; the brokered
suite (`test_fs_e2e.js`) had never asked for the window size. Nothing
before vi cared: hush's lineedit only wants width-ish behavior it gets
from echo, ls columns come from the tty default, and the kernel e2e runs
happened to use the default 80×24 anyway.

## Discipline

Failing test first (verified red: `ws=80x24`): `test_fs_e2e.js` scenario
8 — `tty.resize(132, 43)` mid-session, TIOCGWINSZ over the brokered fs
must report it. Then the one-line fix, then all suites green.

The browser vi check in `os-boots.mjs` also got hardened while here: it
now waits for vi's status line (`- /tmp/b.txt`) before typing — the
alternate-screen escape arrives before vi has finished its first draw,
and typing into that window occasionally lost keystrokes (one observed
flake in ~5 runs); the status line proves raw mode + first paint are
done. Failure output now includes the post-exit segment.

Follow-through: vi now paints the full terminal (42 rows in the
reference page at 1024×700), and SIGWINCH-driven re-flow works end to
end — resize the window and vi redraws to the new geometry.
