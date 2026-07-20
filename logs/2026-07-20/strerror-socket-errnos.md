# strerror() now names the socket-family errnos (todos/0243, P0)

## The bug

`<errno.h>` in compiler.js has carried the socket family since todos/0008
(`ENOTSOCK` 88 … `EINPROGRESS` 115), but the `strerror()` switch in the
`__string.c` libc block only had arms up to `ENOTEMPTY` 39. Every socket errno
fell through to `default: "Unknown error"` — so a refused `connect()`'s
`perror`/`strerror(errno)` printed "Unknown error" instead of "Connection
refused". Filed P0 per always-do-bug-fixes-first (a shipped libc function giving
wrong output). Found while landing todos/0242, which had to pick EPERM/ENODEV
over the semantically-preferable ENOTSUP/ENOTCONN precisely because those
wouldn't render.

## The fix

Added switch arms for every defined-but-unnamed errno, not just the socket one
that bit us (CORE PRINCIPLE — full defined set, clean general coverage): the 19
socket-family errnos plus `ENOLCK` 37 and `EOVERFLOW` 75, which were also
falling through. Each number+name was verified against the `<errno.h>` block in
the same file — no invented values. `ENOTSUP` is a `#define` alias of
`EOPNOTSUPP` (both 95), so it's one case arm, not two (duplicate `case` labels
would be a compile error).

Strings use glibc wording ("Transport endpoint is not connected", "Connection
refused", …), consistent with the existing arms — this libc is glibc-modeled,
and the committed golden captures my compiler's output, so glibc wording keeps
the golden self-consistent. (macOS `strerror` wording differs, e.g. "Socket is
not connected"; that's why the test's golden is glibc, not a live-clang
comparison.)

## Test

`tests/unit/conformance/libc_strerror_socket_errnos/` prints `%d %s` for all 21
errnos. Verified fails-before (stashed compiler.js → every line "Unknown error",
1 failed) and passes-after. Runs under the standard run-unit harness.

## compiler.js-touch gate

`__string.c` lives inside compiler.js, so this changes compiler output. Ran the
SameBoy byte-identity gate:

- SameBoy wasm is **not** byte-identical — it grows 800 B (664893 → 665693).
  That's expected and benign: `core/gb.c` calls `strerror(errno)` in 5 places,
  so the enlarged switch is legitimately linked. `buildProject` doesn't enable
  `gcSections`, so strerror is always pulled; `disw` (no strerror ref) grew too
  (+564 B) for the same reason — the differing absolute deltas are just
  per-program data-section packing.
- Codegen is neutral **by construction**: the diff is 21 additive C lines inside
  the `strerror()` function text — zero change to the compiler's JS translation
  logic — so no unrelated function's codegen can drift. Both pre and post builds
  were internally stable across 5 runs each (no todos/0269 slot-allocation
  drift).
- Functional gates green: full conformance suite (124) + string_h (6) +
  SameBoy kernel e2e.

## Follow-up (from the todo, not done here)

Revisit whether 0242's EPERM/ENODEV WMP-errno picks should become
ENOTSUP/ENOTCONN now that they render — wire values are additive but tests +
wmctl hint text pin them, so only flip with cause. Left for a separate item.
