# #74 — gucman postinst/prerm script hatch

Slice 1 (todos/done/0261) reserved the script hatch: a control.json carrying
`postinst`/`prerm` was refused loudly. This implements it. The refusal block
becomes the validation block; the rest of the engine is unchanged.

## The five design decisions (and why)

**1. Scripts are PAYLOAD MEMBERS, not inline strings.** control.json's
`postinst`/`prerm` values are payload-relative paths (the `bin`-value shape),
e.g. `"postinst": "postinst"` → `/opt/<name>/postinst`. The alternative —
inline script text in control.json — would be a second content channel: the
bytes would bypass the tar validator, need materializing somewhere writable
outside the recorded plant to be spawnable, and bloat the manifest that
desktop-defaults and `info` read. As payload members the scripts are
sha256-verified with everything else, validated by the untouched tar rules
(nothing outside `opt/<name>/`), recorded in `files` like any plant, removed
by the normal replay — and the prerm script is guaranteed to still exist at
remove time because the payload tree IS the persistent store.

**2. Ordering in the crash-safe sequence.** postinst runs after the WHOLE
declarative plant (bin/openwith/commands/menu/fonts/srclib/seed/desktop) and
BEFORE the DB write — the script sees the package exactly as a user would.
prerm runs FIRST in remove, before any teardown, while the package is fully
intact. Crash windows: a crash after postinst but before the DB write leaves
a recordless /opt/<name>, which the next install already sweeps — the script
re-runs, so scripts must tolerate re-running (documented in the gucman.c
header). A crash after prerm leaves the DB record; re-running remove re-runs
prerm. Both windows resolve by re-running the interrupted command, which was
already the engine's contract.

**3. Failure semantics.** A failing/hung postinst ROLLS BACK the whole
install: it joins the existing plant-failure path (`fail = 1` → `gm_unwind`),
so /opt, every symlink/key/claim/menu entry, everything recorded goes, and
install exits 1 naming the script and its exit status. This keeps the DB
BINARY — record exists ⟺ package correctly installed — which the kickoff's
"record partial configuration in the DB" alternative would have broken:
gucman's whole engine (list, info, sync-defaults skip rules, remove) rests on
record-or-nothing, and adding a half-configured state would infect all of it.
There is never a partially-configured package to tell the truth about,
because one cannot come into existence. The one honest asymmetry: script side
effects OUTSIDE the recorded plant (a file written to /root) are NOT rolled
back — gucman can only unwind what it tracks. The test pins that behavior
explicitly rather than letting it look accidental. A failing prerm warns
loudly (script + status) and the removal CONTINUES, exit 0 — an unremovable
package is worse than a dirty one; blocking remove on a broken script would
hand a package author a denial-of-uninstall.

**4. What "sandboxed" honestly means: it is NOT a sandbox.** gucOS has no
sandbox primitive and the header comment says so plainly. What IS constrained:
provenance (payload sha256 against the index before extraction), a runnable
gate at BOTH ends (mkpkg refuses to build a shebang-less script; gucman
re-checks `#!`/wasm magic against the staged tree before anything publishes —
the engine never trusts a payload), a fixed contract (argv[1] = verb
"install"/"remove", cwd = /opt/<name>, env = exactly
PATH=/usr/local/bin:/bin + HOME=/root, stdio inherited so script output is
the progress UI), a wall-clock bound (120 s default; GUCMAN_SCRIPT_TIMEOUT_MS
env override is the test seam) that SIGKILLs a hung script, and exit-status
capture. The script otherwise runs with gucman's full authority — same as
any installer hook on any OS without containment.

**5. Spawn mechanism: the cmdalt.c shape.** There is no exec on this
platform; the synchronous CLI pattern is posix_spawn + reap (os/cmdalt.c),
NOT wm.c's fire-and-forget `spawn_path`. The kernel's `#!` re-dispatch
(todos/0065) runs the interpreter line, so any runnable image works, not just
/bin/sh. The one deviation from cmdalt: waitpid polls WNOHANG on a 50 ms tick
instead of blocking, because the timeout needs supervision and there is no
SIGALRM to lean on — a bounded supervision poll, not a sync primitive. The
child inherits gucman's pgroup (tty ^C reaches it) and stdio.

## Companion gates

- **mkpkg** cross-checks the named script is a FILE member of the assembled
  payload and starts with `#!`/wasm magic — a typo or shebang-less script
  fails the build, not the first install.
- **foldPackages REFUSES a script-carrying def.** A baked package never runs
  an install transaction, so folding one would ship it silently
  unconfigured. Script-carrying packages are install-only; `--packages=all`
  fat bakes fail loudly if one sneaks into the fold set.
- `packageControl` (the ONE control.json producer) passes the two keys
  through with path-shape validation, so the payload manifest and any future
  fold twin can never drift.

## Testing

`tests/kernel/test_gucman_scripts_e2e.js` (registered in tests/kernel/run.js):
host legs (mkpkg positive/negative, fold refusal through the packagesDir
seam) + one boot session over four mkpkg-built transient defs (success with
verb/cwd/DB/info assertions, exit-7 postinst → full rollback with the
outside-plant side effect deliberately pinned as KEPT, hung postinst killed
at a 2 s test-seam bound, failing prerm → loud continue) + a HAND-ROLLED
tar payload with a shebang-less postinst (mkpkg refuses to build one, so the
runtime refusal needs a payload that arrived outside the official pipeline).
Red control on unmodified main: every leg fails (packageControl drops the
keys; mkpkg/fold exit 0; the old gucman refuses the install outright).

Deliberately NOT bumped: `os/image.json` version — no baked content changed
shape-wise (gucman.c is a bake input, so test fixtures rebake off mtime; the
deployed-browser refetch bump happens at ship, the #578 precedent).
