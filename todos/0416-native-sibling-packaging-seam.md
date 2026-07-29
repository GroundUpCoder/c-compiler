# 0416 — The `native-sibling` packaging seam, and `mkpkg --rust` (Lane A4)

- **Status**: open
- **Design**: `todos/RUST.md` §3 rules 4-6; `todos/CLANG-CPP-EPIC.md` §5 and §7 hold
  the mechanism this ticket generalizes.
- **Provenance**: the Rust program, filed 2026-07-29.

## Goal

Let a user install a Rust program with `gucman install <tool>-rust`, and keep the
base image free of Rust.

The mechanism already exists for clang. One sibling repository produces the
binaries and publishes an `overlay@1` manifest with a sha256 for each file. A
package definition carries `requires: "clang-sibling"` and a `clangApp` entry.
`listPackages` filters those definitions out of the base index at one choke point
(`tools/mkpkg.js:60`), and `mkpkg --clang` builds the superset index instead
(`tools/mkpkg.js:213`). The payload is copied from the overlay and verified against
the same sha256 the bake uses (`tools/mkpkg.js:196-215`).

Nothing in that mechanism is specific to clang. This ticket makes the names say so,
and it adds the second producer.

## The rename

Generalize the vocabulary to two neutral names.

| Today | After |
|---|---|
| `requires: "clang-sibling"` | `requires: "native-sibling"` |
| `clangApp` entry | `nativeApp` entry |
| `clangFile` entry | `nativeFile` entry |

The `requires` value then names the **producer**, not the language: keep the
distinction by naming it — `native-sibling:clang` and `native-sibling:rust`, or a
separate `producer` field. Decide which one, and record the reason. The two
toolchains are peers under one rule, and the rule must be able to say which sibling
a definition needs, because a build with the clang sibling present and the Rust
sibling absent is a normal state.

🔴 **Rename outright. Do not accept the old name as an alias.** A compatibility
alias means every reader has to learn both names, and the old one never dies. Update
the 11 package definitions under `packages/`, `tools/mkpkg.js`, `os/os-common.js`,
`serve.js`, `serve-with-clang.js` and `tests/serve/test_clang_base_purity.js` in one
change.

## The collision with `todos/0383`

`todos/0383` renames the clang sibling's payload key. Both tickets rewrite
`packages/cpython-clang.json` and the mkpkg orphan check, so both turn every
in-flight lane's `mkpkg --clang` red for the same mechanical reason.

`todos/0383` explains that reason in full, and its precondition applies here without
change: **do the rename in a window where no unmerged lane still carries an old-name
definition.** Re-derive the list of lanes at pickup. Land this ticket after
`todos/0383` if `todos/0383` is still open at pickup, so that the estate pays the
window once and not twice.

## `mkpkg --rust`

Add the second flag beside `--clang`. The two flags are independent booleans. A
build may ask for neither, for one, or for both, and the index is a superset over
whatever was asked for.

⚠️ **Two builds must never share an out directory.** `todos/0388` established this:
a build **replaces** the repository, and the orphan prune deletes every payload the
fresh index does not name. A third channel multiplies that thrash. Use `--pool=DIR`
to keep the payload store shared and append-only, and keep each index in its own out
directory. The `.mkpkg-lock` refuses a second concurrent build of one out directory,
and it must keep refusing.

## Where the Rust binaries come from

The sibling repository of `todos/0413` publishes an `overlay@1` manifest, in the
same schema and with the same per-file sha256. This repository consumes it. It never
invokes `rustc`. See `todos/RUST.md` §3 rule 4.

An explicit `--rust` with no sibling present fails with exit 1 and prints the fix
command. An **un**requested absent sibling stays a normal state, and prints nothing.
That is `todos/CLANG-CPP-EPIC.md` §4 rule 2, and it does not change here.

## Plan

1. Do the rename, in one change, in a clean window.
2. Add `--rust` to `tools/mkpkg.js`, and the `native-sibling:rust` gate.
3. Teach `serve.js` the Rust index the way it knows the clang index
   (`serve.js:50`, `serve.js:203-215`).
4. Package `wc-rust` from `todos/0415` as the first `-rust` package.
5. Add the browser leg that `todos/0413` deferred: run a Rust binary in a real
   gucOS terminal, in the browser sweep.
6. Add the guardrails below.

## Acceptance

- `gucman install wc-rust` works on a Rust-enabled origin, and the tool runs.
- 🔴 **The base image is byte-identical.** A test compares the image built before
  this change with the image built after it, and the bytes are equal.
- A base-purity test asserts that a plain `mkpkg` yields no name that matches
  `-rust$`. The existing `tests/serve/test_clang_base_purity.js` is the template.
- 🔴 **A positive control rides beside the purity test.** In the same run,
  `mkpkg --rust` **does** yield the `-rust` name. A purity test alone proves
  nothing, because a build that produces nothing at all would pass it.
- `mkpkg --rust` with an absent sibling exits 1 and prints the fix command.
- `mkpkg` with an absent Rust sibling and no `--rust` succeeds and prints nothing
  about Rust.
- A sha256 that does not match refuses the payload. A test proves the refusal.
- The browser sweep runs a Rust binary in a gucOS terminal.
- No occurrence of `clang-sibling`, `clangApp` or `clangFile` survives outside
  `logs/` and closed tickets. The close-out names every survivor.
- The planner selects the suites (`node tests/run.js --diff`), and each one is green
  and reported with a NUMBER.

## Notes

The `todos` suite checks `todos/LIABILITIES.md`. If a change here rewrites an
anchored line, re-anchor the entry or retire it in the same commit.
