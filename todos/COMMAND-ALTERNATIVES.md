# Command alternatives — one name, a switchable implementation

**Status**: design, ratified by the jku ruling below; implementation ticket
`todos/0338`. Control-panel surface: `todos/0130` (un-deferred by this design).

## The ruling

jku, 2026-07-27 ~23:10 (email; recorded in the meta decider note
`fable-decider-python-primary-2026-07-27.md`, section *jku OVERRIDE of D4/D6*):
bare `python` should be

> "a binary or a script that always redirected all args to whichever the user
> has picked as the default binary for it"

— part of the **base image**, erroring *"no python implementation installed"* if
none is present, with the default **switchable in the control panel** when
several are installed, **analogous to the file-extension open-by-default
mechanism**.

This supersedes decider verdicts D4 ("no config dispatch — the name split is the
dispatch answer") and D6 ("the `python` alias is ratified-deliberate"; the alias
is now INTERIM, retired by this work). A later lean (same note, *jku LEAN:
python-clang as the suggested/preferred python*) fixes the **suggestion** shown
when nothing is installed: it names `python-clang`.

`python` is this mechanism's FIRST USER, not the mechanism. What follows is a
generic command-alternatives dispatcher; nothing in it is python-shaped.

## What already exists (verified off the tree, 2026-07-27)

Nothing here is new mechanism. The pieces below all ship today:

| Piece | Where | Note |
| --- | --- | --- |
| Three-layer per-key config overlay | `os/cfgstore.h` | `cfg_load3`/`cfg_find`/`cfg_set`; user > /etc > /usr/share, **first matching line over the concat IS per-key precedence** |
| Wrappers over it | `os/openwith.h`, `os/saver.h`, `os/sounds.h` | three stores, one mechanism — a fourth is the established shape, not a new facility |
| A base-image alias symlink | `os/image.json` `"/usr/bin/code": { "link": "/usr/bin/gcode" }` | the `link` manifest kind |
| exec emulation, canonical form | `vendor/busybox/port/vfork_spawn.c:207-225` (`pv_execve`) | **"there is no real exec on this platform"** — spawn, wait, exit with the child's status |
| Shebang re-dispatch | `kernel.js:2386` `_spawnShebang` | argv becomes `[interp, optarg?, scriptPath, ...orig[1:]]` |
| Package bin planting (runtime) | `os/gucman/gucman.c:969-983` | plants `/usr/local/bin/<cmd>`; **refuses** if that path already exists |
| Package bin planting (fat bake) | `os/os-common.js:1087-1092` + `claim` at `:1021` | folds to **`/usr/bin/<cmd>`**, and a duplicate path **throws** |
| Package control whitelist | `os/os-common.js:901-918` `packageControl` | explicit key list — a new control key needs one line here |

Two kickoff claims came second-hand and are **corrected** by the table:

- *"a package symlink at `/usr/local/bin/python` would collide, and
  `gucman.c:976-980` refuses installs over an existing symlink"* — the refusal
  does **not** fire: the dispatcher lives at `/usr/bin/python`, the package link
  at `/usr/local/bin/python`. Different paths. What actually happens at runtime
  is a **PATH shadow** (`PATH=/usr/local/bin:/bin`), which is silent.
- The real hard interlock is the **fat bake**: the fold plants package bins at
  `/usr/bin/<cmd>`, so the instant `os/image.json` gains `/usr/bin/python`, every
  `--packages=all` bake dies with *"package 'micropython': /usr/bin/python
  conflicts with an existing image entry"*. See §7 — this is good news.

The `_spawnShebang` claim **is** correct (§6).

## 1. The store

A fourth cfgstore store named **`cmdalt`**:

```
~/.config/cmdalt      the user's pick  (ctlpanel / `cmdalt set`)
/etc/cmdalt           package claims   (gucman install/remove)
/usr/share/cmdalt     baked suggestions (os/image.json)
```

Lines are the standard `KEY<ws>VALUE`. **KEY is a command name** (`python`,
`cc`, `editor`); **VALUE is an argv prefix** — the same shape openwith's COMMAND
has, except the dispatcher appends *all* of its own `argv[1:]` instead of one
path. A bare first word resolves through `/usr/local/bin:/bin` exactly as
`ow_build` does.

### Why a separate store rather than `command.*` keys in `openwith`

The kickoff (and the decider) suggested `command.python` inside the existing
openwith store. Both work; this design takes the separate store, for four
reasons, none of them fatal to the alternative:

