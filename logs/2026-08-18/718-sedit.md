# #718 — native C-aware Source Editor

Base: `eee46a7a979b6f318fd74f2e7d82c6fb043fc6b5` (exact `origin/main` at
kickoff). Epic argument: #713 measured missing syntax highlighting, delimiter
matching and compiler-diagnostic navigation across two real C+SDL3 authoring
loops; this closes that manual edit/build/debug friction without changing the
global vi/notepad defaults.

## Shape

- `gucedit.h` is a private, synchronous, generation-bound styled EDIT ABI.
  Generation is compared against an exact reserved byte snapshot at the
  existing `EN_CHANGE` seam, so legacy no-op notifications do not advance it.
- `sedit` owns C policy. It copies text only from a posted private message,
  scans from byte zero in bounded chunks, and publishes only a complete current
  generation. EDIT stays authoritative for input, selection, undo and paint.
- The file layer accepts regular UTF-8 files up to 8 MiB, records a whole-file
  EOL choice, preserves BOM, follows symlinks, detects external byte changes,
  names the physical target, refuses hard-link breaking without consent, and
  fsyncs a same-directory temp before atomic rename. It does not claim directory
  entry crash durability.
- Navigation deliberately follows current `cc` line-only contracts. CLI uses
  literal-`lstat` first; Ctrl+G accepts a positive line, `FILE:LINE`, or one
  complete error/warning/link diagnostic. Column-shaped diagnostics are loud
  refusals.

## Provenance fence

Implementation and fixtures were independently authored from tracked source
and the approved v2 design. The user-owned untracked `projects/` tree and all
user-owned `tests/browser/*sedit*` paths were not read, run, copied, adopted,
edited, cleaned, staged, or used. `os/sha256.h` is the only reused algorithmic
source; its tracked provenance is retained. No ReactOS Notepad, CodeMirror, or
BusyBox vi code/fixtures were copied.

## RED controls and focused evidence

Exact-base absence controls:

- `git cat-file -e eee46a7a…:os/sedit/bin.json` → 128 (absent)
- `git cat-file -e eee46a7a…:os/win32/gucedit.h` → 128 (absent)
- base image search for binary and c/h associations → 1 (absent)

Development REDs were kept and explained, never retried away: an unparenthesized
mixed logical expression; a line/column grammar ambiguity; a missing browser
launch barrier; tty newline parsing; unsynchronized input under load; and a
missing first-styled-frame barrier. Each correction targeted the observed
instrument rather than weakening acceptance. Browser red logs are preserved by
the suite runner under `build/test-browser/`.

GREEN evidence before candidate gate:

- native project compile: `sedit wasm bytes=626244`
- focused kernel: 3/3 (`test_gucedit`, `test_sedit_core`, `test_sedit_e2e`)
- focused browser: 1/1 (`os-sedit`)
- kernel e2e under load: 3/3, 0% flake
- browser e2e under load: 3/3, 0% flake

The 262,144-byte work cap is a responsiveness mechanism, not a performance or
correctness budget. No machine-time assertion is used.

## Rollback

Remove the v273 image binary, Development menu entry and c/h associations
first; defaults stay `default.gui=/bin/notepad` and `default.term=vi`. Then
remove app/docs/tests. Remove `gucedit.h`/user32 support only after confirming no
remaining tracked consumer. A stale explicit user override continues to name
the missing `/bin/sedit` and fails loudly; removing/replacing that override
restores baked/default resolution.

# Readiness counter-pass (2026-08-19)

The authoritative diff gate exposed two `wmctl` readiness timeouts in the
unchanged Win32 source-library e2e.  Candidate/base attribution made the
failure candidate-specific.  A diagnostic boot preserving the legacy 15 s
waits showed the actual earlier failure: the in-OS compiler could not resolve
`gucedit.h` beside packaged `user32.c`, so neither test binary existed.  The
later readiness markers were unconditional shell echoes.  The styled EDIT ABI
header is now explicitly part of the win32 package's `src/win32` payload, the
same physical tree used by the `win32` source-root mapping.

# Contract-completion counter-pass (2026-08-19)

Independent review found that the first tip's green tests did not cover the
whole approved v2 contract. The corrected mapping is explicit:

- Commands: Search/Find now has both menu dispatch and Ctrl+F, a modal query,
  wrapped next-match selection, and deterministic focus return to the document.
  Headless and headed automation drive the accelerator and dialog lifecycle.
- Save identity: ordinary Save retains the spelling the user opened and
  re-resolves it before every overwrite. Missing, retargeted, inode-changed, or
  same-inode byte-changed targets return the same external-conflict result; the
  UI names the captured physical target before Overwrite / Save As / Cancel.
  The core probe retargets a real symlink and proves both old and new targets
  remain unchanged.
- Atomic I/O: `SeditIOOps` exists only under `SEDIT_TEST`; production binds the
  POSIX operations directly. Executable controls cover partial write, EINTR,
  create/write ENOSPC, chmod/fsync/close/rename failures, cleanup, content-hash
  conflict, hard-link refusal/break, CRLF preservation, explicit mixed-EOL
  choice, BOM, and no-final-newline. The fake selector is absent from baked code.
- Streaming scan: identifier, number, pending slash/comment opener, block-close,
  quote escape, directive continuation, delimiter stack, and byte offset survive
  feeds. Every split of fixed UTF-8/comment/token/delimiter witnesses equals the
  one-feed result. UI work is capped by 32 KiB feeds, 256 KiB per turn, and an
  elapsed 8 ms deadline, with continuation only through posted `WM_RESTYLE`.
- Styled EDIT: batch arithmetic, count, generation, flags, colors, UTF-8
  boundaries, LF crossing, overlap ordering, and BOX single-scalar/tab rules
  live in `gucedit_core.c` and run as a native executable matrix. Replacement
  allocation is commit-after-copy, with executable OOM preservation. Production
  has no test allocator export. Selection owns syntax fg/bg; UNDERLINE/BOX draw
  afterward in `COLOR_HIGHLIGHTTEXT`, so match marks remain visible.
- Generation and lifetime: exact byte snapshots advance only after a real byte
  change; stale batches have their distinct error; invalid and allocation-failed
  replacements preserve the installed batch; destruction frees both snapshot
  and styles. The executable core plus real Win32 headed/headless paths cover the
  reachable halves.
- Navigation/text formats: positive line, FILE:LINE, primary error/warning, and
  link `at` forms pass; zero/overflow/column/multiline/unrelated forms reject.
  UTF-8 validity, mixed EOL choice, BOM, and no-final-newline are byte-asserted.
- Integration/rollback: `/bin/sedit`, Development menu activation, c+h
  associations, Notepad/vi defaults, package source closure, and binary-absent
  resolver rollback remain covered by the original headless/headed acceptance.

The provenance fence remained absolute: no user-owned `projects/` material or
shared untracked `tests/browser/*sedit*` fixture contributed implementation or
test content.
