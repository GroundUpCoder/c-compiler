# ext/ — optional libc extensions (libc-ext.js)

`compiler.js` is self-contained for the **ISO C (C89/99/11)** standard library
plus a few handwritten goodies. POSIX / 3rd-party pieces that are too big to
inline live here and are bundled into an **optional** sibling file,
`libc-ext.js`. The compiler is fully functional without that file; when it sits
next to `compiler.js`, the headers and sources below become available
(`#include <regex.h>`, `<fnmatch.h>`, `<glob.h>`, `<search.h>`).

## Layout

- `include/` — handwritten public headers (`regex.h`, `fnmatch.h`, `glob.h`,
  `search.h`) and a `locale_impl.h` shim. Each public header
  `__require_source(...)`s the translation units it needs.
- `src/` — vendored upstream C (lightly modified; see below).

## Regenerate

```
node tools/build-libc-ext.js      # ext/ -> libc-ext.js  (do not hand-edit libc-ext.js)
```

`libc-ext.js` is a JSON-parseable `const EXT_LIB_MAP = { name: text, ... }`
keyed by basename. `compiler.js` reads it via its own directory (Node) or the
mounted path (browser shim) and merges the entries into the stdlib lookup.

## Provenance & licenses

Vendored from **musl 1.2.5**:

- `regcomp.c`, `regexec.c`, `regerror.c`, `tre-mem.c`, `tre.h` — the **TRE**
  POSIX regex engine, **2-clause BSD**, © 2001–2009 Ville Laurikari, heavily
  modified by Rich Felker for musl. License text is retained in each file.
- `fnmatch.c`, `glob.c` — musl's own, **MIT**, © musl contributors.
- `hsearch.c`, `tsearch.c`, `tfind.c`, `tdelete.c`, `twalk.c`, `tdestroy.c`,
  `lsearch.c`, `insque.c`, `tsearch.h` — musl's `src/search/` (POSIX
  `<search.h>`, ticket #111), **MIT**, © musl contributors.

### Local modifications

- `tre.h` — added an `#ifndef hidden / #define hidden / #endif` shim: this build
  emits no symbol-visibility attributes, so musl's internal `hidden` marker is
  neutralized. (One block, clearly commented.)
- `tsearch.h` — the same `hidden` shim, and `<features.h>` dropped (this libc
  has no feature-test header).
- `hsearch.c` — no `weak_alias` mechanism in this build, so the internal
  `__h*_r` functions are defined directly under their public GNU `h*_r` names
  (declared in `search.h` under `_GNU_SOURCE`); the alias lines are gone.
- `lsearch.c` — upstream walks the table through a `char (*)[width]`
  VLA-typed pointer, which this compiler rejects; rewritten with plain byte
  arithmetic (identical addresses, clearly commented).
- `search.h` — `<features.h>`/`<bits/alltypes.h>` replaced by `<stddef.h>`,
  and the `__require_source(...)` lines added, matching the other headers.

Everything else is verbatim upstream. The two compiler.js fixes this engine
surfaced (object→function-like macro rescan; braced char-array string init) are
in `compiler.js`, not patched into the sources.

## Compiler-side glue (in core compiler.js, not here)

- `iswctype()` / `wctype()` in `__wchar.c` + `wctype.h` (ISO C95).
- `RE_DUP_MAX`, `CHARCLASS_NAME_MAX`, `NAME_MAX` in `limits.h` (POSIX).
