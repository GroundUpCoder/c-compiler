# cJSON (vendored)

Upstream: https://github.com/DaveGamble/cJSON — tag **v1.7.19**, MIT
(LICENSE alongside). Vendored 2026-07-13 for todos/0174 (`/bin/code`'s
Messages-API JSON handling); fetched verbatim from the tag, zero patches.

    298581a04a36c0165da4b0aade235c23088cb2faa58651d720ea2f3706ed0b0d  cJSON.c
    25b0145150d500498e4d209cec69c18c42cf818bffcc54690be3b895a2a16dee  cJSON.h

Single-file C89 JSON parser/printer; ILP32-clean (uses `int`/`double`;
no 64-bit-long assumptions), so it compiles for both native (clang) and
gucOS (compiler.js) without a port layer. Consumers list
`vendor/cjson/cJSON.c` directly in their sources (no bin.json here — it's
a library, not a binary).
