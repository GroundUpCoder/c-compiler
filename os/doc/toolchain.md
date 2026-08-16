# The C toolchain

`cc` is the only build tool. One `cc` command compiles all the source
files and links one runnable WebAssembly module. There are no object
files, no archives (`.a`), no shared objects (`.so`), and no `make`.

## The command line

```
cc [-o OUT] [-IPATH] [-DNAME[=VAL]] [-g] FILE.c ...
```

| Flag | Effect |
|---|---|
| `-o OUT` | Write the output to OUT. Default: `./a.out`, mode 0755. |
| `-IPATH` | Add an include directory. Joined form only: `-Isrc`, not `-I src`. |
| `-DNAME[=VAL]` | Define a preprocessor macro. |
| `-g` | Emit a name section for readable stack traces. |

Every other dash option is refused by name: `cc -O2 game.c` exits 1 with
`cc: error: unrecognized option '-O2'`. `-c`, `-Wall`, `-std=…` and
`-fanything` do not exist here. `-l…` is refused with an extra hint —
libraries link through headers (see below), never through `-l`. A `cc`
command with no source file prints the usage line and exits 1.

Name every project source file on the command line:

```sh
cc main.c board.c draw.c -o game
```

The output is directly runnable: `cc hello.c && ./a.out`.

## Include search

For `#include <x.h>` the compiler searches:

1. The builtin system headers (libc, SDL, and the extension headers).
2. `/usr/local/include` (the writable tier — packages install here).
3. `/usr/include` (baked, read-only).

An explicit `-I` directory can shadow a builtin header. An ambient file
in `/usr/local/include` cannot. For `#include "x.h"` the compiler first
searches the including file's directory, then the `-I` directories, then
the lists above.

`/usr/include` also holds a copy of every builtin header. That copy is
documentation — read it to learn an API. The compiler uses its builtin
text.

## How libraries link: `__require_source`

There is no separate linking model. A header can name the `.c` files
that implement it:

```c
__require_source("z/adler32.c");
```

The compiler compiles each required file as one more translation unit of
the same link. Names resolve against `/usr/local/src`, then `/usr/src`.
A builtin name always wins over a planted file. A file that is both
listed and required compiles once — deduplication is by physical path.

Most system libraries carry their own `__require_source` block at the
end of their header. Include the header and compile — no other step:

```c
#include <png.h>   /* the program now links all of libpng and zlib */
```

### The auto-link headers

| Header | Library | Ships in package |
|---|---|---|
| `<zlib.h>` | zlib (15 files) | zlib |
| `<png.h>` | libpng (15 files) | libpng |
| `<jpeglib.h>` | libjpeg (45 files) | libjpeg |
| `<gif_lib.h>` | giflib (4 files, decode only) | giflib |
| `<nsgif.h>` | libnsgif | libnsgif |
| `<libnsbmp.h>` | libnsbmp | libnsbmp |
| `<cJSON.h>` | cJSON (1 file) | cjson |
| `<pixman.h>` | pixman (30 files) | pixman |
| `<cairo.h>`, `<cairo-ft.h>` | cairo (121 files) | cairo |
| `<ft2build.h>` | freetype (12 files) | freetype |
| `<windows.h>` | the win32 veneer | win32 |
| `<gdiplusflat.h>` | gdiplus-mini | win32 |
| `<regex.h>`, `<glob.h>`, `<search.h>`, `<fnmatch.h>` | extension libc | builtin — no package |
| `<math.h>` and the rest of libc | builtin libc | builtin — no package |

### Depend on a package — do not copy it

Each library above is ONE package, and that package is the supported way to
depend on the library. Install it and include its header. Do not copy the
sources into your own project, and do not list another library's translation
units in your own build: a second copy of a library in one program is a
duplicate-symbol link error, and only one package may own a given header.

A package pulls in what it needs. Installing `cairo` also installs `pixman`,
`libpng`, `zlib` and `freetype`, because cairo declares them as dependencies:

```
gucman install cairo
```

Then `#include <cairo.h>` links cairo, and cairo's own sources pull pixman,
libpng, zlib and freetype in behind it. You name one library; you get its
whole graph.

`gucman remove` refuses to remove a package another installed package depends
on, and names the packages that are blocking it.

To get declarations without the sources, define the library's opt-out
macro before the include. Each library names its own: `ZLIB_NO_REQUIRE_SOURCES`,
`PNG_NO_REQUIRE_SOURCES`, `FT_NO_REQUIRE_SOURCES`, and so on — read the
end of the header.

### The opt-in class: libgit2

libgit2 does NOT link automatically. Opt in with one extra include,
AFTER the git2 headers:

```c
#include <git2.h>
#include <git2_srclib.h>   /* links all 211 libgit2 translation units */
```

Install the `libgit2` package first (`gucman install libgit2`). Expect a
long compile — about 19 seconds for the 211 files.

Why it is not automatic: the compile cost, and a conflict. libgit2
carries its own vendored zlib. If `<git2.h>` auto-linked, every program
that also includes `<zlib.h>` or `<png.h>` would fail with duplicate
definitions of `adler32` and `crc32` — even a program that calls no
`git_*` function. `<git2_srclib.h>` also raises the program's stack to
1 MiB, which libgit2 needs.

If you forget the include, the link error tells you the fix:

```
Link error: Undefined symbol 'git_libgit2_init' during linking — libgit2
does not link automatically: add '#include <git2_srclib.h>' after the
git2 headers (shipped by the 'libgit2' srclib package)
```

## `__link_hint` — for library authors

The libgit2 message above comes from a general directive. A header for a
library that deliberately does not auto-link can carry:

```c
__link_hint("git_", "libgit2 does not link automatically: ...");
```

At link time, an undefined symbol whose name starts with the prefix gets
the message appended to its error. The first matching prefix wins.

## Diagnostics

Compile errors print one line per diagnostic:

```
FILE.c:LINE: error: MESSAGE
```

Link errors print:

```
Link error: MESSAGE
  at FILE.c:LINE
```

Common shapes and their causes:

| Message | Usual cause |
|---|---|
| `Could not find include file: X` | Package not installed, or wrong `-I` |
| `Undefined symbol 'X' during linking` | A source file is missing from the command line |
| `Duplicate definition of symbol 'X'` | The same function is defined twice (see the libgit2 note) |
| `unknown required source X` | A `__require_source` name is not under `/usr/local/src` or `/usr/src` — install the library's package |

All diagnostics go to stderr. `cc` exits 0 on success, nonzero on any
error.
