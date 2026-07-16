# busybox: attributes un-swallowed, 64-bit uoff_t — cold bakes unbroken (todos/0231)

Found by the 0229 gate: bumping image.json to v104 forced the first COLD
busybox rebuild since the 0227/G22 parser change (6970269, "diagnose
negative array sizes"), and `node tools/mkimage.js` failed in every busybox
TU. Neither failure was a compiler bug — both were busybox compile-asserts
(`char x[-1]` idioms) that have been legitimately FIRING since the port
landed, silently accepted by the pre-0227 compiler.

Why no gate caught it at 0227 time: nothing rebuilds busybox from cold. The
image-fixture staleness check is mtime-based and the prebaked fixture was
newer than compiler.js's checkout mtime, so every suite ran off the fixture.
(Follow-up idea recorded in todos/0231: a cold-bake tripwire.)

## Assert 1 — `BUG_off_t_size_is_misdetected` (libbb.h)

The port builds with `CONFIG_LFS` off; that branch assumes
`sizeof(off_t)==sizeof(long)` (4 on ILP32), but this libc's `off_t` is
`long long` (8). So `uoff_t` was 4-byte against an 8-byte `off_t` and
`OFF_FMT "l"` popped 4 bytes of an 8-byte printf vararg (latent size
misformatting in ls/dd/tar/cksum/…). Fix: a `__wasm__` branch in the !LFS
`uoff_t` block — `unsigned long long uoff_t`, `XATOOFF`/`BB_STRTOOFF`/
`STRTOOFF`/`OFF_FMT` switched to the long-long family. (Rejected
alternative: `CONFIG_LFS=y`, which regenerates autoconf.h and flips code
paths across all applets for the same net effect.)

## Assert 2 — `BUILD_BUG_ON(sizeof(header) != 8)` (decompress_gunzip.c)

The deeper find: platform.h's non-GNU fallback (`#if !__GNUC_PREREQ(2,7)`)
defines `__attribute__(x)` to NOTHING, and this compiler doesn't define
`__GNUC__` — so EVERY attribute in busybox has been swallowed since the
port landed. `PACKED` structs weren't packed: the gzip header union was 12
bytes, its BUILD_BUG_ON fired invisibly, and `check_header_gzip` read the
gz mtime from the wrong offsets (harmless-looking because mtime is only
used for `gzip -N` timestamps). This compiler parses and honors
`__attribute__` (packed/aligned/always_inline/noreturn/…, unknown names
skipped), so the fix is to stop the swallow under `__wasm__` — busybox now
builds with upstream-true attribute semantics rather than a silently
different ABI.

Both patches carry rows in `vendor/busybox/README.md`'s patch table.

## Gate

Covered by the 0229 gate (the busybox rebuild is the risk surface —
attributes now live across hush + the 81-applet multicall): full kernel
suite 75/0 (hush is pid 1 under every e2e; tar/gzip/find/awk spawn legs
included), browser sweep green.
