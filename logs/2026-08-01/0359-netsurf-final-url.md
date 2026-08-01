# W-359 + W-182 — NetSurf real networking: the final URL, then the fetcher

Two tickets, two commits, one lane (jku greenlit by email as HIGH PRI).
Branch `0359-netsurf-net`; #359 deliberately its own commit so it stays
independently mergeable — it closes a libcurl defect whether or not the
fetcher ships.

## #359 — surface the post-redirect FINAL URL

The kernel HTTP transport fetched with `redirect: 'follow'` and threw
`resp.url` away. Two consumers were wrong because of that one discard:
`CURLINFO_EFFECTIVE_URL` returned the request url (a *documented* lie in
libcurl.c's header), and the incoming NetSurf fetcher would have resolved
relative links against the pre-redirect URL.

**Why a synthetic header line.** `HTTP_STATUS` already returns a flattened
`name: value\n` blob and every consumer ignores unknown lines — so
`x-guc-final-url: <url>` rides in with ZERO ABI change. Prepended, not
appended: the 64 KB flatten cap truncates tails, and the one line that must
survive a header-heavy response is this one.

**Why four hops, not three.** Direct mode has a real `Response.url`. Bridge
mode does NOT — `bridgeFetch` returns a hand-built `{status, headers, body}`
literal, so the bridge ships `up.url` as its own `x-guc-final-url` response
header and the wrapper mirrors it as `.url`. The kernel then sees one
uniform shape. The trap in the middle: a response header absent from the
bridge's `access-control-expose-headers` list is **silently invisible** to a
cross-origin reader (null, no error), and the shipped deploy
(https://groundupcoder.com → 127.0.0.1) is always cross-origin. That is why
the netbridge e2e grew a REAL Chromium leg — a page on the target's origin
reading the bridge on another port. The red control reproduced the exact
production failure shape: `finalUrl: null`, everything else green.

**Collision rule.** A server sending its own `x-guc-final-url` is filtered at
`_httpFlattenHeaders` — the one choke point both modes flatten through — so
the transport's line is unambiguous (spoof leg asserts exactly one line,
ours).

**libcurl.** The veneer captures AND STRIPS the line before HEADERFUNCTION
(a consumer must never observe a header no server sent — asserted explicitly
with `synthetic_seen=0`, the criterion most likely to pass by accident), and
answers `CURLINFO_EFFECTIVE_URL` with it. The native-clang real-libcurl
differential agrees byte-for-byte on the redirect section, which is the
strongest oracle available for the semantics.

**Ceiling, recorded.** Platform fetch follows redirects opaquely in both
modes. Intermediate hops, `FOLLOWLOCATION=0`, `MAXREDIRS` are permanently out
of reach — kept as documented no-ops.

## #182 — the http/https fetcher (Option B)

`vendor/netsurf/gucos/httpfetch.c`: NetSurf's `fetcher_operation_table` over
`__http_open`/`__http_status`/`read`/`close`. data.c gave the ring/poll/
locked skeleton, curl.c the callback sequencing. No `__wait` anywhere —
NetSurf's own 10 ms poll paces the transfer, and the http-fd contract is
poll/consume-until-EAGAIN by design.

**The build-placement question (the brief's one open item), resolved from
the build system:** `buildProject` expands the whole dep tree into ONE
preprocessor registry, so a bin's `-Dnsgucos` DOES reach core TUs (an
`#ifdef nsgucos` hunk in core fetch.c would have been safe — nsmonkey never
defines it). But an even cleaner placement won: `fetcher_add()` is a plain
table insert with per-scheme `initialise`, completely order-independent, so
registering from `gucos/main.c` right after `netsurf_init()` is
byte-equivalent to a `fetcher_init()` hunk — with zero vendored-tree edits,
no patches/netsurf.diff churn, and no possible effect on the other
netsurf-core consumer. Chose (a): TU in `gucos/` + `bin.json` sources +
frontend registration.

**The one real integration surprise: FETCH_REDIRECT needs a 3xx code.**
`llcache_fetch_redirect` switches on `fetch_http_code()` and answers
`NSERROR_BAD_REDIRECT` to anything outside {301,302,303,307,308}. Our status
is the FINAL response's (200 — the transport followed opaquely; the
intermediate codes are unknowable). Fix: on the redirect path store 303
(See Other) — llcache replays the final URL as a GET, which matches what the
platform fetch itself did for the dominant 301/302/303 chains. A
307/308-POST-preserving chain would be replayed as GET; recorded as the cost
of the opaque-follow ceiling. First e2e run caught this (`unsupported
redirect 200` — the refetch never happened); worth remembering that the
llcache contract is "redirect code + Location", not "redirect happened".

**Error legs.** ETIMEDOUT → FETCH_TIMEDOUT renders the DEDICATED
`query_timeout.c` page ("Connection timed out") — NOT the fetch-error page
("Error occurred fetching page"), which DNS-failure and connection-refused
get. The e2e needles both titles, which is how the TIMEDOUT/ERROR split is
proven. 404 bodies render as content; 401 renders as content too (no
FETCH_AUTH — the frontend builds no 401login UI).

**The #359 payoff, asserted server-side:** the redirect leg's final page
carries a relative `<img>` from a subdirectory; the server observes
`GET /sub/pic.png` (resolved against the FINAL directory) and zero
`GET /pic.png`. Plus exactly two hits on the final URL: the transport follow
and llcache's refetch — FETCH_REDIRECT really fired. Both asserted in direct
AND bridge modes.

**Descopes (deliberate, funded):** multipart POST = loud FETCH_ERROR →
ticket #360 + LIABILITIES L72 (anchored on the refusal line); cookies
cannot work in browser direct mode (forbidden-header rules) — recorded, not
scheduled; auth/certs permanently out. JPEG decode is pre-existing ticket
0448 (#new-number in cc), not absorbed.

**Red controls run:** (#359) kernel prepend reverted → 3 http_e2e legs red;
bridge expose-headers reverted → browser leg red with `finalUrl:null`;
libcurl strip reverted → `synthetic_seen=1` + differential red. (#182)
register call disabled → all 9 netsurf-http legs red, server saw ZERO
requests. Every green in this lane has been shown capable of going red.

**Test-harness note:** `test_netsurf_http_e2e.js` boots ASYNC (cp.spawn, the
test_curl_e2e CLI-leg rule) because the target server lives on the harness
event loop — a spawnSync boot would freeze the very server the in-OS browser
fetches from. The wmctl-wait discipline is applied by hand (any
`wmctl: wait ... timed out` in the captured output fails the test).
