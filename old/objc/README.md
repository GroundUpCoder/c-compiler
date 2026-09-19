# Archived Objective-C implementation

Retired by explicit user direction on 2026-09-20, ticket #796. Objective-C is no
longer an active language in the main compiler. Further language and Foundation
work is tabled: no intended application/corpus justified its maintenance cost.
This supersedes the earlier implementation roadmap in the archived design notes.

## Contents and provenance

`manifest.json` records the exact pre-removal Git commit and SHA-256 of each
preserved file. Paths below this directory mirror their original repository paths.
The compiler and host are full snapshots, alongside Foundation sources/headers,
package metadata, dedicated tests, and snapshots of shared integration files.
Historical authorship remains in Git; copying here does not change it.
`compiler-removal-commits.json` lists the compiler patches removed in reverse
chronological order. Later unrelated compiler changes were retained.

These files are an archival snapshot, not an independently maintained fork or
complete standalone repository. Some test runners depend on unarchived repository
infrastructure. For a complete runnable historical tree, use the commit recorded
in manifest.json in a separate checkout, for example:

```
git worktree add --detach /path/to/objc-checkout <manifest-commit>
```

Follow that checkout's CLAUDE.md for dependencies and test commands. Do not copy
an old compiler or host over the current files: that would also discard later
unrelated work. The archived tests/objc/README.md and os/foundation/README.md state
the implemented language/library contracts; their historical pending-gate text is
not a statement about present support or new validation.

## Active-tree changes

Removed Objective-C lexer mode, types, declaration/message parsing, cross-unit
class/protocol checks, generated dispatch/startup/ownership runtime, pool/EH/
fast-enumeration lowering and Objective-C callback exception wrappers. Removed
Foundation's active package/source-library registration and dedicated test runners.
`.m` inputs now fail with an explicit retirement diagnostic.

Retained the C aggregate frame and indirect-variadic ABI repairs (#773/#776),
C Wasm exceptions and setjmp support, generic constructor invocation in host.js,
async cancellation/drain fixes (#782), and C/Small callback capture semantics.
The C test compile helper now lives in tests/lib/compile-c.js. Source-package
integrity tests use cJSON rather than the retired Foundation library.

The archive is excluded from normal builds/test discovery by the existing old/
policy. The active retirement test verifies all archived file hashes. Restoring
Objective-C is an explicit future project decision, not an open implementation
obligation. This change does not uninstall packages from existing user filesystems
or publish a new package index or OS image.
