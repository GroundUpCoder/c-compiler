# 0338 — command alternatives — a base-image dispatcher for switchable command defaults (python first)

- **Status**: DONE (2026-07-28, image v179) — see the closeout at the end
- **Design**: `todos/COMMAND-ALTERNATIVES.md` (the full design pass — store,
  resolution, signal policy, the release-atomicity analysis; read it first),
  `os/cfgstore.h` (the three-layer overlay this reuses), `os/openwith.h` (the
  precedent this is analogous to), the meta decider note
  `fable-decider-python-primary-2026-07-27.md` §*jku OVERRIDE of D4/D6* (the
  ruling)
- **Interlocks**: `todos/0130` (the control-panel picker — **un-deferred by this
  item**), `packages/micropython.json` (§ *Release atomicity*, below — the edit
  is NOT optional and NOT separable)

## Goal

Bare `python` becomes a base-image binary that forwards every argument to
whichever implementation the user has picked, erroring with an install hint when
none is present, switchable in the control panel — jku's ruling of 2026-07-27,
which supersedes decider verdicts D4 and D6.

Built as the **generic** mechanism: `/usr/bin/cmdalt`, a multicall dispatcher
keyed by `basename(argv[0])` over a fourth `cfgstore.h` store. `python` is its
first user; a second user costs one `link` line in `os/image.json` and one baked
store line, no code. A python-special-cased implementation does not satisfy this
ticket.

## Plan

The design doc has the detail; this is the work list.

1. **`os/cmdalt.h` + `os/cmdalt.c` → `/usr/bin/cmdalt`.**
   - Dispatch mode (any `argv[0]` basename but `cmdalt`): resolve the key,
     `posix_spawn` the resolved program with `[value words…, argv[1:]…]`,
     `waitpid` with the `EINTR` loop, exit `WEXITSTATUS` / `128+WTERMSIG` /
     127 — the `pv_execve` contract (`vendor/busybox/port/vfork_spawn.c:207-225`;
     **there is no exec on this platform** — `execve` returns -1).
   - Signal policy per the design's table: `SIG_IGN` for `SIGINT`/`SIGQUIT`
     (the pgroup already delivered them; the default disposition orphans a
     REPL that survives `^C`), forward `SIGTERM`/`SIGHUP`, default `SIGTSTP`.
   - Self-dispatch guard: `st_dev`/`st_ino` of the resolved program vs
     `/usr/bin/cmdalt` — refuse loudly. One check kills every cycle.
   - Admin mode (`argv[0]` basename is `cmdalt`): `list`, `which <name>`,
     `set <name> <cmd…>`, `reset <name>`. Keeping the CLI under its own name is
     what makes `python --help` un-interceptable — do not add flags to dispatch
     mode.
2. **`os/cfgstore.h`**: `cfg_unset` (user-layer delta delete), `cfg_each` (all
   lines for a key, layer order), and the `ow_build` splitter hoisted to
   `cfg_split_argv`/`cfg_resolve_prog` with `ow_build` as an `n = 1` wrapper.
   `tests/kernel/test_openwith_e2e.js` must stay green — if the hoist is not
   obviously behavior-preserving, duplicate the splitter and say so in the
   header.
