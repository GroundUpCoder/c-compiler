# 0182 — /bin/curl CLI over the os/curl easy veneer

- **Status**: open
- **Design**: `todos/NETWORK.md` (tier 2), `todos/done/0172-kernel-http.md`
  (the 0x06xx transport), `todos/done/0173-libcurl-veneer.md` (the easy
  veneer this links). Residue of `todos/done/0053` (closed 2026-07-15 as
  superseded by 0172/0173 — everything landed except this tool).

## Goal

A small `/bin/curl` tool (NOT a port of real curl's CLI) so the shell can
fetch: `curl -s -o FILE -X METHOD -H HDR -d DATA URL`, exit codes in the
curl idiom (non-zero on transport failure; `-f` for HTTP-error → exit 22).
It links the existing `os/curl/` easy veneer — zero kernel change, zero
veneer change expected.

## Plan

- `os/curl/curl-cli.c` (or `os/curl.c` beside the other tools) over
  `curl_easy_*`: flags `-s`, `-o`, `-X`, `-H` (repeatable), `-d`, `-f`,
  `-L` (accept — redirects already follow), default = body to stdout,
  status line to stderr unless `-s`.
- Seed as `/bin/curl` in `os/image.json` (+ version bump).

## Acceptance

- `tests/kernel/test_curl_e2e.js` grows a CLI leg: boot.js, local Node http
  server, `curl URL` prints the body; `-d` POST round-trips; refused
  connection exits non-zero.
- Browser CORS asymmetry inherited from 0172 — documented, not re-tested.
