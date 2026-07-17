# 0243 — libc strerror doesn't name the socket-family errnos (88–111)

- **Status**: open
- **Design**: —

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
