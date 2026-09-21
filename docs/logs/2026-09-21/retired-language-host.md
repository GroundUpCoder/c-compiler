# Retire the alternate language host integration

The user explicitly requested that gucOS drop its alternate language host
integration and that the active integration proposal be removed.

Changes:

- Removed the alternate core import environment, suspend-import splitter,
  entry-point runner and namespace-based dispatch from `host.js`.
- Removed the associated kernel module-cache exclusion. Custom imports now use
  ordinary compiled-module caching; host instantiation validates their imports.
- Updated module-cache tests to verify custom-import modules are cached and
  shared. Existing rewrite/invalidation and real-worker execution coverage stays.
- Removed the active integration proposal and its index entry, and updated host,
  kernel and cache documentation. Historical archives and unrelated identifiers
  were preserved.
- Dropped obsolete project ticket #13 through `cc-meta ticket drop`, with the
  user's removal instruction recorded as the outcome. Read back the authoritative
  ticket record and verified its dropped status.

Validation: `git diff --check` passed. `node tests/run.js --diff` exited 0:
seven selected sections passed, zero failed, in 4077.6 seconds. Liabilities,
unit, host, BlockFS, compiler/vendor cases, kernel and browser sweep passed.
The compiler/vendor batch recorded 895 passes and 111 skips. All 206 selected
kernel members and all 72 selected browser members had logs post-dating this
run's start and passed; their checkpoint files also carried one older result
each, which is not counted here as newly executed. The directly changed
module-cache test passed, including real-worker compilation and in-OS
recompile/invalidation. Authoritative result: `build/test-run/summary.json`.
This was the required diff gate, not the full deployment gate; netsurf-patch,
disw and sourcemap were deliberately not selected.

Only this task's files are included. Three pre-existing untracked image manifest
files under `os/` were preserved. No sub-agents or external threads implemented
or verified the change.
