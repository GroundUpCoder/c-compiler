# 0325 — libc surface gaps found by the CPython/numpy M0 probe

- **Status**: open
- **Priority**: P1 (missing surface, not defects)
- **Difficulty**: medium
- **Design**: —
- **Provenance**: `todos/0313`. One ticket rather than forty: these are all the
  same kind of thing — standard C or POSIX that wasi-libc/musl/glibc have and
  compiler.js's builtin header set does not. Grouped by whether the consumer can
  configure around the absence.

## Group A — NO configure escape (a port MUST have these)

CPython calls these unconditionally; there is no `HAVE_*` to turn off.

| symbol | header | consumer |
|---|---|---|
| `fma` | `<math.h>` | `Modules/mathmodule.c` |
| `gmtime_r` | `<time.h>` | `Python/pytime.c` |
| `clock_getres` | `<time.h>` | `Python/pytime.c` (inside `#ifdef HAVE_CLOCK_GETTIME`, itself unguarded) |
| `wcstol` | `<wchar.h>` | `Python/initconfig.c` |
| `isascii` | `<ctype.h>` (XSI) | `Modules/_decimal/_decimal.c` |
| `tzset` | `<time.h>` | `Modules/timemodule.c` when `struct tm` has no `tm_zone` |

Also in this group, an ordering problem rather than an absence:
**`clockid_t` and `struct timespec` are declared only in `<time.h>`**, while
CPython (like musl and wasi-libc) expects them visible via `<sys/types.h>`
before `Include/cpython/pthread_stubs.h` is reached. Symptom is a confusing
`type specifier missing` at `pthread_stubs.h:78`.

## Group B — has a `HAVE_*` knob, but absence costs a real feature

| symbol(s) | note |
|---|---|
| `struct tm::tm_zone` | compiler.js's `<time.h>` has `tm_gmtoff` but not `tm_zone`. Shipping one without the other is the surprising half; without it `timemodule` falls back to `tzset()`+`strftime`. |
| `explicit_bzero` | `Modules/_blake2`'s only alternative is a GCC inline-asm memory barrier, which we also lack. |
| `memrchr` | `Objects/bytes*`, `Objects/unicodeobject.c` — real perf path. |
| `strsignal` | `Modules/signalmodule.c` |
| `getentropy` | `Python/bootstrap_hash.c` — matters for hash randomisation. |
| `truncate` | `Modules/posixmodule.c` |
| `confstr`, `pathconf`, `fpathconf` | `Modules/posixmodule.c` |
| `posix_fadvise`, `posix_fallocate` | `Modules/posixmodule.c` |
| `clock_nanosleep`, `TIMER_ABSTIME`, `wcsftime` | `Modules/timemodule.c` |
| the `*at()` family — `openat`, `fstatat`, `faccessat`, `linkat`, `mkdirat`, `renameat`, `unlinkat`, `readlinkat`, `symlinkat`, `futimesat`, plus `AT_EACCESS`/`AT_REMOVEDIR`/`AT_SYMLINK_FOLLOW` | `Modules/posixmodule.c`. Turning these off costs `os.*` dir-fd support. |
| `RTLD_NODELETE`, `RTLD_NOLOAD` | `<dlfcn.h>` |
| `timegm` | `Modules/timemodule.c` (CPython has its own fallback) |

## Group C — headers absent entirely

`netinet/in.h`, `netinet/tcp.h`, `arpa/inet.h` — the only thing blocking
`Modules/socketmodule.c`, the sole CPython core TU that never got through the
probe's front end. Out of scope for a first `/bin/python`, but this is what
`import socket` costs.

Also absent: `<complex.h>` and the `_Complex` types (see below), `features.h`
(a glibc-ism, correctly absent — consumers should be configured off),
`stropts.h`, `sysexits.h`, `sys/eventfd.h`, `sys/random.h`, `sys/syscall.h`,
`sys/uio.h`, `pthread.h` (correctly absent — CPython uses its own stubs).

## Group D — numpy