1. **Semantics.** `openwith` answers *"what opens this FILE"*. `cmdalt` answers
   *"what runs this NAME"*. Sharing one file means `/etc/openwith` grows entries
   that `ow_resolve` will never look at.
2. **Editors don't overlap.** fileman's "With" picker and `open --set` must not
   offer command keys, and `cmdalt set` must not write file associations. Two
   stores make that structural instead of a convention.
3. **Package plumbing differs.** gucman's `openwith` control key *replaces* a
   key (an association has one winner); command claims *append* (§4) so the
   picker can enumerate every installed implementation.
4. **"Analogous to" is satisfied precisely.** It is the same mechanism
   (`cfgstore.h`), the same three layers, the same delta-write — the estate
   already runs three stores over it.

The runner-up (`command.` prefixed keys in `openwith`) stays viable: the dotted
prefix cannot collide with an extension key, because `ow_key_for` takes the text
after the **last** dot, so extension keys never contain one — the `default.gui`
/ `default.term` precedent proves the namespace. Switching to it is a one-line
change in one header; master can overrule cheaply.

## 2. Resolution

Two reads, deliberately different:

- **Effective value** = `cfg_find` over the `cfg_load3` concat — the *first*
  matching line, i.e. user pick, else first package claim, else baked
  suggestion. Unchanged mechanism.
- **Candidate set** (control panel + error messages) = *every* matching line
  across the concat, in order, deduped by value. This needs one new iterator,
  `cfg_each` (§5); it is a read-only addition.

`cfg_find`'s existing "within one layer the first line for a key wins" is what
makes multi-line-per-key work, so first-claim-wins falls out for free: the
earliest-installed implementation stays the default until the user says
otherwise, and a later install never silently steals `python`.

The dispatcher then resolves the value's first word: absolute/relative-with-
slash is used as-is, a bare word walks `/usr/local/bin:/bin`.

**An unresolvable value is an error, never a silent fallback to another
candidate.** Running MicroPython because the user's chosen CPython was
uninstalled would be a footgun (a script written for one dialect quietly running
under the other). The error names what to do instead, using the candidate set:

```
$ python foo.py
python: 'python-clang' is not installed
       available: micropython
       switch with:  cmdalt set python micropython
                     (or Control Panel ▸ Default Programs)
```

and with nothing installed at all — the case jku named — the baked suggestion
carries the hint:

```
$ python foo.py
python: no python implementation is installed
       install one:  gucman install python-clang
```

Exit status for both: **127** (POSIX "command not found").

## 3. The dispatcher binary

`os/cmdalt.c` → `/usr/bin/cmdalt`, a **multicall** binary in the busybox /
coreutils idiom already used in this tree, plus `link` entries in
`os/image.json` for each dispatched name:

```json
"/usr/bin/python": { "link": "/usr/bin/cmdalt" }
```

(That entry is a *design statement*; image.json is master's to edit, and the
image version bump goes with it.)

**Mode is chosen by `basename(argv[0])`:**

- `cmdalt` → the admin CLI (§3.3).
- anything else → **dispatch mode**, key = that basename.

This is what makes the mechanism generic *and* keeps it safe: because the
dispatcher's own flags only exist under the name `cmdalt`, `python --help`,
`python --version`, `python -c ...` can never be intercepted. Every argument is
forwarded verbatim, always.

An empty or NULL `argv[0]` is a hard error (exit 127) — there is no key to
resolve.

### 3.1 There is no exec — spawn and wait

`execve` in this libc is `static inline int execve(...) { return -1; }`
(`compiler.js:25234`). The canonical estate answer is `pv_execve`'s: *spawn the
image with an empty journal (fds/cwd/pgroup inherit) and become a shell around
it — wait, then exit with its status; the lingering parent is invisible to
scripts.* The dispatcher does exactly that, via `posix_spawn` + `waitpid`,
matching `os/open.c`'s existing spawn-and-wait shape.

Status forwarding, identical to `os/strace.c:132-133` and `pv_execve`:

```c
while (waitpid(pid, &status, 0) < 0 && errno == EINTR) continue;
if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
return WIFEXITED(status) ? WEXITSTATUS(status) : 127;
```

### 3.2 Signal policy

The child inherits the dispatcher's process group, so the tty's line discipline
signals **both** (`kernel.js:1531` — control chars route to the foreground
pgroup). That gives the right answer for free in most cases, and the wrong one
in exactly one, which is why the table below is not "keep the defaults":

