# 0054 — AF_INET relay transport (arbitrary hosts)

- **Status**: deferred (mass-deferred 2026-07-12; was: open)
- **Design**: `todos/NETWORK.md` (tier 4 — the localhost-relay
  rationale, secure-context carve-out, PNA headers)

## Goal

`connect()` beyond loopback via a pluggable websockify-style relay.
`tools/net-relay.js` ships in-repo; the **localhost relay is the
documented default** — it works even when the page is hosted on a
public https origin (localhost is a trustworthy origin in
Chrome/Firefox; Safari holdout recorded), and it runs with the user's
own network identity (their LAN, their firewall). Builds on the 0052 socket surface.

## Plan

- `tools/net-relay.js` (Node, no deps): WS accept → TCP dial
  ({host, port} in the first frame), byte pump both ways; PNA preflight
  headers (`Access-Control-Allow-Private-Network: true`); an Origin
  allowlist option.
- kernel: a transport hook on the embedder (the Dawn-tier pattern) —
  configured via boot opt / `/etc` conf; absent → 0052's `ENETUNREACH`
  stands. Headless transport is a direct `net.Socket` (no relay
  needed); tests point headless at the relay anyway to exercise it.
- Non-goals v1, recorded: UDP/SOCK_DGRAM (WebTransport later), inbound
  listen through the relay, TLS-in-the-OS (the relay dials plain TCP;
  https belongs to 0053's fetch tier — the boundary is in NETWORK.md).

## Acceptance

- With the relay running: an in-OS C client (or nc) does an HTTP/1.0
  GET against a real external host, headless AND browser (manual for
  the browser leg).
- Without the relay: `ENETUNREACH` beyond loopback.
- Relay refuses a disallowed Origin.
