# 0374 — Rename the package `python-clang` → `cpython-clang` (jku ruling, twice; republish + image bump)

- **Status**: open
- **Difficulty**: medium
- **Design**: this file, from
  `~/git/meta/meta/notes/QUEUE-rename-python-clang-to-cpython-clang.md`
  (the router's verified scope survey — 207 occurrences across ~37 files).
- **Provenance**: **jku, 2026-07-28, TWICE and unprompted.** First, directly:
  *"I don't want python-clang I want cpython-clang."* Then again by email, in
  reply to master cont-121's naming question: **"Definitely want cpython-clang
  not python-clang"** (`0mjzuSp5Xyuq`, uid 677). **This is a ruling, not a
  proposal.** Do not re-litigate it, do not ask for confirmation, and do not
  propose keeping an alias "for now" unless the migration analysis below
  actually forces one.

## Why this is principled, not cosmetic — state this to anyone who pushes back

1. **`micropython` is ALSO a published package** (live in
   `https://groundupcoder.com/packages/index.json`, version `1.28-3`).
   MicroPython is also a Python, and it is also clang-built. So `python-clang`
   does not name what it is — it is ambiguous with a package that already
   ships. **`cpython-clang` names the actual implementation.**
2. **It fits the house convention BETTER, not worse.** The convention is
   `<upstream-project-name>-clang`: `box2d-clang`, `doom-clang`, `etl-clang`,
   `gameboy-clang`, `glm-clang`, `imgui-clang`, `ninja-clang`,
   `tinyrenderer-clang`. The upstream project is **CPython**. `python-clang`
   was the outlier; `cpython-clang` is the conforming name.
3. The package's own published summary already says *"CPython 3.13.5
   (clang-built)"* — the metadata already calls it CPython. Only the key
   disagrees.

This does **not** disturb the cont-107 name-split ruling: **`python` stays the
ROLE / cmdalt KEY**; only the IMPLEMENTATION package name changes.
`python → cpython-clang` is still key → implementation. `python3` remains an
approved key; `cpython` remains REJECTED as a key.

## 🔴 TIMING — the clean window is OPEN BUT CLOSING. This is why it is urgent.

⚠️ **The router's note said prod was on image 180 so nothing could install yet.
That snapshot is STALE — re-verified live by master cont-122 on 2026-07-28:**

```
https://groundupcoder.com/os/image.json        version: 182   (image os-system.cd4ad9145da8b84d.img)
https://groundupcoder.com/packages/index.json  baseVersion: 182
                                               python-clang 3.13.5  minBase: 182
                                               micropython  1.28-3   minBase: 182
```

**Prod is now AT 182, so `gucman install python-clang` WORKS RIGHT NOW.** The
"zero installed records in the wild" assumption that makes this a free rename is
true only for as long as nobody installs it. Every hour the old name is live is
an hour in which this can stop being free and start requiring
`/var/lib/gucman/<name>.json` migration, alias handling and a deprecation story.

**Sequence this as the very next image after 182 — ideally 183.** ⚠️ **Re-verify
the zero-installs assumption at pickup rather than trusting this paragraph; it
is a snapshot too.**

## Scope — verified by the router, 207 occurrences across ~37 files

**Rename (live surface):**

- `packages/python-clang.json` → `packages/cpython-clang.json` (`git mv`)
- The published **pool payload filename** and the **`index.json` key** — this is
  a **republish**, not just a source edit. Whoever owns package publishing must
  re-cut the pool artifact and index. Decide explicitly whether the sha-suffixed
  pool file is renamed or regenerated. (Currently
  `pool/python-clang_3.13.5_7f813270fb7680cf.pkg.tar.gz`, 4,603,061 bytes.)
- `os/image.json` — the baked `/usr/share/cmdalt` content line
  `python<TAB>python-clang`. 🔴 **This changes baked image bytes ⇒ it forces an
  image bump. The MASTER assigns the version; a lane never edits
  `os/image.json`'s `version`.**
- `os/cmdalt.c`, `os/cmdalt.h` (comments at `cmdalt.h:30` and `:84` name it)
- `tests/kernel/test_python_clang_e2e.js` → `test_cpython_clang_e2e.js`
  (`git mv` + internal refs)
- `tests/kernel/test_cmdalt_e2e.js`, `tests/kernel/test_ctlpanel_e2e.js` — the
  acceptance leg asserts the failure message NAMES the package to install
  (`PYIMPL=0 / PYVERBS=1 / PYRC=127`), so the expected string changes
- `todos/CPYTHON.md`, `todos/COMMAND-ALTERNATIVES.md`, `todos/LIABILITIES.md`
- Open tickets that reference it: `0331`, `0343`, `0344`, `0345`, `0313`, `0117`
- `CLAUDE.md`
- `tools/bench2x2/` — `verify.sh`, `mp-build.sh`, `run-2x2.sh`, `mktable.js`,
  `README.md` (and its `verify-out/` fixture, if the harness compares literal
  output)

**Do NOT rewrite — rewriting it would be a lie:**

- everything under `logs/` — dev logs are a dated record of what was true then
- `todos/done/` — closed tickets record the state at closure
  (`done/0340-…`, `done/0338-…`, `done/0330-…`, `done/0341-…`)

If a closed ticket or log is genuinely misleading without a pointer, add a
**one-line dated note** rather than editing the original claim.

⚠️ `~/git/netguc/cc/…`-style absolute paths: **`python-clang` is NOT prunable
from the worktree set** — `ccjs-build.sh` hardcodes a path into it. Check that
script before assuming a rename is source-only.

## Acceptance

- `gucman install cpython-clang` works end to end on a fresh image; the old name
  is gone from the index — or, if analysis genuinely forces a transition alias,
  the alias is **explicit, dated, and ticketed for removal**, never silent.
- A fresh boot still satisfies **`PYIMPL=0 / PYVERBS=1 / PYRC=127`**, and the
  failure message now names **`cpython-clang`**.
- `grep -rn "python-clang" --exclude-dir=logs --exclude-dir=done` returns only
  intentional historical references.
- Kernel + sweep green with NUMBERS; the cmdalt / ctlpanel / python e2e legs
  green.
- Image bumped (master assigns) and the ledger republished.
- `todos/LIABILITIES.md` is machine-checked by the `todos` suite — if this
  change rewrites an anchored line the gate goes RED; re-anchor or retire it in
  the same commit.

## Residual this does NOT settle

`todos/0331` still owes the **§6.2-vs-uid-657** question: §6.2 reserves
`cpython` for a future our-compiler package, while jku's uid-657 had CPython
claiming `python3` + `cpython`. This rename settles the *package* name only.
Do not let it be read as settling the key reservation.