| Signal | Dispatcher | Why |
| --- | --- | --- |
| `SIGINT`, `SIGQUIT` | **`SIG_IGN`** while waiting | the pgroup already delivered them to the child. With the default disposition, `^C` at a REPL that *handles* SIGINT (a Python REPL raising `KeyboardInterrupt`) would kill the dispatcher and **orphan the still-running REPL**. Ignoring reproduces exec fidelity exactly: if the child dies of SIGINT we still report 130. |
| `SIGTERM`, `SIGHUP` | forward to the child, keep waiting | a direct `kill <dispatcher-pid>` must not orphan the child. Double delivery (pgroup + forward) is harmless for signals the child does not survive. |
| `SIGTSTP`, `SIGCONT` | **default** | the dispatcher must stop with the pgroup so the shell's job control sees the job stopped, and resume with it. |
| `SIGKILL` | uncatchable | **accepted limitation** — `kill -9` on the dispatcher leaves the child running and reparented. Unfixable without exec; recorded, not scheduled. |

Signal delivery is cooperative (KERNEL.md): a dispatcher parked in `waitpid`
claims pending signals at the RPC safe point, which is why the `EINTR` loop
above is mandatory rather than defensive.

### 3.3 Self-dispatch guard

`cmdalt set python python` would spawn the dispatcher from the dispatcher —
a fork bomb. Guard: `stat()` the resolved program and compare `st_dev`/`st_ino`
against `/usr/bin/cmdalt`. Because *every* dispatch link resolves to that one
inode, a single check kills direct self-dispatch **and** every longer cycle at
its first hop. Refuse loudly, exit 127.

### 3.4 The admin CLI (`cmdalt` under its own name)

- `cmdalt list` — every key: effective value, resolved program, candidate list,
  and a **shadow** marker (§7).
- `cmdalt which <name>` — the absolute program `<name>` would run; exit 1 if
  unresolved. Walks PATH itself, so it reports *"`/usr/local/bin/python`
  shadows this setting"* when an earlier PATH entry wins over the dispatch link.
  This is the diagnostic for the one failure mode no build gate can catch.
- `cmdalt set <name> <cmd...>` — user-layer delta write (`cfg_set`).
- `cmdalt reset <name>` — drop the user key, revert to package claims / baked
  suggestion (`cfg_unset`, §5).

## 4. Packages claim command names

New gucman control key, mirroring the existing `openwith` one — a map of
*command name* → *this package's `bin` command that provides it*:

```json
"bin":      { "micropython": "micropython" },
"commands": { "python": "micropython" }
```

- `os/os-common.js` `packageControl`: one line (`commands: pkg.commands || {}`),
  since the control is an explicit whitelist.
- `gucman` install: validate the value names one of the package's own `bin`
  commands (the `openwith` validation shape), then **append** `python<TAB>
  /usr/local/bin/micropython` to `/etc/cmdalt` if that exact key+value line is
  absent, and record it in the DB record for replay.
- `gucman` remove: delete that specific key+value line — not the key. Two
  implementations installed, one removed, the other keeps its claim.

Append-not-replace is what gives the picker its candidate set and gives
first-claim-wins its stability. It needs its own small writer next to
`gm_openwith_set` (which replaces/deletes by key and is the wrong shape here).

**The `commands` claim is not in the ticket's minimum** — §9 records why it is
nonetheless part of the design and what happens if master splits it out.

## 5. `cfgstore.h` additions

Three small, shared additions — all of them wanted by `todos/0130` too:

1. **`cfg_unset(name, key)`** — the streaming delta-write minus the append: copy
   the user file omitting the key's lines. `0130`'s "Remove" button needs
   exactly this, and it is currently the thing blocking that button (the ticket
   flags it: *"removing a BAKED key outright would need a tombstone"* — a
   user-layer unset is the well-defined half, and it is all `cmdalt reset` and
   `0130` Remove need).
2. **`cfg_each(text, key, cb)`** — iterate *all* lines for a key over the concat,
   in layer order. Feeds the candidate set and `0130`'s association listing.
3. **Hoist the argv splitter.** `ow_build` (`openwith.h:115-143`) already splits
   a command into words, appends **one** path, and PATH-resolves argv[0].
   `cmdalt` needs the same thing appending **N** args. Move the split +
   PATH-resolve into `cfg_split_argv` / `cfg_resolve_prog` in `cfgstore.h` and
   leave `ow_build` as a wrapper that passes `n = 1`. Behavior for openwith's
   three consumers must be **byte-identical** — `tests/kernel/test_openwith_e2e.js`
   is the guard, and if the hoist cannot be made obviously identical, duplicate
   the 20-line splitter in `os/cmdalt.h` instead and say so.

