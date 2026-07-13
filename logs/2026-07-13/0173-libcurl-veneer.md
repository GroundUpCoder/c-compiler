# 0173 — libcurl easy-interface veneer over the kernel HTTP transport

Landed `os/curl/` (the win32 app-side-library pattern: `lib.json` +
`include/curl/curl.h` + `libcurl.c`, no kernel change): the libcurl **easy
interface** subset over the 0172 `__http_*` primitive. libcurl-as-API was the
whole point of the layering — a frozen external standard, the port-enabler
(git/wget-ish tools), and every consumer becomes host-testable because the
same C source builds natively with `clang -lcurl` (macOS SDK) as a
clang-style oracle.

## Shape

`curl_easy_perform` maps 1:1 onto the transport:
`__http_open` → `__http_status` (synthesizes the curl header-callback
contract — a `HTTP/1.1 NNN \r\n` status line, then the transport's flattened
`name: value` lines as CRLF lines, then the blank terminator — and captures
content-type/content-length for getinfo) → `__http_read` loop (feeds
WRITEFUNCTION, counts SIZE_DOWNLOAD_T) → `__http_close`.

Decisions worth remembering:

- **Header enum/ABI values are upstream's** (option classes 0/10000/20000,
  CURLINFO type nibbles) so one source compiles against BOTH headers without
  ifdefs. `curl_easy_setopt` classifies its vararg by option number exactly
  like real curl.
- **Timeouts ride setitimer(ITIMER_REAL)+SIGALRM (todos/0044).** The kernel
  EINTRs any parked RPC when a signal is posted (kernel.js `krpc-intr`), so
  a parked `__http_status`/`__http_read` wakes with EINTR; the veneer
  converts that to `CURLE_OPERATION_TIMEDOUT` once the armed deadline passed
  (checked against `gettimeofday` — itself an env-import safe point, which
  forces pending signal dispatch before the flag is read; belt = deadline
  comparison, braces = the handler flag). Foreign-signal EINTRs re-park.
  CONNECTTIMEOUT arms the status phase (headers-arrival, deliberately looser
  than TCP-connect semantics — documented), TIMEOUT the whole perform. The
  SIGALRM handler stays installed after perform — same deal as real libcurl
  without NOSIGNAL.
- **READFUNCTION is buffered**: whole body pulled up front, then staged
  through the transport (upload streaming descoped with multi/cookies/
  proxies/TLS-knobs/PROGRESSFUNCTION).
- **Errno mapping**: open fail → COULDNT_CONNECT (ENOSYS/fetch-disabled →
  UNSUPPORTED_PROTOCOL), status EIO → COULDNT_CONNECT, read -1 →
  RECV_ERROR. Unknown options fail loud: CURLE_UNKNOWN_OPTION + a stderr
  line under VERBOSE (the kernel32 stub precedent).
- **Redirects follow silently** (fetch `redirect:'follow'`);
  FOLLOWLOCATION/MAXREDIRS accepted no-ops, EFFECTIVE_URL = request url.

## The differential harness

`tests/kernel/test_curl_e2e.js` builds `os/curl/test/smoke.c` twice — gucOS
via `os/curl/test/smoke.json` (buildProject over the lib.json), native via
`clang -lcurl` (skips cleanly without clang) — and runs both against one
local Node server. Outputs diff byte-identical after normalizing exactly the
documented divergences: `H <name>` header lines are filtered to an allowlist
and sorted (fetch vs raw wire disagree on transport headers/order/casing);
status lines are reduced to the code (no reason phrase from fetch). Cases:
streamed 200 GET, POSTFIELDS POST, buffered-READFUNCTION POST, 404 (perform
OK + RESPONSE_CODE 404), connection refused (rc=7), total-timeout on a
stalled body (rc=28), escape/unescape. The native leg passed unmodified on
the first full run — the ABI-values-from-upstream decision doing its job.

Gotcha for future veneer work: `strncasecmp` lives in `<strings.h>` in this
libc (POSIX-correct; glibc leaks it through string.h).

Next: 0174 rides this — /bin/code's only platform delta vs its native build
is the run_command() spawn seam.
