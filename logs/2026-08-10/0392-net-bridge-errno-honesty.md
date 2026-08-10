# #392 — net bridge: the transport error text crosses to C

## The bug class

The kernel has always carried the precise transport diagnostic
(`xfer.error`) and the C surface never saw it. `__http_status` logs the
text to the host console (the #78 visibility rule) and hands C a bare
errno; the libcurl veneer then collapsed every errno but ETIMEDOUT into
`CURLE_COULDNT_CONNECT`, whose strerror is *"Couldn't connect to
server"*. So a CORS denial, a bridge policy refusal (EACCES), a
configured-but-dead bridge (ENETUNREACH), a bad URL (EINVAL) and a real
connect failure were all reported identically — and `gucman install`,
in-OS `git`, `/bin/curl` and gcode were all undiagnosable when the
network path misbehaved.

NB the ticket body's claim that `host.js` "discards" the text was stale:
since #78 the text reaches `console.error`. The real gap was narrower —
the text never CROSSED to C — so the work was building the channel, not
un-discarding.

## The channel

One new op end to end, fd-shaped like everything else in the 0x06xx
family:

- **kernel.js `HTTP_ERROR` 0x0606** — `{fd}` → `{error}`: the transfer's
  recorded failure text (`''` while healthy). Non-consuming, callable in
  any state while the fd lives, EBADF after close (the last release
  frees the transfer, text included). The response deliberately carries
  NO errno key: the caller already holds the errno from the failing
  HTTP_STATUS/FS_READ, and an errno key would read as an RPC failure to
  the host-side hook plumbing (found while writing the host half).
- **host.js `__http_error(fd, buf, cap)`** beside `__http_status`:
  returns total text bytes, writes a NUL-terminated truncation. ENOSYS
  on an embedder predating the op — the veneer degrades to errno-derived
  messages, never crashes.
- **kernel.js `_fetchErrorText`** — Node's fetch rejects with a bare
  top-level *"fetch failed"* and buries the useful part
  (`connect ECONNREFUSED host:port`, `ENOTFOUND`, TLS verdicts) in
  `err.cause`; the kernel now composes both. The net-bridge wrapper digs
  its own cause out (#393), so the composer skips the cause when the
  message already contains it.

Convention note: the import is declared in `os/curl/libcurl.c`, NOT the
compiler prelude. `__http_open`/`__http_status` predate the current
convention; every newer fd-shaped import (`__wait`, `__fs_watch`,
`__egress`) is declared consumer-side or in its own C header, and
`__wait` itself — the sibling the veneer already uses — is not in the
prelude either. Deliberate, not a scope cut; touching compiler.js would
also have drawn all 25 suites for a two-line declaration.

## The veneer distinctions

`fail_transport()` replaces the two collapse sites. The text is fetched
FIRST (before `close(fd)` — close aborts and frees the transfer) and
lands in `CURLOPT_ERRORBUFFER`, real curl's contract. The errno picks a
distinct code:

| errno | code | note |
|---|---|---|
| ETIMEDOUT | `CURLE_OPERATION_TIMEDOUT` | as before |
| EACCES | `CURLE_REMOTE_ACCESS_DENIED` (new, upstream value 9) | bridge policy refusal |
| EINVAL | `CURLE_URL_MALFORMAT` | wrapper rejected the target URL |
| ENETUNREACH | `CURLE_COULDNT_CONNECT` | genuinely a reachability failure — the code was right; the bridge's text now rides along |
| other | `CURLE_COULDNT_CONNECT` / `CURLE_RECV_ERROR` (body phase) | message carries the text, else `strerror(errno)` |

The `__http_open` failure path (no fd yet, so no text channel — those
are local staging errors) keeps ENOSYS distinct and appends
`strerror(errno)` for the rest.

Consumers: gucman's `gm_http_get`, gcode's `do_turn` transport leg
(#387's sibling — that ticket classified the HTTP≥400 legs; this one
fixes the layer below it) and `/bin/curl` all set the errorbuffer and
prefer it over the category string. os-common's `netFetch` (bridge OFF,
browser, cross-origin http/https target) appends the ticket's CORS hint
to the rejection text — same call, same args, same errno; only the
message is enriched, so the #391 strict-superset ruling is untouched.

## The ticket's boot.js:347 leg

The line number was indeed unreliable (it is the generic boot catch),
but the symptom was real and is fixed by the general channel, verified
live on a fresh headless boot with no reachable repo:

```
gucman: /packages/index.json: connection failed: Failed to parse URL from /packages/index.json (Invalid URL)
```

— where the pre-#392 output was `Couldn't connect to server`. No
boot.js change was needed (and #391 correctly keeps the underlying
fetch failing headless).

## Red control

With the implementation stashed (`git stash push kernel.js host.js`)
and the new tests in place, the 7 new protocol legs in `test_http.js`
FAIL loudly at `{"errno":"ENOSYS"}` — the op genuinely does not exist
pre-change. The `test_curl_e2e.js` CLI leg's new `ECONNREFUSED`
assertion is the veneer-half control: pre-#392 that stderr line reads
`curl: (7) Couldn't connect to server`.

One test-authoring gotcha worth keeping: a `Promise.reject` fake fetch
settles on the microtask queue before any RPC can round-trip, so the
"healthy transfer reports ''" leg needs a never-settling fetch.

## Gate

`node tests/run.js --diff origin/main` (plan: 23 suites — kernel.js and
host.js sit under every compiled-C suite). Image resealed
`--packages=all` at v251 before the gate. Record in the lane report.

## Addendum — the "prelude" that wasn't (coordinator counter-pass)

The coordinator flagged that compiler.js:26745-26746 already declares
`__http_open`/`__http_status` "in the real prelude", making my
consumer-side-only ruling asymmetric. Investigating that claim showed
BOTH of our premises were wrong:

- Those decls live inside the `"__SDL.c"` entry of `_stdlibSources` — a
  separate translation unit, not a prelude. A plain program calling
  `__http_status` with no local declaration fails: *Undeclared
  identifier* (verified by compile). Nobody ever got the siblings for
  free; every consumer hand-declares, which is what libcurl.c's
  "identical redeclaration is fine" was already accommodating.
- `__SDL.c` itself never calls `__http_*`, and this compiler
  tree-shakes unused `__import`s (verified: an unused decl emits no
  import entry; a used one does). The sibling decls are dead text.
- Estate-wide inertness proven the memory's way: `vendor/sameboy`
  built via `buildProject` under HEAD vs the edited compiler is
  **byte-identical** (sha256 4d6401d7bb8a0e3f, 830350 bytes, both).

The decl + contract sentence were added anyway (`__http_error` beside
its siblings, read-BEFORE-close stated where KERNEL.md and host.js
point readers), because that block is the repo's canonical HTTP
contract comment and an incomplete family there is how this
investigation started. The two false signposts are corrected in the
same commit (libcurl.c:60, KERNEL.md "compiler prelude" → the __SDL.c
contract block, with the tree-shake facts). Touching compiler.js draws
the full mapper set — re-gated accordingly.