## 6. Shebangs (verified, not inherited)

`_spawnShebang` (`kernel.js:2386-2412`) rewrites argv to
`[interp, optarg?, scriptPath, ...orig[1:]]` and sets `spec.path = interp`. So
`#!/bin/python` gives the dispatcher `argv[0] == "/bin/python"` →
`basename` → key `python`. **The claim holds**; it works because the key comes
from `basename(argv[0])`, not from a bare-word assumption.

Consequences worth stating:

- The dispatcher is a normal spawn, **not** a shebang hop, so it does not
  consume any of `SHEBANG_MAX_DEPTH`'s 4 hops. A `#!` script → dispatcher →
  a `#!`-scripted implementation still has depth to spare.
- `/bin/python` is a symlink to a symlink (`/bin` → `/usr/bin`, then
  `/usr/bin/python` → `cmdalt`). MountFS resolves symlinks in the full
  namespace and the module cache's `immutableKey` is *"prefix:ino after symlink
  resolution"*, so the dispatch links share one cached module.
- **A shebang whose implementation is missing** does not fail at spawn the way a
  real missing interpreter would (`ENOEXEC`/`ENOENT`). The dispatcher starts,
  prints the §2 error, and exits **127** — the script's exit status. The
  observable difference from Linux is the message text, which is strictly more
  useful.

## 7. Release atomicity — the one loud constraint

`packages/micropython.json` currently declares `"bin": { "micropython":
"micropython", "python": "micropython" }`. That `python` alias and the base-image
dispatcher **cannot coexist**, and the two paths fail differently:

- **Fat bake — hard failure, self-enforcing.** `foldPackages` plants package
  bins at `/usr/bin/<cmd>` and `claim` throws on a duplicate
  (`os/os-common.js:1021-1025`). The moment `/usr/bin/python` enters
  `os/image.json`, every `--packages=all` bake — `tools/mkimage.js`,
  `tests/lib/image-fixture.js`, `serve.js`, `boot.js` — dies with *"package
  'micropython': /usr/bin/python conflicts with an existing image entry"*.
  **So the manifest entry and the package edit must land in the SAME COMMIT**,
  not merely the same release. There is no window in which the tree builds with
  one and not the other, which is the best possible enforcement.
- **Runtime install — silent shadow.** gucman plants `/usr/local/bin/<cmd>`, and
  `PATH=/usr/local/bin:/bin`, so a package alias silently wins over the
  dispatcher. `gucman`'s existing "refuses to overwrite an existing symlink"
  guard never fires here: different directory.

### The already-installed box

This is the case nobody will test. A box that installed micropython under the
old package keeps `/usr/local/bin/python` **forever**: `/usr/local` → `/var/local`
is user territory, and an image upgrade never writes it. `cmd_install`
(`gucman.c:1264-1278`) prints *"already installed"* and returns 0 — there is no
upgrade path — so nothing re-plants.

Today the symptom is invisible: micropython is the only implementation, so the
shadow runs the same binary the dispatcher would have. It becomes wrong the
first time a second implementation is installed and the user switches the
default **and the switch appears to do nothing**.

Migration is `gucman remove micropython && gucman install micropython`: remove
replays the DB's `symlinks` list, which contains the old `/usr/local/bin/python`
link, so the stale alias goes. Three surfaces make that discoverable rather than
mysterious, and the ticket funds all three:

1. `cmdalt which python` names the shadowing path and prints the fix.
2. `cmdalt list` marks shadowed keys.
3. The `0130` picker shows a warning line when the key's dispatch link is not
   what PATH resolves — the exact screen where a user whose switch "did nothing"
   is standing.

An optional gucman hardening (**not** funded here): refuse to plant a
`/usr/local/bin/<name>` link when `/usr/bin/<name>` is a dispatch link. It
converts a future author's mistake from a silent shadow into a refused install.

## 8. The control panel — `todos/0130`

`0130` (*Default Programs applet*, deferred 2026-07-12) is the surface jku
asked for and un-defers with this work. It already plans a LISTBOX of
associations + an EDIT + Set/Remove over `openwith`. For command keys it needs a
second list — Windows' own "Default Programs" has exactly this split ("set your
default programs" vs "associate a file type"):

- **Commands list**: one row per `cmdalt` key, showing the effective value.
- **Candidates** for the selected key (from `cfg_each`), each row annotated:
  `micropython — /usr/local/bin/micropython` / `python-clang — not installed`.
