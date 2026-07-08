# Networking — the tier model

Status: designed 2026-07-09 (discussion log
`logs/2026-07-09/roadmap-network-desktop.md`); queue items `0052`
(loopback AF_INET), `0053` (curl-over-fetch), `0054` (relay transport).

## Platform truth (don't re-litigate the constraint)

A browser page cannot open a raw TCP or UDP socket. Chrome's Direct
Sockets API exists only inside Isolated Web Apps — not the open web, not
designed around. What the platform gives us: **fetch** (full HTTP/1.1–3
via the browser stack), **WebSocket** (message-framed bytes over TCP; the
server must speak WS), **WebTransport** (QUIC streams + unreliable
datagrams), **WebRTC data channels** (P2P, needs signaling). Everything
below is built from those.

Headless (Node) has none of these limits. The browser/headless asymmetry
is permanent; each tier documents it rather than hiding it.

## Tier 1 — loopback AF_INET (`0052`)

`127.0.0.1` TCP implemented entirely in kernel.js: the AF_UNIX OFD
machinery (todos/done/0008) plus a kernel port table instead of BlockFS
rendezvous nodes. **No web constraint at all** — identical in browser and
headless. Unlocks the large class of client/server software that never
leaves the machine (httpd→client, nc, anything "listen on a port").
Non-loopback destinations fail `ENETUNREACH` until Tier 4 is configured.

## Tier 2 — HTTP via fetch, behind a curl facade (`0053`)

POSIX has no HTTP API; the de-facto standard C API is **libcurl's easy
interface**. We own the libc, so we do NOT port real libcurl (it wants
sockets underneath) — we implement a `<curl/curl.h>` easy-API subset
natively, backed by a kernel fetch RPC (proposed opcode space 0x06xx —
verify against KERNEL.md's table when implementing). `curl_easy_perform`
blocks via the existing deferred-RPC machinery; the kernel worker does
the actual `fetch()`. A `/bin/curl` falls out for free.

Asymmetry: in the browser this is **CORS-gated** (same-origin +
CORS-permissive hosts only); headless Node fetch is unrestricted.
Documented, not hidden.

## Tier 3 — DNS via DoH (folds into `0053`, on demand)

`getaddrinfo` backed by DNS-over-HTTPS (the public DoH endpoints are
CORS-permissive) — plain fetch, no relay. Until then: static
`localhost` → 127.0.0.1 only.

## Tier 4 — arbitrary hosts via a pluggable relay (`0054`)

websockify pattern: the kernel dials `ws://localhost:PORT`, the relay
(`tools/net-relay.js`, ~100 lines of Node we ship) dials TCP and pumps
bytes into the socket OFD.

Key platform facts making the **localhost relay** work even when the
page is hosted elsewhere (e.g. a public https host):

- `localhost`/`127.0.0.1` is a *potentially trustworthy origin*, so
  `ws://localhost:PORT` from an https page is allowed in Chrome and
  Firefox (Safari is the holdout — compat note, not a blocker).
- WebSocket is not CORS-gated; the relay chooses which `Origin` values
  to accept (allowlist option).
- Chrome's Private/Local Network Access rules: the relay answers the
  preflight (`Access-Control-Allow-Private-Network: true`); newer Chrome
  adds a one-time user permission prompt — acceptable.

The localhost relay is a **feature, not just a workaround**: it runs
with the user's network identity, so the in-browser OS can reach their
LAN, dev servers, databases. A server-side `wss://` relay would give
zero-setup networking but makes the host an open TCP proxy
(auth/abuse) — NOT the default; the transport stays pluggable on the
kernel embedder (like the Dawn tier: absent → `ENETUNREACH`). Headless
transport is a direct `net.Socket` (no relay needed; tests may point at
the relay anyway to exercise it).

## Decisions

- **Order**: loopback first, curl facade second, relay last. Each tier
  is independently useful; none blocks another.
- **Pluggable transport** on the embedder; loopback always works.
- **TLS boundary**: the OS does not grow a TLS stack. https = Tier 2
  (the browser/Node fetch stack owns TLS); Tier 4 dials plain TCP.
- **UDP/SOCK_DGRAM**: only meaningful via WebTransport datagrams through
  a relay — on demand, no speculative build.
- P2P (WebRTC data channels — two OS tabs networking directly) is a
  recorded stretch idea, unscheduled.
