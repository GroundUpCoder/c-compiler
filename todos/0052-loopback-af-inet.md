# 0052 — loopback AF_INET

- **Status**: deferred (mass-deferred 2026-07-12; was: open)
- **Design**: `todos/NETWORK.md` (tier 1), `todos/KERNEL.md` (AF_UNIX,
  0008 — the machinery this reuses)

## Goal

`127.0.0.1` TCP entirely inside kernel.js: the AF_UNIX OFD machinery
plus a kernel port table instead of BlockFS rendezvous nodes. No web
constraint, identical browser/headless. Unlocks listen-on-a-port
software that never leaves the machine.

## Plan

- `socket(AF_INET, SOCK_STREAM)`, `bind` (127.0.0.1 / INADDR_ANY),
  `listen`, `accept`, `connect`, `getsockname`/`getpeername`; ephemeral
  ports; `ECONNREFUSED` on closed ports; `SO_REUSEADDR` (trivial — no
  TIME_WAIT). Same v1 non-goals as AF_UNIX (O_NONBLOCK, DGRAM, …),
  recorded.
- Non-loopback destinations → `ENETUNREACH` until 0054's transport is
  configured.
- libc: `<netinet/in.h>`, `<arpa/inet.h>` (htons/ntohs, inet_addr/
  inet_ntoa/inet_pton) — audit what already exists first;
  `getaddrinfo("localhost")` resolves statically (no DNS; tier 3 is
  separate).
- KERNEL.md: extend the sockets section + opcode notes; keep the
  settled-decisions table current.

## Acceptance

- tests/kernel e2e: compiled-C server + client over 127.0.0.1 exchange
  bytes; shutdown/EOF semantics; ECONNREFUSED; select/poll readiness on
  listen and data fds.
- If busybox `nc` enables cheaply (0034 pattern), the in-OS smoke:
  `nc -l -p N` in the background, `echo hi | nc 127.0.0.1 N`.
- AF_UNIX suite untouched.
