# Small Java throwable objects in gucOS v291

The user requested Java-style Throwable exceptions through commit, sync, and
deployment. Small previously had native Wasm tags and raw exception references;
collection failures could not be caught through the Java exception hierarchy.

Small commit `9f97c7abaf81855f3b58de5c8cd60e516665c432` adds one compiler-owned
Java exception tag carrying a Throwable object, ordered subtype catches, object
rethrows, and finally handling alongside the existing native tag path. Java
library exception classes and explicit collection/IO/String failures use this
mechanism. `throws` declarations are syntax metadata, not checked effects.
Implicit native traps (including a null object throw) remain fatal native traps;
this release does not synthesize Java exceptions for those traps or add stack
traces. Small's `JAVA-EXCEPTIONS.md` records the precise contract and limits.

The compiler is snapshotted by the existing sibling mechanism. No gucOS host ABI
change is needed. Version 291 makes the updated snapshot an image upgrade for
persistent browser installations. The existing kernel and browser Small tests
now require an ArrayList bounds failure to reach a superclass catch; the kernel
case additionally checks finally while retaining its startup, exit, C-service,
redirection, and pipe assertions.

## Frozen inputs

- Small commit: `9f97c7abaf81855f3b58de5c8cd60e516665c432` (clean and pushed).
- Small reviewed tree: `d17d52556699bc6c8d52e2f214981643c104648e`.
- Small snapshot: `ea01c977d25897e53d4c87fe697c6d3adc61b001fb588be9b755d877d8c7fcad`
  (71 compiler/runtime/library files; baked image metadata matches).
- gucOS base: `d7c9b80796de122e69b7f08f6441a4d2c8285143`.
- gucOS tested code tree: `3b195806eff68e5d794d75b96a4169debcbb8d3a`.
  This journal is the only addition after the code gate.

## Executed validation

Author checks in Small: 345/345 root tests with strict JS checking (20 throwable
cases), three editor tests, 12 installed-VSIX checks, and Hex/Base64/Base32/
BinaryCodec programs all exited successfully. Compiler and editor copies match.
The independent reviewer also ran the 345 Small tests and additional probes.

`node tests/run.js full` completed as run `20260912-141105-67624` in 4269.943s.
Its final authoritative summary selects all 26 registered suites, grouped into
eight passing results, with `filter: null` and no omissions. Unit tests recorded
849 passes and three skips; the Python corpus recorded 904 passes and 111
baseline skips. No suite failed.

Kernel: 206/206 passed. Browser: 74/74 passed. Both child summaries have
`done: true`, no filter, complete executed/recorded membership, zero non-pass
results, and zero resumed/carried files. The Small integration cases passed in
both. The immutable full-gate archive is
`build/test-run/history/20260912-141105-67624/`:

- `summary.json` SHA256: `aba5f3f2f49d6e0d5c1089fb059f93dcc37b7db573dafa76a2fc01fb93216e7a`
- `test-kernel-summary.json`: `858b579f86f7e579a7ca2ee35cafdb2012e0ebc880f8b0a5f0e28690f59ffdf4`
- `test-browser-summary.json`: `17239b42ecd45fb56157a570fac54afe1f94f35f072a254859265d64f4725d43`

Additional CPU-contention validation, all with ten load workers:

- `node tests/flake.js`: 12 kernel and 18 browser runs passed; each selected
  file passed three repetitions (zero observed flakes).
- `node tests/kernel/run.js --filter=test_small_e2e --repeat 3 --under-load`:
  all three passed.
- `node tests/browser/os-sweep.mjs --filter=os-small --repeat 3 --under-load`:
  all three passed.

These filtered supplemental runs retain non-selected historical results in
their rolling summaries; only their newly executed repetitions are claimed
above. They do not replace the frozen full gate. Copies of the full and
supplemental summaries are in `build/release-small-throwables/`.

## Review and publication

Independent external review used cc thread
`01a095e8-032c-71f6-ab65-4a8e12de7572`, verified as Codex / `gpt-6-astra`.
The reviewer approved the frozen Small code and bounded gucOS code diff, then
independently audited and approved the complete full-gate evidence. Final tree
approval is obtained before committing this record. No internal agents authored
this change.

Publication uses comguc's image-only path with this clean committed gucOS
checkout, preserving the production package repository. The observed baseline
was image v280 with 94 packages; comguc's local published package index matched
the live index byte-for-byte. Actual deployment provenance and verification are
recorded by comguc's append-only deploy ledger, not asserted by this pre-deploy
source commit.