Found by the same probe's folded-in numpy leg (numpy 2.2.6).

- **~25 `long double` libm entry points**: `sinl cosl tanl sinhl coshl tanhl
  expl exp2l expm1l logl log2l log10l log1pl powl sqrtl fabsl floorl ceill
  fmodl hypotl atan2l copysignl fmaxl fminl modfl frexpl ldexpl asinl acosl
  atanl atanhl nextafterl`. On this target `long double` **is** `double`
  (`SIZEOF_LONG_DOUBLE 8`), so these are aliases. Note they must be real
  **functions**, not macros: numpy takes their addresses for dispatch tables,
  and a function-like macro does not expand there.
- **C99 `<math.h>` comparison macros**: `isgreater`, `isgreaterequal`, `isless`,
  `islessequal`, `islessgreater`, `isunordered`.
- **`__builtin_isnan` / `__builtin_isinf` / `__builtin_isfinite` /
  `__builtin_prefetch`** — numpy's meson probe finds them on clang and then
  emits calls. Either provide them or make sure a port configures them off.
- **POSIX xlocale**: `locale_t`, `newlocale`, `freelocale`, `strtold_l`
  (`numpy/_core/src/multiarray/numpyos.c`; numpy has a `HAVE_STRTOLD_L` fallback).
- **`<complex.h>` / C99 `_Complex`** — the single biggest numpy gate. See the
  0313 report: numpy 2.x already has a struct-complex path plus
  `npy_creal`/`npy_cimag`/`npy_csetreal` accessors, but they are gated on
  `__cplusplus` only. Extending those 7 guard sites to
  `|| defined(__STDC_NO_COMPLEX__)` took the numpy front-end sweep from
  5/164 to 83/164 TUs with no compiler change at all. So implementing
  `_Complex` is **not** a prerequisite for numpy — it is one of two routes.

## Group E — found by the M1-clang stdlib probe (2026-07-28, `todos/CPYTHON.md` §3)

The M0 probe could not see these: they only surface when the stdlib's C
extension modules are actually built (the M1-clang design pass probe-built
26 of them; log: `logs/2026-07-28/m1-clang-stdlib-design.md`).

| gap | consumer | note |
|---|---|---|
| `ELOOP` missing from `errno.h` | `Modules/errnomodule.c` → `errno.py` → **`pathlib`, `zipfile`, `zipapp`, `compileall` fail to import** | the kernel already RAISES it as **40** (`host.js:10687`, the SYMLOOP_MAX walk; `kernel.js:2381` remarks on the libc absence) — one `#define ELOOP 40` + a strerror line, numbering must match host.js |
| termios surface: `tcsendbreak`/`tcdrain`/`tcflush`/`tcflow`, `B0`–`B38400` baud constants, `TCIFLUSH`/`TCOFLUSH`/`TCIOFLUSH` | `Modules/termios.c` → `tty`, `pty`, `_pyrepl` interactive | the four functions are near-no-ops on a gucOS pty; constants are the bulk |
| `ioctl` prototype is `(int, unsigned long, void *)`, not variadic | `Modules/fcntlmodule.c` passes an `int` arg | either make it variadic like POSIX or carry the one-cast vendor patch (CPYTHON.md §4.2 chose the patch; a variadic libc `ioctl` would retire it) |

Sequencing note: these land in compiler.js's libc but reach the **clang**
toolchain only through the `todos/0330` re-vendor (the 206-commit staleness)
— which is why `todos/0340` carries a soft dep on 0330.

## Plan

Land Group A first — it is small, and it is the part no port can work around.
Group B next, since each entry is a `HAVE_*` that silently costs a Python
feature. Group C and D are gated on whether the pygame arc proceeds
(`todos/0313`'s verdict). Group E is funded via `todos/0340` (M1-clang) and
can land there with a cross-off here.

## Acceptance

- Group A present, with tests.
- A short note in the report/docs recording, per Group B entry, which Python
  feature its absence disables — so a port's `pyconfig.h` is a deliberate set of
  choices rather than a pile of `#undef`s.
