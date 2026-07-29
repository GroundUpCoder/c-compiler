# 0437 — netsurf: http/https fetcher over the platform network stack

- **Status**: open
- **Design**: —

## Goal

The gucOS netsurf build registers the `about:`, `data:`, `file:` and `resource:`
fetchers only. The curl fetcher is a deliberate exclusion
(`vendor/netsurf/README.md` "Deliberate exclusions"; `netsurf-core.json` builds
"fetchers-minus-curl"). The browser therefore cannot open an `http:` or `https:`
url, and a form cannot POST. `todos/0433` (the file gadget) defers one half of
its acceptance to this item: a multipart submit builds the correct
`fetch_multipart_data` list with `rawfile` set, but no built fetcher can read
the file and send the request body.

Give the browser a real network fetcher. Do not vendor libcurl for this: the
platform network stack (`todos/NETWORK.md`, `todos/0054` AF_INET relay,
`todos/0417` HTTP transfers as OFDs) is the substrate to build on. The fetcher
is a new gucOS-side TU that implements netsurf's `fetcher` contract
(`content/fetch.h`: initialise, can_fetch, setup, start, poll, abort, free)
over that substrate, the way `content/fetchers/curl.c` implements it over
libcurl.

In practice this item is blocked until the substrate ships; the dependency
wiring in `queue.json` is the coordinator's call.

## Plan

1. Pick the transport: the `todos/0417` HTTP-transfer OFDs if they have landed,
   else the AF_INET relay plus an in-frontend HTTP client. Record the choice.
2. Implement the fetcher TU in `vendor/netsurf/gucos/` (outside the patch
   fence) and register it for the `http` and `https` schemes.
3. GET first: headers, status codes, redirects through netsurf's existing
   llcache handling.
4. POST second: urlencoded (`post_urlenc`), then multipart
   (`fetch_multipart_data` with `rawfile` — read the named file and stream it
   as a part; this closes the `todos/0433` residual).
5. Cover it: a kernel e2e against a loopback server (the `todos/0182`
   `/bin/curl` test shape), including one multipart upload with a file part.

## Acceptance

- The browser opens an `http:` url end to end.
- A GET form submits and the response renders.
- A multipart POST carries the bytes of the file that the `todos/0433` file
  dialogue chose, and the server sees them intact.
