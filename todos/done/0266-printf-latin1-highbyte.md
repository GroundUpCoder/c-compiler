# 0266 — printf %s corrupts bytes 0x80-0x9F (windows-1252 latin1 decoder)

- **Status**: done
- **Design**: —

## Goal

Fixed in the same thread that found it (ticket #81): the host.js printf
family (`formatString`'s `%s` and format text, via `readLatin1`/
`readLatin1Bounded`) decoded C strings with `new TextDecoder('latin1')` —
which per the WHATWG encoding standard is **windows-1252**, not
ISO-8859-1. Bytes 0x80–0x9F map to typographic code points (0x80 →
U+20AC, 0x94 → U+201D, …), and the byte writer's `charCodeAt(i) & 0xFF`
then stores the LOW BYTE of those (0xAC, 0x1D, …). Net effect: ONE
snprintf/`%s` pass corrupted any string containing bytes 0x80–0x9F —
which includes most UTF-8 continuation bytes (the em dash `e2 80 94`
became `e2 ac 1d`). Found because gucOS package summaries rendered
tofu + `?` in the #81 storefront cards.

## Plan

- Test-first: `tests/unit/conformance/snprintf_highbyte_roundtrip/` —
  all 255 nonzero bytes round-trip `%s`, plus the em-dash repro;
  clang-verified golden. Confirmed FAILING pre-fix (exact `e2 ac 1d`).
- host.js: replace the `latin1Decoder` with a `latin1Decode()` that maps
  byte N → char code N for all 256 values (chunked
  `String.fromCharCode.apply`). `readLatin1`/`readLatin1Bounded` are the
  only two users; scanf input (`readLatin1Bounded`) had the same hazard.

## Acceptance

- conformance `snprintf_highbyte_roundtrip` green (was red).
- Existing printf-family unit tests green (11/11).
- Full diff-mapped estate green: unit/host/blockfs, kernel 92/92,
  browser sweep 30/30, flake gate.
