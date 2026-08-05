# Batch B — libc surface gaps: #111 search.h, #112 random(), #114 memory streams, #115 wide scanf

One lane, one branch, one gate. Eight libc-test rows go skipped → pass:
`search_hsearch` `search_insque` `search_lsearch` `search_tsearch` (#111),
`random` (#112), `memstream` (#114), `wcstol` `fwscanf` (#115). Liability
register entries L25/L26/L28/L29 retired with their skips.

## #114 — the design call: stdio had no seam, so the seam is the work

`FILE` was hard-wired to fds: `read()`/`write()`/`lseek()`/`close()` called
directly from ~10 sites in `__stdio.c`. Rather than bolting a special-cased
buffer type onto the side, `FILE` grew a funopen/fopencookie-shaped seam —
`cookie` + `io_read`/`io_write`/`io_seek`/`io_flush`/`io_close`, NULL meaning
fd-backed — and every direct syscall site now dispatches through
`__raw_read`/`__raw_write`/`__raw_seek`. Cookie streams therefore inherit
buffering, ungetc, scanf, and the printf family for free. `io_flush` is the
one extension over the classic four: open_memstream must republish its
buffer/size at every fflush (POSIX), and flushing is not expressible through
write alone. `open_memstream` and `fmemopen` are the first consumers (logic
restated from musl 1.2.5); a public funopen/fopencookie would now be a
trivial follow-up, deliberately not added without a consumer ticket.

Fixing a latent stdio bug was REQUIRED by the memstream test: fseek reset
the buffer state BEFORE seeking, so a *refused* seek (EINVAL on a negative
target) trashed the read-ahead and lost the logical position. The test
asserts `ftell` survives a failed `fseek` on both stream kinds. All of
fseek/fseeko/fsetpos now seek first and reset only on success — strictly
more correct for fd streams too.

## #111 — vendored musl search.h into ext/

`ext/` is exactly the designated home (POSIX pieces too big to inline, own
public header). musl 1.2.5 `src/search/` vendored near-verbatim; local mods
recorded in `ext/README.md` (lsearch's VLA-typed pointer rewritten — this
compiler rejects VLAs; hsearch's `weak_alias` replaced by defining the GNU
`h*_r` names directly; the `hidden`/`features.h` shims). One core fix rode
along: the malloc family never set `errno` — POSIX requires ENOMEM on
failure, and the hsearch test asserts it through `hcreate((size_t)-1)`.
malloc/calloc/realloc now set ENOMEM on every genuine allocation failure
(not on malloc(0)).

## #112 — musl random(), byte-identical

Ported musl 1.2.5 `src/prng/random.c` inline into `__stdlib.c` (locks
stripped — single-threaded target; names prefixed `__rnd_` against the
combined-TU namespace). The test demands the default sequence ==
initstate(1) == srandom(1) and 31-bit statistical properties; a bespoke
PRNG cannot satisfy the state-array contract, so porting was the only
honest move.

## #115 — mostly a stale skip, plus wide scanf

`wcstol`/`wcstoul`/`wcstoll`/`wcstoull`/`wcstod` ALREADY EXISTED — shipped
by todos/0325 Group A for CPython, while the 0309 skip entry sat unretired
(the exact fnmatch/fdopen/utime pattern the skip table's own comment warns
about). The one real gap the test found: no EINVAL on an invalid base
(base 37 must return 0/endptr=nptr/EINVAL). Fixed in `__wcstoull_core`.

Wide scanf is new: `fgetwc`/`getwc(char)`/`ungetwc`/`fputwc`/`putwc(char)`/
`fgetws`/`fputws` decode/encode UTF-8 over the byte streams, and
`vfwscanf`/`fwscanf`/`wscanf`/`vswscanf`/`swscanf`/`vwscanf` transcode the
wide FORMAT (and for swscanf the wide input) to narrow and delegate to the
byte scanf machinery — the same trade wcstod already makes, exact for every
single-byte character in the C locale. Documented divergence: field widths
and %n count bytes, not wide chars, on multi-byte input. `fwprintf` and
`fwide` are deliberately absent rather than stubbed (API honesty rule);
ungetwc refuses (WEOF) a multi-byte pushback rather than corrupting the
stream — the byte ungetc slot is one byte, and C guarantees only one
pushback.

Not absorbed silently: the remaining wide-locale skips (`clocale_mbfuncs`,
`mbc`, `swprintf`) are locale-machinery gaps, not wide-scanf gaps — they
stay skipped under their own entries.
