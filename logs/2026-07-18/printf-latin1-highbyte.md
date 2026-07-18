# printf %s corrupts bytes 0x80–0x9F — the windows-1252 "latin1" trap (todos/0266)

Found while building the #81 storefront (`logs/2026-07-18/software-storefront.md`):
package summaries containing an em dash rendered as tofu + `?` on the
cards. The byte pipeline was chased stage by stage — repo file clean,
`gucman index > file` in-OS clean (`e2 80 94` intact on BlockFS), cJSON
verbatim, the app's fold routine proven correct under the target
compiler — until a minimal in-OS repro pinned it:

```c
snprintf(b, sizeof b, "%s", "\xe2\x80\x94");   /* -> e2 ac 1d (!) */
```

## Root cause

host.js's `readLatin1`/`readLatin1Bounded` — the printf/scanf byte-
transparent string readers — used `new TextDecoder('latin1')`. Per the
WHATWG encoding standard, the `latin1` label resolves to **windows-1252**,
not ISO-8859-1: bytes 0x80–0x9F decode to typographic code points
(0x80 → U+20AC, 0x94 → U+201D, …). The byte writer (`writeString`,
`charCodeAt(i) & 0xFF`) then truncates those code points to their low
byte: 0x80 → 0xAC, 0x94 → 0x1D. Net: ONE `%s` pass corrupts exactly the
0x80–0x9F range — which is most UTF-8 continuation bytes, so any
formatted non-ASCII text was mangled (`e2 80 94` → `e2 ac 1d`; the
mangled pair then renders as U+FFFD tofu + a `.notdef` glyph, the
tofu-plus-`?` seen on the cards).

The comment on `readLatin1` even says "1:1 byte-to-char mapping / bytes
must round-trip exactly" — the intent was right, the decoder label lied.

## Fix

`latin1Decode()`: chunked `String.fromCharCode.apply` over the raw
bytes — byte N → char code N for all 256 values, no encoding table
involved. Both readers switched; they were the only `latin1Decoder`
users (scanf input shared the same hazard).

Test-first: `tests/unit/conformance/snprintf_highbyte_roundtrip/` —
all 255 nonzero bytes round-trip `%s` + the em-dash repro,
clang-verified golden; confirmed red pre-fix (exact `e2 ac 1d`), green
post-fix. Existing printf unit tests 11/11 unchanged.

## Debugging notes worth keeping

- `wmctl settext`/`gettext` round-trips W-translate (UTF-8↔UTF-16) at
  user32's send_msg choke — a byte-level probe through a UNICODE app's
  EDIT measures the translation layers too, not just storage. The
  decisive repro was plain C compiled in-OS, not the GUI.
- gdi32 renders a malformed UTF-8 pair as U+FFFD tofu and a stray
  control byte via glyph 0 (`.notdef`, `?`-shaped in this face) — "one
  bad char, two odd glyphs" is a malformed-bytes signature, not a
  missing-glyph one.