- **Set as default** → `cfg_set("cmdalt", key, value)`; **Use default** →
  `cfg_unset` (reverts to package claims, then the baked suggestion).
- **Shadow warning** when PATH does not reach the dispatch link (§7), with the
  `gucman remove … && gucman install …` fix in the text.
- Agent-drivable per the OS.md pillar: label-addressable rows and buttons.

The minimum this ticket owes `0130` is **the picker leg** — the commands list,
the candidate list, and Set. The file-association half of `0130` stays `0130`'s.

## 9. Generality — the call, and what is deferred

The dispatcher is generic in the only two places genericity can live: the key
comes from `argv[0]`, and the store is keyed by command name. Adding a second
user is **one `link` line in `os/image.json` and one baked line in
`/usr/share/cmdalt`** — no code. Measured against a python-only version, the
generic one costs: `basename(argv[0])` instead of a constant (0 lines), the
multicall mode split (~6 lines), and the self-dispatch inode guard (~8 lines,
and a python-only version would want it too). The decider's "essentially
identical" assessment holds.

Deliberately **not** built now, each with a reason that is not "no customer":

- **`cmdalt` for `cc`, `sh`, `editor`, …** — the mechanism supports them today;
  which names to dispatch is a *policy* question with real blast radius
  (`/bin/sh` is pid 1). Adding one later is a manifest line. Nothing is cut.
- **A tombstone layer** (hiding a baked or /etc key from the user layer) —
  `cfg_unset` covers "revert my pick", which is the whole of `cmdalt`'s and
  `0130`'s need. A tombstone is a cfgstore-wide semantic change affecting four
  stores; it wants its own design pass if a real case appears.
- **The `commands` package-claim key (§4)** is *in* this design and should ship
  with it. If master must split it — its edits touch `packages/micropython.json`,
  owned by another lane right now — the fallback is a baked `/usr/share/cmdalt`
  line naming each shipped implementation in preference order, which works but
  cannot see a package the base image did not anticipate. Flag it as the split
  point, not as a descope.

## 10. Acceptance

New `tests/kernel/test_cmdalt_e2e.js`. `tests/run.js`'s `^os/` rule already maps
`os/cmdalt.*` to `kernel` + `sweep` and `^packages/` to `kernel`/`sweep`/`host`,
so **no new RULES entry is needed** (verified against `tests/run.js:105-146`).

Legs — note that all of the mechanism legs use base-image binaries only, so they
run on a `--packages=none` boot and do not depend on any python shipping:

1. **Dispatch + argv**: `cmdalt set foo /bin/echo`; a `/usr/bin/foo` dispatch
   link runs `echo a b` → `a b`. Every argument forwarded verbatim, including
   ones that look like flags (`foo --help`).
2. **Exit status**: a nonzero exit propagates; a signalled child reports
   `128+sig`.
3. **No implementation**: an unset/unresolvable key → exit 127, message names
   the suggestion and the available candidates.
4. **Shebang**: a `#!/bin/foo` script runs the configured implementation with
   the script path as `argv[1]` and the caller's args after it.
5. **Self-dispatch**: `cmdalt set foo foo` → refused, exit 127, no fork bomb.
6. **Shadow diagnostic**: plant `/usr/local/bin/foo`; `cmdalt which foo` names
   the shadow.
7. **Layers**: a `/etc/cmdalt` claim beats the baked suggestion; a user pick
   beats the claim; `cmdalt reset` falls back to the claim.
8. **Package claim round-trip** (fat fixture): `gucman install` appends the
   claim, `gucman remove` deletes that line only.
9. **`python` itself** (fat fixture): `python -c` runs MicroPython through the
   dispatcher, i.e. the interlock in §7 actually landed.

Plus: `test_openwith_e2e.js` must stay green across the §5.3 splitter hoist, and
`test_ctlpanel_e2e.js` grows the picker leg.

## 11. Accepted limitations

- `kill -9` on the dispatcher orphans the child (§3.2). No exec, no fix.
- Every dispatched command costs one extra process-table entry and one extra
  wasm instantiation for the dispatcher's lifetime. The dispatcher is a few KB
  of C; the module cache makes the second and later spawns free.
- An already-installed box keeps a stale `/usr/local/bin/python` until the user
  reinstalls the package (§7). Diagnosed loudly in three places; not
  auto-repaired, because gucOS has no boot-time migration facility and inventing
  one for this is out of proportion.
