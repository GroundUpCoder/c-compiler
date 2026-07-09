# 0053 — HTTP for C: the curl easy facade over kernel fetch

- **Status**: open
- **Design**: `todos/NETWORK.md` (tier 2; tier 3 DoH noted there)

## Goal

`<curl/curl.h>` easy-interface subset implemented **natively in the
libc** over a kernel fetch RPC, plus `/bin/curl`. POSIX has no HTTP
API; curl-easy is the de-facto standard header — ports that "just want
HTTP" compile unmodified. Not a port of real libcurl (it wants sockets
underneath; we own the libc). 0052 is not required — this rides fetch,
not sockets.

## Plan

- Kernel RPC (proposed 0x06xx space — verify KERNEL.md's opcode table):
  request {method, url, headers, body} → status + headers + body
  streamed in chunks through the existing deferred-RPC machinery (no
  whole-body buffer). Browser: `fetch()` — **CORS-gated**, documented;
  headless: Node fetch, unrestricted.
- libc surface: `curl_easy_init/setopt/perform/getinfo/cleanup`,
  `curl_easy_strerror`. Options: URL, WRITEFUNCTION/WRITEDATA,
  HEADERFUNCTION, POSTFIELDS, HTTPHEADER, FOLLOWLOCATION, USERAGENT,
  TIMEOUT, RESPONSE_CODE (getinfo). Unsupported CURLOPT_* → error, fail
  loud.
- `/bin/curl`: a small tool (not real curl) covering `-s -o -X -H -d`.
- getaddrinfo-over-DoH: recorded in NETWORK.md as the tier-3 follow-on,
  NOT in this item's scope.

## Acceptance

- Headless test with a local Node http server: GET + POST round-trip
  from compiled C via curl_easy_*; redirect follow; non-2xx surfaced;
  connection-refused → the right CURLcode.
- `/bin/curl` in-OS (boot.js) fetches from that server.
- Browser: manual smoke against a CORS-permissive endpoint; the CORS
  asymmetry noted in the dev log.
