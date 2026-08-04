# #474 — git as a gucman binary package

Ships `gucman install git` inside gucOS: `vendor/fakegit` is promoted to
`os/git`, the CLI discovers its repository from the current directory, and
`packages/git.json` builds the payload. Read-only for now — the write set is
#475, approved the same day.

## The flag measurement reproduced

The ticket rests on a router-thread claim that four `compilerArgs` in the
fakegit project (`--allow-old-c`, `-Dvolatile=`, `--allow-undefined`,
`-DNO_STRNLEN`) are removable with byte-identical output. Re-run here at
`b276fabc`, both builds from the same tree:

| build | bytes | sha256 |
|---|---|---|
| 18 args (as committed) | 1 508 417 | `a96c5f0d…4973c96d` |
| 14 args (four removed) | 1 508 417 | `a96c5f0d…4973c96d` |

Identical. The ticket quotes 1 508 771 bytes, 354 more; that figure was
measured on a different tree state and is not the claim that matters — what
matters is that the two builds agree with each other **on the tree the change
lands on**, which they do. The four flags are gone from the promoted
`os/git/bin.json`.

`-Dvolatile=` was the interesting one: it silently deletes every `volatile`
qualifier in ~200 translation units of libgit2, and it turns out nothing
needed it.

## Why the tree consolidated instead of forking

The ticket asks for two things that pull against each other — "promote
`vendor/fakegit` into a real `os/` app with its own `bin.json`" and "remove
the four stale flags **from `vendor/fakegit/bin.json`**". Read literally that
leaves two build definitions, each carrying the same ~200-entry libgit2 source
list, which is a drift hazard the estate has a whole liability register about.

So the promotion is a `git mv` of both files and `vendor/fakegit/` is gone:

- `vendor/fakegit/fakegit.c` → `os/git/git.c`
- `vendor/fakegit/bin.json` → `os/git/bin.json` (paths rewritten
  `../libgit2/` → `../../vendor/libgit2/`, four flags dropped)

The flag removal is therefore visible to a reviewer as part of the rename
diff, and there is exactly ONE place the source list lives. `vendor/libgit2/`
was not touched at all — ticket #473 owns that directory and both lanes were
live at the same time.

The `fakegit` test category and `tests/fakegit/` keep their historical names
and now build `os/git/bin.json`. Renaming the category as well would have been
churn across `ALL_CATEGORIES`, `PY_CATEGORIES`, the rule table and the golden
tree for no user-visible gain; that is deliberately not done.

## Repo discovery, and the harness seam it needed

`git_repository_open(repo, argv[1])` → `git_repository_open_ext(repo, ".",
GIT_REPOSITORY_OPEN_CROSS_FS, NULL)`. The CLI now takes no repo argument at
all; `-C <path>` is git's own spelling and is a real `chdir` (both `chdir` and
`getcwd` are real host.js imports, so nothing had to be faked).

`CROSS_FS` is a decision, not a copy-paste. libgit2's default stops the upward
walk at a `st_dev` change, and gucOS's `st_dev` boundaries are the MountFS
mount table — the sealed `/usr` versus the writable root — not anything a user
would recognise as a filesystem. Stopping there would produce a "not a git
repository" that is an artifact of the mount layout.

The `fakegit` category used to prepend the fixture path as `argv[1]`. It now
prepends `-C <fixture>`, and a golden dir may instead carry a **`cwd.txt`**
naming a path relative to the fixture root: present ⇒ the binary runs with
that cwd and **no** `-C`. That is what makes a golden a proof of discovery
rather than of an explicit path. Two new dirs use it — `discover_root` (bare
`git ls-tree` from the top) and `discover_subdir` (`git status` from `src/`).
`discover_subdir`'s golden is byte-identical to the existing `status` golden,
which is the point: the output is anchored to the discovered **workdir root**,
not to the cwd.

## The name is `git`, by jku's ruling

The ticket left this open and coupled it to whether the write set was
approved: approved ⇒ `git`, declined ⇒ `gucgit`. No comment landed on #474,
but ticket **#475** ("Minimal git WRITE set — jku APPROVED 2026-08-04") records
the ruling in its body verbatim: *"#474 ships the CLI as `git`, not
`gucgit`."* Built as `gucgit` first, renamed once that was found.

The hazard the ticket named — an agent runs `git commit`, reads "unknown
command", concludes git is broken — is real and does not go away with the
name, so it is handled in the dispatch instead. A word in a table of 32 real
git verbs gets *"'commit' is a git command, but this build is read-only and
does not implement it yet"*; anything else gets *"'wibble' is not a git
command"*. #475 deletes verbs from that table as it implements them. The gap
is enrolled as **L78** in the liability register against #475.

## The e2e is differential, not golden-by-hand

`tests/kernel/test_git_e2e.js` (37 checks) installs the package on the minimal
image, uses it, reboots, and removes it. Getting a real repository *into*
gucOS was the interesting part: there is no write support, so the OS cannot
create one, and a repo's loose objects are raw-zlib streams that no shipped
shell tool can synthesise. It arrives instead as a tarball over a second
`serve.js`, fetched in-OS with `/bin/curl` and unpacked with `/bin/tar` —
shipped tools, no test-only seam — and the in-OS `sha256sum` proves the bytes
survived the trip.

The assertions that carry weight are cross-implementation:

- `git cat-file -p <HEAD tree>` inside gucOS matches `git cat-file -p` from
  the host's **real** git, line for line;
- `git status` from `src/` matches `tests/fakegit/status/expected.txt`
  verbatim;
- every `rev-parse` matches the host's answer for the same revision.

A self-consistent answer only our own reader accepts would prove nothing. Two
independent implementations agreeing on the bytes, one of them running on
BlockFS in wasm, is what "git works" means.

Two smaller traps recorded because they cost time to see: the norepo leg uses
`cd /` rather than `cd /tmp`, because a `cd` that *fails* leaves the cwd inside
the repo and turns the leg green for the wrong reason; and the tree sha is
passed as a literal rather than `HEAD^{tree}`, keeping brace characters out of
the hush line.

## Gate consequences worth knowing

Shipping libgit2 put it in the bake-input closure for the first time —
`newestBakeInput` scans every `packages/*.json` and follows its project
sources — so `vendor/libgit2/` now draws `kernel` + `sweep` on top of its
category, and its rule says why. The old rule's reasoning ("NOT in the bake
closure, nothing seeds or packages it") expired with this ship.

The fat fixture grows a 0.5 MiB payload and ~17 s of libgit2 compile per cold
bake. `os/image.json` goes to v232: a package is not a seeded source, but a
browser's persistent OPFS image only re-fetches on a version bump, so without
it a browser user would not see git until something else bumped it.

## zlib: kept libgit2's bundled copy

`os/git/bin.json` compiles `vendor/libgit2/deps/zlib/*.c`, not the shared
`vendor/zlib/lib.json`. Sharing would save nothing at runtime — these are
statically linked wasm binaries, there is no second copy in memory to
eliminate — while costing an include-path change and a configuration
difference between what libgit2 expects and what libpng/netsurf/gucman
configure. The change also has to stay byte-identical to keep the flag
measurement above as its own control, and swapping the compression library
underneath it would forfeit that. Revisit if #473 lands a libgit2 srclib that
wants one zlib for its own reasons.
