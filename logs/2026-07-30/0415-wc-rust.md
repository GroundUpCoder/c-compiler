# todos/0415 — wc-rust, a real `-rust` tool over BlockFS

The Rust program's Lane A3. The crate `crates/wc-rust` lives in the
gucos-rust sibling (branch `0415-rust-wc`). It depends on `gucos-sys`
only. The committed fixture is `tests/kernel/fixtures/wc-rust/`.

## Why the tool replicates busybox, not GNU

The acceptance compares `wc-rust` against the busybox `wc` applet on the
same inputs, in the same booted OS. The estate builds that applet with
locale support and unicode support off. That configuration changes the
algorithm:

- The word separators are the space, `\t`, `\n`, `\v`, `\f`, `\r` and
  the end of the input. The word constituents are the bytes 0x21–0x7e.
- Every other byte is IGNORED. It does not start a word and it does not
  end a word. A high byte inside a word does not split the word.
- `-m` equals `-c`, because every byte counts as one character.
- `-L` resets the line position on `\n`, `\r` and `\f`, but NOT on `\v`.
  A `\t` advances the position to the next multiple of 8. The total for
  `-L` is the maximum across the files, not the sum.

The test corpus (`WC_A` in `test_rust_e2e.js`) carries one input from
each divergence-prone class. A hand-written expected string can encode
the bug it is meant to catch, so busybox is the format oracle, and the
big-input counts are pinned by numbers that the test derives in JS.

## Option parsing: the estate's getopt does not permute

The libc `getopt` in `compiler.js` stops at the first non-option
argument. There is no GNU permutation. Busybox links that getopt, so
`wc FILE -l` treats `-l` as a path in gucOS. `wc-rust` implements the
same rule: the option scan stops at the first operand, `--` ends the
options, and clusters (`-lw`) combine.

## The two read loops, and which test proves which

`RemoteFS.read` re-issues the transfer RPC only for a REGULAR file
(`_isRegularFd`: `S_IFREG`). Two consequences shape the tests:

- The LARGE REGULAR FILE leg proves the KERNEL's loop. It can pass even
  if the tool issues one read and drops the short-read case.
- The LARGE PIPED STDIN leg proves the TOOL's loop. On a pipe, fd 0 is
  not `S_IFREG`, so a short read really is short. Only the tool's
  loop-until-EOF makes `cat big | wc-rust` correct.

The big input is `5 * KP_FS_CHUNK + 12347` bytes. The size passes the
256K pipe ring and the transfer chunk, and both values are derived —
`KP_FS_CHUNK` is now read from `kernel.js`'s exports, never restated.

## Gotcha: `.gitignore` allowlists each fixture by name

The root `.gitignore` bans `*.wasm` and then allowlists each committed
fixture. A new fixture needs its own `!` line, or `git add -A` stages
the sha256 and silently skips the binary.

## Numbers

- `tests/kernel/test_rust_e2e.js`: 49 checks green, sibling present
  (freshness legs rebuilt all three artifacts byte-identical).
- The kernel registry stays at 137 files; no new test file.
