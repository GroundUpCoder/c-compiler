# M1-clang design pass — how the CPYTHON.md numbers were measured

Lane `m1-clang-design`, 2026-07-28. Deliverable: `todos/CPYTHON.md` (the
design), `todos/0340` (execution ticket), updates to 0331/0313/0325. This log
is the probe narrative so the implementing lane can reproduce every number
without re-deriving the gotchas.

All probes ran against the machine-local build root `~/build/python-clang`
(pristine CPython 3.13.5 in `cpython/`, wasi-configure outputs in `ccbuild/`
— NOT in git; reproduction elsewhere = re-run a wasi-sdk configure per
`logs/2026-07-27/python-clang-build.sh`'s header, or wait for 0340 to commit
the tree) and the repo's `host.js` as the runner.

## The import sweep (the casualty list's source)

A probe script enumerates top-level stdlib modules off the Lib dir (excluding
test/idlelib/tkinter/turtledemo), `__import__`s each, records
failure-type+message. Run:

```sh
cd ~/build/python-clang && PYTHONHOME=$PWD/cpython PYTHONPATH=$PWD/cpython/Lib \
  node ~/git/c-compiler/host.js python-clang.wasm probe.py
```

- 0331 baseline binary (4,529,136 B): **110/183 OK**. Nearly all failures
  are 4 missing C modules cascading: `math`, `_struct`, `_opcode`,
  `binascii` (e.g. `dataclasses`→`inspect`→`dis`→`_opcode`;
  `datetime`→`math`; `pickle`→`_struct`).
- Expanded probe binary (below): **154/183 OK**; the 29 residual failures
  and their causes are tabulated in CPYTHON.md §3.3.

Two findings that read like port bugs and are not: `PYTHONHOME` alone makes
`os.__file__` report `<home>/lib/python3.13` (the PLATLIBDIR layout) while
files load via `PYTHONPATH` — don't mix the two when probing; and
`ModuleNotFoundError: encodings` = path wiring, not a broken binary
(`cpython-m0-reprobe-harness.md` trap, re-confirmed).

## The expanded-inittab probe build (the §3.2 evidence)

Recipe deltas from `logs/2026-07-27/python-clang-build.sh` (212-TU list):

1. `config.c`: take `ccbuild/Modules/config.c`, inject 26 extern
   `PyInit_*` declarations + inittab entries (list in CPYTHON.md §3.2).
2. srcs: + the 26 module TUs, + `Modules/_hacl/Hacl_Hash_{MD5,SHA1,SHA2,SHA3}.c`,
   + `Modules/_blake2/{blake2module,blake2b_impl,blake2s_impl}.c`,
   + expat via three wrapper TUs (`#undef PREFIX` then `#include` the real
   file — the recipe's global `-DPREFIX='"/usr/local"'` collides with
   expat's typedef), + `rotatingtree.c`.
3. extra flags: `-DXML_NS=1 -DXML_DTD=1 -DBYTEORDER=1234
   -DXML_CONTEXT_BYTES=1024 -DXML_GE=1 -I Modules/_hacl/include -I Modules/_hacl
   -I Modules/expat -I Modules/_blake2`.
   ⚠️ do NOT pass `-DUSE_ZLIB_CRC32=0` — binascii's guard is `#ifdef`, and
   defining it to 0 still includes `zlib.h`.
4. Dropped after real errors (design carries them as patches/gaps, CPYTHON.md
   §3.2): `fcntlmodule.c` (libc `ioctl` is `(int, unsigned long, void*)`,
   CPython passes int — one cast), `termios.c` (libc lacks
   tcsendbreak/tcdrain/tcflush/tcflow, B* baud, TC*FLUSH → 0325 Group D).

Result: links clean. **6,075,539 B** (baseline 4,529,136; Δ +1,546,403 for
26 extensions; gzip -9 → 1,708,897). Functional smoke green (math, struct,
hashlib.sha256, datetime, random, csv, array, unicodedata.name, statistics,
decimal, base64, pickle round-trip, xml.etree parse, inspect/dis/unittest/
dataclasses/pprint/select imports). Startup `-c "print(1)"`: **0.142 s wall**
including node boot.

## Wiring verifications

- **Landmark discovery**: binary copied to `<pfx>/bin/python-clang`,
  `<pfx>/lib/python3.13` a symlink to Lib, NO env vars → correct sys.path.
  Repeated with argv0 itself a symlink from another dir → `sys.prefix` =
  the real prefix. (In-OS re-check is a 0340 acceptance item.)
- **sysconfigdata**: dropping a one-line `_sysconfigdata__unknown_.py`
  (`build_time_vars = {...SOABI...}`) into Lib fixes `pydoc`, `sysconfig`,
  `zoneinfo` import — confirmed live. `sys.platform` is `"unknown"` (no
  `-DPLATFORM`); design sets `gucos`.
- **ELOOP**: `compiler.js` errno.h has no `ELOOP` (kernel.js:2381 even
  remarks on it) while BlockFS really raises it as **40**
  (`host.js:10687`, SYMLOOP_MAX walk) — so `errno.py`'s `from errno import
  ELOOP` consumers (pathlib!) die. One `#define ELOOP 40` + strerror entry;
  sibling libc needs the 0330 re-vendor to receive it.
- **subprocess**: `Lib/subprocess.py:106` unconditional `fork_exec` import;
  `_use_posix_spawn()`/`Popen._posix_spawn` complete; libc has posix_spawn +
  file_actions (compiler.js:25550ff); pyconfig `HAVE_POSIX_SPAWN` currently
  undef. → the §3.5 patch route.

## Sizes (rule set)

`Lib/` minus {test, idlelib, tkinter, turtledemo, ensurepip, turtle.py,
`__pycache__`}: **548 files, 9,914,191 B**, tar.gz **2,353,854 B**.
For the record: test/ 32.4 MB, ensurepip/ 1.8 MB (pip wheel), turtle.py
145 KB; encodings/ 1.42 MB, pydoc_data/ 0.53 MB. Vendor-tree commit weight
estimate ~27 MB (TU sources 11.8 MB measured + Include 2.34 MB + gen/
1.48 MB + Lib 9.9 MB + headers/clinic ~2 MB estimated).

## Ticket-id note for master

0337/0338/0339 were found TAKEN across branches at design time; this lane
allocated **0340** off freshly-fetched origin/main (0493dff6). An unpushed
lane is invisible to that check — reconcile at merge if collided.
