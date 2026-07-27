# 0355 — gucman's dispatch-shadow install guard has no firing test

- **Status**: open
- **Design**: `todos/COMMAND-ALTERNATIVES.md` §7 (the PATH shadow and why the
  guard exists), `todos/done/0338-command-alternatives-dispatcher.md` (the
  closeout that added it)

## Goal

`todos/0338` closed the "a package silently shadows a dispatched command name"
hole in two tiers:

- **build time** — `tools/mkpkg.js` refuses to build a definition whose `bin`
  names a command the base image dispatches. This tier HAS a firing test
  (`checkShadowingBinRefused` in `tests/kernel/test_cmdalt_e2e.js`).
- **install time** — gucman's bin-plant loop refuses the same thing
  (`gm_same_file(disp, GM_DISPATCH)`). This tier has **no firing test**. Only
  its non-firing path is exercised, by every install leg in the estate.

The reason is structural, not laziness: reaching the guard needs a payload
carrying a `bin` claim on a dispatched name, and mkpkg will not build one
(that is the point of the first tier), while gucman verifies the payload's
sha256 against the mkpkg index before extracting. So the branch is unreachable
through the shipped pipeline, which is exactly what makes it a *backstop* — and
also what makes it the kind of code that rots without anyone noticing.

Risk shape, stated honestly: a false POSITIVE is impossible (the guard fires
only when `/usr/bin/<cmd>` is literally the `cmdalt` inode), so a regression
here cannot break installs — it can only make the backstop stop backstopping,
silently.

## Plan

Pick one; the first is cheaper and probably enough.

1. **Hand-build the payload in the test.** The tar+gzip writer already exists in
   `tools/mkpkg.js`; expose enough of it (or a `--force-unsafe-bin` seam used by
   nothing but the test) to emit a definition mkpkg would otherwise refuse,
   serve it from the test's own repo dir with a matching index entry, and assert
   `gucman install` refuses, names the dispatcher, and leaves NO
   `/usr/local/bin/<name>` behind and no DB record.
2. **Unit-test the predicate instead**, if (1) turns out to need an escape hatch
   that is worse than the gap: a native-C probe over `gm_same_file` against a
   scratch tree with the merged-usr symlink layout, in the shape of
   `tests/kernel/test_keybind_registry.js`.

## Acceptance

- A test that FAILS if the gucman guard is deleted.
- The `todos/LIABILITIES.md` entry funded by this item is retired in the same
  commit.
