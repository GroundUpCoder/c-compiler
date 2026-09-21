# 0243 — libc strerror doesn't name the socket-family errnos (88–111)

- **Status**: done (branch `fix-0243-strerror`, awaiting master review/merge)
- **Design**: —

## Resolution

Extended the `strerror` switch in compiler.js's `__string.c` libc block to name
every defined-but-unnamed errno — the full socket family plus the two non-socket
stragglers that also fell through to "Unknown error":

- Socket family (glibc wording): `ENOTSOCK` 88, `EDESTADDRREQ` 89, `EPROTOTYPE`
  91, `EPROTONOSUPPORT` 93, `EOPNOTSUPP`/`ENOTSUP` 95, `EAFNOSUPPORT` 97,
  `EADDRINUSE` 98, `EADDRNOTAVAIL` 99, `ECONNABORTED` 103, `ECONNRESET` 104,
  `ENOBUFS` 105, `EISCONN` 106, `ENOTCONN` 107, `ETIMEDOUT` 110, `ECONNREFUSED`
  111, `EHOSTUNREACH` 113, `EALREADY` 114, `EINPROGRESS` 115.
- Non-socket stragglers: `ENOLCK` 37, `EOVERFLOW` 75.

Each number+name verified against the `<errno.h>` block in compiler.js (no
invented numbers). `ENOTSUP` is an alias of `EOPNOTSUPP` (same value 95) → one
case arm. Strings use glibc wording, matching the existing strerror arms and the
glibc-modeled libc.

Test: `tests/unit/conformance/libc_strerror_socket_errnos/` — asserts the string
for all 21 errnos (fails before the fix: every one printed "Unknown error";
passes after). compiler.js-touch gate: full conformance (124) + string_h (6)
green; SameBoy e2e green; codegen confirmed neutral (diff is 21 additive C lines
inside `strerror()`, no compiler-logic change — the SameBoy wasm grows by exactly
the enlarged switch that `core/gb.c`'s 5 `strerror(errno)` calls pull in).

## Goal

The libc `<errno.h>` has carried the socket family since todos/0008
(ENOTSOCK 88 … ECONNREFUSED 111, incl. EOPNOTSUPP/ENOTSUP 95 and
ENOTCONN 107), but `strerror()` (compiler.js `__string.c` libc block) only
switches on errnos ≤ ENOTEMPTY 39 — every socket errno prints
"Unknown error". Any sockets program's perror/strerror output is wrong
today (e.g. a refused `connect` reports "Unknown error"), and the 0242
WMP-errno work had to pick EPERM/ENODEV over the semantically-preferable
ENOTSUP/ENOTCONN because those wouldn't render.

Found while landing todos/0242 (arch CS7).

## Plan

- Extend the `strerror` switch in compiler.js's libc with the socket-family
  strings (match glibc wording: "Operation not supported",
  "Transport endpoint is not connected", "Connection refused", …).
- NB compiler.js change → full estate gate; conformance test comparing
  against clang's strings for the covered range.
- Optional follow-up once landed: revisit whether 0242's EPERM/ENODEV picks
  should become ENOTSUP/ENOTCONN (wire values are additive, but tests and
  wmctl hint text pin them — only flip with cause).

## Acceptance

- `strerror(ENOTCONN)`/`strerror(EOPNOTSUPP)`/`strerror(ECONNREFUSED)` return
  the real strings under a conformance test; existing goldens unchanged.