3. **Package claims**: `commands` control key (`{"python": "micropython"}`) —
   one line in `os/os-common.js` `packageControl`, plant/remove in
   `os/gucman/gucman.c` (**append** a key+value line to `/etc/cmdalt`, remove
   exactly that line; not `gm_openwith_set`'s replace-by-key shape).
4. **Manifest** (master's file — coordinate, do not edit unasked):
   `/usr/bin/cmdalt` `c` entry, `/usr/bin/python` `link` entry, baked
   `/usr/share/cmdalt` with `python<TAB>python-clang` as the **suggestion**
   (jku's lean names python-clang for the no-install hint; which implementation
   is the default once several ship is a store value, never code), and an image
   version bump.
5. **`packages/micropython.json`**: drop the `python` bin alias, add the
   `commands` claim. See below — same commit.
6. **`todos/0130` picker leg**: the commands list + candidate list + Set /
   Use-default + the shadow warning. `0130`'s file-association half stays
   `0130`'s.
7. **Tests**: `tests/kernel/test_cmdalt_e2e.js` (the 9 legs in the design's
   Acceptance section — the mechanism legs use base-image binaries only and run
   on a `--packages=none` boot), plus the `test_ctlpanel_e2e.js` picker leg. No
   new `tests/run.js` RULES entry: `^os/` and `^packages/` already map these
   paths (verified against `tests/run.js:105-146`).

## Release atomicity — read this before starting

**Steps 4 and 5 must land in the SAME COMMIT.** `foldPackages` plants package
bins at `/usr/bin/<cmd>` and `claim` throws on a duplicate path
(`os/os-common.js:1021-1025`), so the instant `/usr/bin/python` enters
`os/image.json`, every `--packages=all` bake — mkimage, `image-fixture.js`,
`serve.js`, `boot.js` — dies with *"package 'micropython': /usr/bin/python
conflicts with an existing image entry"*. That is the build enforcing the
interlock, and it is the good case.

The kickoff's framing that `gucman.c:976-980` would refuse the install is
**wrong** and must not be relied on: gucman plants `/usr/local/bin/<cmd>`, the
dispatcher lives at `/usr/bin/<cmd>`, different paths, the guard never fires.
The runtime failure is a silent **PATH shadow** (`PATH=/usr/local/bin:/bin`).

**The case nobody will test**: a box that already installed micropython keeps
`/usr/local/bin/python` forever — `/usr/local` → `/var/local` is user territory
that an image upgrade never writes, and `cmd_install` has no upgrade path
(`gucman.c:1264-1278` prints "already installed" and returns 0). The symptom is
invisible today (same binary either way) and appears later as *"switching the
default in the control panel does nothing"*. Migration is `gucman remove
micropython && gucman install micropython` (remove replays the DB's `symlinks`
list). This ticket owes three diagnostics, not a repair: `cmdalt which` naming
the shadowing path, `cmdalt list` marking shadowed keys, and the `0130` picker
showing the warning + the fix on the exact screen the confused user is on.

`packages/micropython.json` is owned by another lane as of 2026-07-27 — master
sequences step 5, but it cannot be dropped or deferred out of the commit.

## Acceptance

- `python` with nothing installed exits 127 with *"no python implementation is
  installed"* and a `gucman install python-clang` hint.
- With micropython installed, `python foo.py a b` runs it with `sys.argv`
  intact and the exit status propagated; `#!/bin/python` scripts work.
- `cmdalt set python <other>` switches it; the control-panel picker does the
  same thing through the same store; `cmdalt reset python` reverts.
- A second dispatched name needs no C change — demonstrated by a test leg that
  dispatches a non-python name.
- `cmdalt which python` names a shadowing `/usr/local/bin/python` when present.
- `node tests/run.js --diff` green (kernel + sweep + host + todos); the fat bake
  builds, which by construction proves step 5 landed with step 4.

## Closeout (2026-07-28)

Landed on `0338-dispatcher`, one commit — steps 4 and 5 together, as the
release-atomicity section requires. `os/image.json` is at `"version": 179`.

Shipped: `os/cmdalt.c` + `os/cmdalt.h` -> `/usr/bin/cmdalt`; `cfg_unset` /
`cfg_each` / `cfg_keys` / `cfg_walk` / `cfg_path_find` / `cfg_split_argv` /
`cfg_resolve_prog` in `os/cfgstore.h` with `ow_build` as the `reserve = 1`
wrapper; the `commands` package-control key end to end (`packageControl`,
`foldPackages` splicing folded claims AHEAD of the baked body, `tools/mkpkg.js`
validation, gucman plant/record/remove/unwind/info); the manifest entries +
baked `/usr/share/cmdalt`; `packages/micropython.json` trading its `python`
`bin` alias for a `commands` claim; the Default Programs applet in
`os/win32/ctlpanel.c`; `tests/kernel/test_cmdalt_e2e.js` (46 checks) and the
`test_ctlpanel_e2e.js` picker legs.

Three additions beyond the work list, each with its reason:

1. **`cmdalt set`/`reset` warn on a shadow** — asked for by the independent
   CHECK pass (`CHECK-0338-dispatcher-shadow-CONFIRMED-2026-07-28`). The
   ticket's three diagnostics are all PULL; the user's entry point into this
   bug is a switch that appears to do nothing, so the warning has to be at the
   moment of the ineffective action. It also drops the diagnostic's dependency
   on `0130`.
2. **A package `bin` that shadows a dispatched name is REFUSED**, at build time
   (`tools/mkpkg.js`) and at install time (gucman's bin-plant loop). The
   design filed this as "optional hardening", but its own §7 argument —
   "the fat bake is self-enforcing" — only covers packages that are FOLDED, and
   a `requires`-gated definition (every `*-clang` variant, including the
   `python-clang` this ticket names as the suggestion) is never folded. Without
   the gate such a definition builds clean and plants the shadow at install:
   the exact bug this item exists to close, with no build-time signal. Only the
   mkpkg half has a firing test; the gucman half is unreachable through the
   shipped pipeline (mkpkg refuses to build the payload, gucman sha-verifies
   against the mkpkg index), so only its non-firing path is covered — by every
   install leg in the estate. That coverage gap is filed as `todos/0355` and
   registered as `L46` — a backstop with no firing test is exactly the shape
   the liability register exists for.
3. **Candidates are deduped by value** (`ca_candidates`) — the design already
   asked for it (§2); without it, picking a candidate writes it to the user
   layer where it shadows the same value lower down, and the picker then offers
   the chosen entry twice.

**INTERLOCK, stated where it outlives this ticket** (CHECK item b): the
migration `gucman remove X && gucman install X` is only correct once packages
claim command names (step 3). Without that, removing the shadow leaves the key
resolving to an uninstalled baked suggestion — a stuck default becomes a broken
`python`. Step 3 shipped in this commit; the constraint is written into
`os/cmdalt.h` next to the code that prints the advice, and into
`todos/COMMAND-ALTERNATIVES.md` §7.

Not settled here, and not blocking: the design's §6.2 reservation of `cpython`
as a hard claim vs the earlier note giving CPython `python3`+`cpython`. Owed to
`0331`/`0340`. Per master's ruling `python3` is an approved KEY and `cpython`
is not; no `python3` link is baked (master assigned the manifest edit
explicitly, and it names only `/usr/bin/python`), so nothing here forecloses
either answer.

## Non-goals (recorded, not cut — rationale in the design doc §9)

- Dispatching `cc`/`sh`/`editor` — supported by the mechanism, a policy call
  with real blast radius, one manifest line whenever wanted.
- A cfgstore tombstone layer — `cfg_unset` covers revert-my-pick, which is all
  this and `0130` need.
- Auto-repairing the stale `/usr/local/bin/python` on an existing box — gucOS
  has no boot-time migration facility; diagnosed loudly instead.
