# 0415 — A real `-rust` tool over BlockFS (Lane A3)

- **Status**: open
- **Design**: `todos/RUST.md` §2 and §3.
- **Provenance**: the Rust program, filed 2026-07-29.

## Goal

Prove that `todos/0413` and `todos/0414` compose into a program somebody can use.
The proof is a real command-line tool, written in Rust, that reads real files from
BlockFS in a booted gucOS.

This is the end-to-end acceptance of Lane A. A tool that only prints a constant
proves the entry contract. A tool that opens a path, reads to the end of the file,
handles an error and returns an exit status proves the whole binding.

## The tool

Write `wc-rust`. It counts lines, words and bytes.

`wc` is the right choice for four reasons. It takes argument flags, so it exercises
`argv`. It takes zero or more paths, so it exercises `open`, `read`, `close` and a
read loop that must handle a short read. It falls back to standard input when it
gets no path, so it exercises fd 0. It must report a missing file on standard error
and still exit non-zero, so it exercises the error convention of the ABI.

The name carries the `-rust` suffix. The estate already ships a busybox `wc`, and
`todos/RUST.md` §3 rule 5 keeps the base image free of Rust. The suffix is what
makes both names correct at once. Do not shadow `wc`.

Implement `-l`, `-w`, `-c` and the multi-file total line, and match the output
format of the busybox applet. A tool that is nearly `wc` is worse than a tool that
is `wc`, because a user cannot tell which one they have.

## Read the ABI, not the Rust standard library

This ticket has no Rust standard library. It calls the filesystem imports of
`todos/0414` directly. `todos/0418` rules on the standard library, and nothing here
waits for it.

⚠️ **A short read is not the end of a file.** `RemoteFS.read` loops the underlying
call for exactly this reason (`todos/0140`). Write the loop, and add a test that
proves it: read a file that is larger than one transfer, and assert the count.

## Plan

1. Write the crate in the sibling repository. It depends on `gucos-sys` only.
2. Add the read loop, the flag parser, the standard-input path and the error path.
3. Add a kernel-suite test on the pattern of `todos/0413`: write the module and some
   test files into the root volume, run the tool from the shell, and assert the
   output and the exit status.
4. Compare the output against the busybox applet on the same inputs, in the same
   test. A hand-written expected string can encode the bug it is meant to catch.

## Acceptance

- `wc-rust` counts lines, words and bytes for one file, for several files with a
  total line, and for standard input.
- The output equals the output of the busybox `wc` applet on the same inputs, for
  `-l`, `-w`, `-c` and the default.
- A file larger than one read transfer gives the correct count. The test proves the
  read loop.
- A missing path writes a message to standard error, and the exit status is
  non-zero.
- The tool runs from a shell in a booted gucOS, driven by a kernel-suite test.
- The planner selects the suites (`node tests/run.js --diff`), and each one is green
  and reported with a NUMBER.

## Notes

The `todos` suite checks `todos/LIABILITIES.md`. If a change here rewrites an
anchored line, re-anchor the entry or retire it in the same commit.
