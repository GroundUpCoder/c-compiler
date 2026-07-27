# CPYTHON.md — CPython on gucOS: the vendor tree, the stdlib, and the `python-clang` package (M1-clang design)

Status: **DESIGN, ratified route** — designed 2026-07-28 by the M1-clang design
lane. Funding provenance: jku's lean ("python-clang as the preferred python …
a python that has the highest chance of being able to support pygame in the
future", email 2026-07-27 ~23:30), executed by a decider call under the
standing don't-sit-blocked authorization — see the meta note
`fable-decider-python-primary-2026-07-27.md`, section "jku LEAN". jku may
overturn. Implementation is `todos/0340` (vendor tree + stdlib + expanded
binary) then `todos/0331` (the package + e2e), in that order.

Every number in this document was **measured on 2026-07-28** against the
machine-local build root `~/build/python-clang` (pristine CPython 3.13.5 +
the wasi-configure-generated `ccbuild/`) and probe builds under `/tmp` — none
is inherited from a ticket. Where something could NOT be measured it says
**unmeasured**. Probe narrative + reproduction: `logs/2026-07-28/m1-clang-stdlib-design.md`.

Two consumers, one tree: everything here except §4's toolchain notes is
**shared with the eventual our-compiler CPython build** (gated on `todos/0336`
exactly as decided — this design routes around the 2.5 s startup wall, it does
not fix it; the clang binary starts `-c "print(1)"` in **0.142 s wall**
host-side, measured, node boot included).

---

## 1. Decisions at a glance

| axis | decision | where |
|---|---|---|
| module selection | **exclusion-rule**, not allowlist: ship all of `Lib/` minus 6 justified exclusions | §2 |
| stdlib payload | 548 files, **9,914,191 B** installed, **2,353,854 B** gzip | §2 |
| binary | expanded inittab: **+26 static extensions**, 6,075,539 B (probe-verified link + import sweep) | §3 |
| C-extension casualties | named, with causes and unblock paths — nothing left to be "discovered later" | §3.3 |
| vendor tree | `vendor/cpython/` in THIS repo, sources + generated `gen/` + `Lib/`, patch-table README | §4 |
| layout / PYTHONHOME | prefix layout `/opt/python-clang/{bin,lib/python3.13}`; **zero env vars** — argv0-landmark discovery, symlink-safe (both verified) | §5 |
| pyc cache | `PYTHONPYCACHEPREFIX=/var/cache/python-clang` via launcher wrapper (keeps `/opt` pristine for gucman's checksum-gated remove) | §5.3 |
| package | `packages/python-clang.json`: `clangApp` binary + `tree` stdlib; bin verb `python-clang` only; `commands` claim for the 0338 dispatcher | §6 |
| delivery | automatic: the clang channel is the deploy DEFAULT since 0337 (live on production); the drift gate makes a missing package def a build FAILURE | §6.3 |
| `python3`/`cpython` names | recommend **cmdalt keys** (0338 mechanism), not hard symlinks — avoids the future two-CPython collision; needs a master/jku call | §6.2 |
| pygame trajectory | M2/M3 scoped, SDL2-vs-SDL3 mismatch flagged + priced, NOT built here | §8 |

## 2. Module selection — the rule, then the list it produces

**Rule: ship every file under `Lib/` except entries on the fixed exclusion
list below. Each exclusion must cite one of exactly three reasons: (a) it
depends on a C substrate that can **never** exist on gucOS, (b) it is a
development corpus / installer machinery that cannot function here and
carries large dead weight, or (c) it depends on a substrate that is **absent
today but not impossible** — a scheduling statement, which must name the
ticket that revisits it.** Anything not excluded ships even if it cannot
import today: a module whose C extension is missing fails with an honest
`ModuleNotFoundError`, costs only its file size, and starts working the day
its extension lands — with **no package-definition change and no re-curation**.
The rule is category-based, so it does not rot across CPython point releases;
a new upstream module ships by default.

The exclusion list (against 3.13.5):

| excluded | reason | size |
|---|---|---|
| `test/` | (b) dev corpus | 32.4 MB |
| `idlelib/` | **(c)** needs `_tkinter` (Tcl/Tk). **Not scheduled; priced separately by `todos/0346`.** NOT impossible — see the note below. | — |
| `tkinter/` | **(c)** same — `todos/0346` | — |
| `turtledemo/` | **(c)** same — `todos/0346` | — |
| `turtle.py` | **(c)** same — `todos/0346` | 145,215 B |
| `ensurepip/` | (b) 1.8 MB, mostly a bundled pip wheel; pip needs `_ssl` + networking that gucOS does not have (§3.3) — revisit with the network stack (`todos/0052`/`0054`) | 1.8 MB |
| `__pycache__/` dirs | (b) build-host artifacts | — |

⚠️ **Why the Tk family moved from (a) to (c) (corrected 2026-07-28).** It was
previously labelled **(a)** — *"depends on a C substrate that can never exist"* —
with the reason written in the cell as *"no port exists or is planned"*. Those
are two different claims: the label is a **platform** claim, the reason is a
**roadmap** claim. `ctypes` is genuinely rule (a) — gucOS has no `dlopen`, so no
amount of work makes it possible. Tcl/Tk is merely **unbuilt**: large, unfunded,
and a second GUI road to where `pygame` already goes, but not impossible.

**A rule-(a) label is what stops anyone ever re-examining an exclusion** — and
jku re-examining exactly this is what produced `todos/0346`. Rule (c) exists so
that a "not now" cannot masquerade as a "not ever".

**Result (measured): 548 files, 9,914,191 bytes installed; `tar.gz`
2,353,854 bytes.** (538 of the files are `.py`; the 13 non-`.py` are venv
activation scripts and similar, individually tiny — not worth a third
exclusion category.) Largest members, for the record: `encodings/` 1.42 MB,
`pydoc_data/` 0.53 MB, `asyncio/` 0.52 MB, `email/` 0.39 MB. `encodings` and
`pydoc_data` stay: codec availability is exactly the "runs unmodified" axis
the pygame goal cares about, and `help()` is part of a credible REPL.

**Size budget (the honest totals).** Installed under `/opt/python-clang`:
binary 6,075,539 + stdlib 9,914,191 ≈ **16.0 MB**. Download payload (two
gzip streams): 1,708,897 + 2,353,854 ≈ **4.06 MB**. Because jku ruled CPython
ships as a **gucman package, never baked**, this costs the base image
**zero bytes** — the ~23 MB minimal image is untouched, and the 16 MB lands
only on machines whose user ran `gucman install python-clang`. For scale:
MicroPython's package is ~556 KB; that gap is the price of "highest chance of
supporting pygame", and it is opt-in.

**Rejected alternative — zip stdlib.** `<prefix>/lib/python313.zip` is
already on the default `sys.path` (verified), so a single-file zipped stdlib
(the Windows-embeddable pattern, optionally with precompiled `.pyc`) would
work and cut install to ~1 file / ~10 MB stored. Deferred, not refused: it
couples to zlib-in-binary for deflate, complicates `inspect.getsource`/
tracebacks, and the plain tree is what every other gucOS package looks like.
Filed as a follow-up idea inside `todos/0340`, to be picked up only if
548-file installs measurably hurt.

## 3. The C-extension story

### 3.1 Where the shipped recipe actually stands (measured, not inherited)

The 0331 binary's `Modules/config.c` inittab is **core-only**: 32 entries
(builtins/sys/marshal/_imp plus `posix`, `time`, `_io`, `_sre`, `_thread`
stubs, etc. — the wasi configure's minimum). An import sweep of all 183
shippable top-level stdlib modules against that binary: **110 import, 73
fail** (plus excluded ones). The failures are almost all four missing
workhorses — `math`, `_struct`, `_opcode`, `binascii` — cascading through the
pure-Python stdlib (`datetime`, `random`, `decimal`, `pickle`, `inspect`,
`unittest`, `dataclasses`, `zipfile` … all dead). **The bare recipe binary is
far weaker than "CPython at functional parity" reads** — the parity checks
that phrase came from exercised only the pure core.

### 3.2 Tier 1 — the expanded inittab (probe-BUILT and import-swept, not estimated)

Design: the vendor tree's `config.c`/source list add these **26 statically
linked extensions** (all self-contained under `Modules/`, no external
libraries):

> `math`, `cmath`, `_struct`, `_opcode`, `_random`, `_contextvars`, `_csv`,
> `binascii`, `array`, `_heapq`, `_bisect`, `_datetime`, `_json`, `_pickle`,
> `select`, `_lsprof`, `_statistics`, `unicodedata`, `_md5`, `_sha1`,
> `_sha2`, `_sha3`, `_blake2`, `pyexpat`, `_elementtree`, `_zoneinfo`
> (+ support TUs: 4× `Modules/_hacl/Hacl_Hash_*.c`, 3× `Modules/expat/`
> {xmlparse,xmlrole,xmltok}, `rotatingtree.c`, 3× `Modules/_blake2/*.c`)

This exact set was **probe-built on 2026-07-28** (212-TU list, cc2wasm, same
recipe flags): it **links**, the result is **6,075,539 B** (Δ +1,546,403 over
the 4,529,136 baseline; gzip 1,708,897), and the same import sweep now passes
**154/183**, with a functional smoke over `math`/`struct`/`hashlib.sha256`/
`datetime`/`random`/`xml.etree`/`unicodedata`/`statistics`/`decimal`/
`pickle`/`inspect`/`dis`/`unittest`/`dataclasses`/`select` all green.
Build frictions found by the probe, to be carried as vendor patches (§4.2):

- `fcntlmodule.c`: our libc declares `ioctl(int, unsigned long, void *)`
  (real POSIX is variadic); CPython passes an `int` arg → one-cast patch.
  **Deferred from the probe build; ships in 0340 with the patch.**
- `termios.c`: our libc termios lacks `tcsendbreak`/`tcdrain`/`tcflush`/
  `tcflow`, the `B*` baud constants and `TC{I,O,IO}FLUSH` → **libc surface
  work, now recorded as `todos/0325` Group D**. Deferred from the probe;
  gates `tty`/`pty`/`_pyrepl`-interactive.
- `Modules/expat/*`: expat's internal `PREFIX` typedef collides with the
  recipe's global `-DPREFIX='"/usr/local"'` → 3-line `#undef PREFIX` prelude
  patch (probe used wrapper TUs; the vendor tree patches the files and
  records it in the patch table).
- `binascii.c`: `USE_ZLIB_CRC32` must be **undefined**, not defined-to-0
  (`#ifdef` guard around `#include "zlib.h"`). Flips on when zlib lands (§3.4).
- 3.13's blake2 is `Modules/_blake2/*.c` (HACL blake2 is 3.14+).

### 3.3 The casualty list — every stdlib module that will NOT work at M1, by cause

Post-Tier-1 sweep, the remaining 29 import failures collapse to the causes
below. **This table is the honest story; nothing else is hiding** (one-time
sweep caveat: top-level imports — a deeper lazy import can still surface, but
the big trees were smoked above).

| missing piece | blocks | unblock path |
|---|---|---|
| `ELOOP` in libc `errno.h` | `pathlib`, `zipfile`, `zipapp`, `compileall` (`errno.py` re-exports; `from errno import ELOOP` throws) | **one `#define ELOOP 40`** matching the kernel's live numbering (`host.js:10687`; BlockFS really raises it, SYMLOOP_MAX=40 walk) + `strerror` line → `todos/0325` Group D. Reaches cc2wasm only after the `todos/0330` libc re-vendor (206-commit staleness) or interim via the build shim (`python-clang-shim.h` precedent). |
| termios libc surface | `tty`, `pty`, `_pyrepl` interactive polish | 0325 Group D (small: 4 functions — mostly no-ops on a pty — + constants); then build `termios` + `fcntl` (§3.2 cast patch) |
| `zlib` | `gzip`; `zipfile` deflate; fast `binascii.crc32` | link `zlibmodule.c` against **`vendor/zlib` (already in-repo)**; wiring is include-path only. In scope for 0340 — cheap, and `zipfile` is real breadth. |
| `_sysconfigdata_*.py` (generated) | `sysconfig` at call time → `pydoc`, `zoneinfo` | ship a generated `_sysconfigdata__gucos_.py` in the stdlib tree (§5.4; stub **verified to fix** `pydoc`/`sysconfig`/`zoneinfo` import) |
| `_posixsubprocess` | `subprocess`, `venv`, `webbrowser` | **posix_spawn route** (§3.5): small subprocess.py vendor patch; no `fork_exec` ever. In scope for 0340. |
| `_socket` | `socket`, `asyncio`, `socketserver`, `ftplib`, `smtplib`, `poplib`, `imaplib`, `mailbox` | OUT of M1 — `socketmodule.c` needs `netinet/*` (one of M0's five non-parsing TUs) and gucOS networking is AF_UNIX + the open `todos/0052`/`0054` AF_INET items. A socket-module port is its own item; **asyncio not shipping-functional is the single biggest honesty flag on "real CPython"** — say it wherever the package is described. The `.py` trees ship per the §2 rule and light up with the port. |
| `_ssl`, `_hashlib` (OpenSSL) | `ssl`, `hashlib`'s OpenSSL fast-paths (HACL builtins cover md5/sha1/sha2/sha3/blake2), `https`, pip | OUT — no OpenSSL vendor and no TLS story before real networking. Do not promise. |
| `_sqlite3` | `sqlite3` | Tier 2, priced: **`vendor/sqlite` is already in-repo** (3.53, ported); linking `_sqlite3` adds roughly a MB-scale code delta (**unmeasured**). Follow-up inside 0340's ticket, off by default until measured. |
| `_bz2`, `_lzma` | `bz2`, `lzma`, `tarfile` xz/bz2 legs (`tarfile` itself + gzip leg work) | OUT — no libbz2/xz vendor. Vendoring either is a normal small port if demand appears. |
| `_ctypes` | `ctypes` | **permanently OUT** — no dlopen/libffi on this platform (settled in 0313/OS.md; loading arbitrary native code is exactly what the no-dlopen ruling excludes). |
| `_curses` | `curses` | OUT of M1 — needs an ncurses port. Noted as an attractive later port over the gucOS tty, not scheduled. |
| `_tkinter` | `tkinter` tree (excluded §2) | permanent, by exclusion rule (a) |
| `_multiprocessing` | `multiprocessing` beyond import | permanent in spirit — no fork, no threads; `import multiprocessing` will resolve once `_socket` lands but process pools stay honest failures. |
| `_decimal` (libmpdec) | C-speed `decimal` only — **`_pydecimal` fallback works today** (verified) | optional Tier 2 (CPython vendors libmpdec in-tree; +~0.8 MB `.o`-scale, **final delta unmeasured**) |
| `readline` | GNU-readline REPL | superseded: 3.13's default REPL is `_pyrepl` (pure Python) — needs termios+fcntl above, no readline port wanted |
| `mmap`, `grp`, `resource`, `syslog`, `nis`… | their modules | OUT — no/partial kernel surface; none blocks the pygame ladder. `pwd` is a maybe (single-user stub) if something demands it. |

Projection once 0340 lands its in-scope items (ELOOP + termios/fcntl + zlib
+ sysconfigdata + subprocess patch): **~166/183** top-level modules import;
the residue is the socket/ssl/compression/ctypes families above.

### 3.4 Interpreter performance note

The v177 switch-lowering fix (0332) is live in production **including inside
package payloads** (master verified br_tables over the old 512 cap in
deployed blobs). That fix is about OUR compiler's codegen; the clang binary
never had the defect. The 2×2 benchmark (compiler × interpreter) remains a
separate quiet-machine job (`logs/2026-07-27/python-clang.md` §6) — nothing
in this design depends on its outcome.

### 3.5 subprocess without fork — the posix_spawn alignment

`subprocess.py:106` does an unconditional (on POSIX)
`from _posixsubprocess import fork_exec` — but the module already contains a
complete `os.posix_spawn` execution path (`_USE_POSIX_SPAWN`,
`Popen._posix_spawn`, and an env override `_PYTHON_SUBPROCESS_USE_POSIX_SPAWN`).
gucOS's process model **is** owner-brokered posix_spawn (OS.md — fork is
deliberately absent), and our libc ships `posix_spawn` + the full
`posix_spawn_file_actions_*` family (`compiler.js:25550ff`). Design:

1. `pyconfig.h` gains `HAVE_POSIX_SPAWN` (+ `HAVE_POSIX_SPAWNP`) so
   `posixmodule.c` exposes `os.posix_spawn`.
2. A ~3-line vendor patch to `subprocess.py`: guard the `fork_exec` import
   (`try/except ImportError → _fork_exec = None`) and force
   `_USE_POSIX_SPAWN` on this platform; the vfork branch is unreachable.
3. `_posixsubprocess` is **never built**. No stub module — an honest absence
   plus the patch is smaller than a lying stub.

This makes `subprocess.run(["ls"])` a real gucOS spawn. **Runtime behavior
under the kernel fd/pipe layer is unmeasured until 0340's e2e** — the design
claim is only that the code path exists on both sides and the libc surface is
present.

## 4. The vendor tree — `vendor/cpython/`

### 4.1 Layout

```
vendor/cpython/
  README.md            # commit pin (v3.13.5 tag), patch table (§4.2), regen notes
  Include/  Python/  Objects/  Parser/  Modules/   # pruned upstream sources:
                       #   the linked TU list + transitive headers + clinic/,
                       #   Modules/ only the built subset (incl. expat/, _hacl/,
                       #   _blake2/) — NOT the whole upstream dirs
  Lib/                 # the §2 rule set, verbatim upstream + the §4.2 Lib patches
  gen/                 # the wasi-configure-generated inputs, committed:
                       #   pyconfig.h (edited per §4.3), Modules/config.c (the
                       #   §3.2 inittab), Python/frozen_modules/*.h (24),
                       #   shim/ (ccprobe_libc.c + python-clang-shim.h lineage)
  bin.json             # our-compiler build: sources list + __minstack + defines
  srcs.txt             # the shared TU list both toolchains consume
```

Measured commit weight: TU sources ≈ 11.8 MB + `Include/` 2.34 MB +
clinic/headers (~2 MB, **estimate**) + `gen/` 1.48 MB + `Lib/` 9.9 MB ≈
**~27 MB**. In family with `vendor/netsurf`/`vendor/busybox`; acceptable.

The `gen/` directory is the answer to "generated by a configure we can't
run": those files are a **function of (CPython version, target config)**, not
of the build host — committing them is the same move as
`vendor/micropython/genhdr` (with `tools/mkmpgenhdr.js` as precedent for a
later regen script if churn appears; at one CPython version pin, churn is nil).

### 4.2 Patch table (complete as of this design — the README carries it)

| file | patch | why |
|---|---|---|
| `Modules/expat/xmlparse.c` (+xmlrole, xmltok) | `#undef PREFIX` prelude | recipe's global `-DPREFIX` vs expat typedef (probe-verified fix) |
| `Modules/fcntlmodule.c` | one `(void *)(intptr_t)` cast at the `ioctl` call | libc's non-variadic `ioctl` prototype |
| `Lib/subprocess.py` | guarded `fork_exec` import + force `_USE_POSIX_SPAWN` | §3.5 |
| `gen/pyconfig.h` | `HAVE_POSIX_SPAWN`, `MACHDEP`/platform → `"gucos"` (§5.4), termios/fcntl HAVE_ flips as 0325-D lands | config, not code |

Nothing else: 174 upstream TUs compiled **unpatched** under clang, and the
probe added 38 more TUs with only the two patches above plus drops.

### 4.3 Toolchain-specific vs shared (the two-consumers contract)

Shared (toolchain-independent): the source tree, `srcs.txt`, `gen/` contents,
`Lib/` including patches, the prefix layout, the package definition, all of
§2/§3's selection decisions. Clang-only: the sibling manifest project entry,
`-Wl,-z,stack-size=8388608`, the interim shim for the 206-commit-stale
sibling libc (**dies when `todos/0330` re-vendors** — 0340 should sequence
after 0330 precisely so the shim shrinks to nothing). Our-compiler-only:
`bin.json` with `__minstack(8388608)`; blocked on `todos/0336` as ruled, plus
the open 0319 (the M0 artifact still double-frees under the pre-0319
compiler; re-verify against post-0319 main per
`logs/2026-07-27/cpython-m0-reprobe-harness.md`).

## 5. Layout, PYTHONHOME, and runtime wiring

### 5.1 Install layout (the package's file map)

```
/opt/python-clang/
  bin/python-clang           # launcher script (§5.3)
  bin/python-clang.wasm      # the binary (clangApp payload)
  lib/python3.13/…           # the §2 stdlib tree (mkpkg `tree` entry)
/usr/local/bin/python-clang  # gucman bin symlink → /opt/python-clang/bin/python-clang
/var/cache/python-clang/     # pyc cache, created at runtime (not package-owned)
```

### 5.2 Zero-env-var stdlib discovery (verified host-side)

CPython's getpath **landmark search** finds `lib/python3.13/os.py` relative
to the resolved executable: verified with the probe binary at
`<prefix>/bin/` — correct `sys.path` with **no** `PYTHONHOME`/`PYTHONPATH`
— **and through a symlinked argv0** (`sys.prefix` = the real prefix), which
is exactly the gucman symlink shape. So: no baked absolute prefix dependence,
no env vars in the wrapper, works relocated. Two cosmetic notes: the
`Could not find platform dependent libraries <exec_prefix>` stderr warning
(no `lib-dynload/` — silence by shipping the empty dir) and `python313.zip`
on the path (harmless; the §2 zip option's hook). **In-OS re-verification of
the symlink walk is a 0340 acceptance item** (host-side node ≠ kernel
RemoteFS, readlink surfaces differ). Fallback if it fails in-OS: bake
`PREFIX="/opt/python-clang"` — works, at the cost of relocatability.

### 5.3 The pyc story

gucman's remove is checksum-gated and unlinks only what it planted; runtime
`__pycache__/` dirs under `/opt` would strand skeleton dirs at removal. So
the launcher (`bin/python-clang`, a 2-line `#!/bin/sh` wrapper, the gucman
`$0`-readlink pattern) sets `PYTHONPYCACHEPREFIX=/var/cache/python-clang`:
`/opt` stays pristine, removal is exact, and factory reset (wipe /etc+/var)
clears the cache by existing policy. First-import compile cost on BlockFS is
**unmeasured**; if it matters, the zip/pyc precompile option (§2) is the
lever — a measurement, not a redesign.

### 5.4 Platform identity

`sys.platform` is currently `"unknown"` (nothing passes `-DPLATFORM`).
Decision: **`gucos`** — honest, greppable, and it names the sysconfigdata
module `_sysconfigdata__gucos_.py`, which the stdlib tree ships (a stub with
`build_time_vars` = SOABI `cpython-313-wasm32-gucos`, EXT_SUFFIX, empty
ABIFLAGS — **verified** to make `sysconfig`/`pydoc`/`zoneinfo` import).
Rejected: lying `"linux"` (stdlib takes Linux-only paths) and `"wasi"` (we
are not WASI; host.js has zero WASI surface). Consequence to accept loudly:
third-party `sys.platform == "linux"` checks won't match — pygame-ce's own
platform gates get audited in M2, not papered over here.

## 6. The package, the names, the channel

### 6.1 `packages/python-clang.json` (shape; exact syntax at 0340)

```jsonc
{
  "name": "python-clang",
  "version": "3.13.5",
  "summary": "CPython 3.13.5 (clang-built) + stdlib — real Python; no sockets/ssl yet",
  "requires": "clang-sibling",
  "files": {
    "bin/python-clang.wasm": { "clangApp": "python-clang" },
    "bin/python-clang":      { "text": "…launcher…" },
    "lib/python3.13":        { "tree": "vendor/cpython/Lib" }
  },
  "bin":      { "python-clang": "bin/python-clang" },
  "commands": { "python": "python-clang" }        // 0338 dispatcher claim
}
```

Key structural point (verified in `tools/mkpkg.js`): only the **binary**
rides the sibling overlay (`clangApp`); the **stdlib** is a `tree` entry read
straight from this repo's `vendor/cpython/Lib` — toolchain-independent, and
the eventual our-compiler `cpython` package reuses the identical entry.
No menu/desktop entries — an interpreter's surfaces are the shell and (later)
the 0338 dispatcher; a Start-menu "Python" that opens a bare REPL in term is
a nice-to-have 0340 may add via `term python-clang`, not a design point.

### 6.2 Names — one claim, and a recommendation needing a call

The package's only hard bin claim is **`python-clang`** (gucman has no
conflicts mechanism; `gucman.c` refuses installs over an existing symlink —
re-verified in 0331). **Never a bare `python` symlink** — that name belongs
to the 0338 base-image dispatcher, where this package participates via the
`commands` claim, and per the decider's amendment the dispatcher's
no-implementation-installed hint names **python-clang first**.

`python3` / `cpython`: the kickoff instruction says claim them here; 0331's
older text reserved them "for the real CPython package". Both predate 0338.
**Recommendation: make `python3` (and optionally `cpython`) cmdalt keys too —
one image `link` line + one baked store line each, resolving to python-clang
by default** — because a hard symlink claim collides the day the
our-compiler `cpython` package "catches up" (two packages, one name, no
conflicts mechanism = the second install hard-fails), while cmdalt keys make
"all implementations caught up" switchable per jku's own control-panel
model. This crosses into the 0338 lane's territory: **routed through master
as a coordination item, not decided here.** Fallback if refused: this
package claims `python3` directly and the future our-compiler package must
not, which is exactly the kind of frozen accident the dispatcher exists to
end.

### 6.3 Delivery channel — nothing to design, verify only

Since 0337 (deployed; production serves the 8 `-clang` packages + stl4 +
sdldemo where it previously served **zero**), the clang superset index is the
deploy **default**, and the mkpkg drift gate **fails the build** if the
sibling overlay publishes `/usr/bin/python-clang` without a package claiming
it. So delivery is: (1) sibling manifest project (`base:
"$CC_ROOT/vendor/cpython"`, `binJson`, the §3.2 flag set, `install:
"/usr/bin/python-clang"` — satisfies `enforceClangConvention`), (2)
`packages/python-clang.json` in the same change window as the overlay
publish (the gate turns "forgot the package" into a red build, in our
favor), (3) ordinary deploy. The overlay@1 byte-reproducibility contract
holds: the `-DDATE/-DTIME` pin is already in the recipe and two independent
probe-lineage builds differed only in the wasm-ld `-o` basename field
(mk-overlay already builds to the final name).

One channel caveat to carry: `requires: "clang-sibling"` means the package
only builds on a machine with the sibling checkout — same as every `-clang`
package, fine — but the **stdlib tree does not gate on it**, so a future
`cpython` (our-compiler) package shares `vendor/cpython` with no sibling
present.

## 7. What 0331 and 0313-M1 mean now

- `todos/0331` (ship the package): **unblocked in principle** — its blocker
  ("a committed CPython vendor tree", "M1 unfunded") is dissolved by this
  design + `todos/0340`. It stays sequenced after 0340 and consumes §6
  verbatim. Its "python3/cpython reserved / must not be claimed here" line is
  superseded by §6.2's pending call.
- `todos/0313`'s M1: the ladder's M1 is now **M1-clang** (this design; the
  clang toolchain sidesteps 0336). The our-compiler `/bin/python` remains
  gated on 0336 + 0319-reverify and inherits this tree when it lands.
- MicroPython: unaffected. It remains the lightweight scripting Python and
  the funded 0117 R2 work. **Correction folded in from master (measured on
  the live deployed image): gucOS's base image ships NO python verb at all —
  240 image entries, zero `python*`/`micro*` hits. MicroPython is gucOS's
  python only for users who installed its package; a fresh gucOS has no
  python until `gucman install micropython` (or, once this ships,
  `… python-clang`).** Every "python experience" claim carries that opt-in
  qualifier.

## 8. The pygame trajectory (scoped, deliberately not built)

⚠️ **No dlopen** on this platform, ever (settled). Therefore pygame-ce's C
half, its SDL dependency, and any other C extension **statically link INTO
the python-clang binary** — "installing pygame" means shipping a BIGGER
python binary (or a second `python-clang-game` flavor), not adding files.
What M1 must get right NOW so M2/M3 stay possible — and does:

1. **The binary must stay cheaply re-linkable.** That is §4's whole shape:
   committed tree + committed `srcs.txt` + committed `gen/` + one manifest
   project. Adding pygame = more TUs on the same list + inittab entries. No
   M1 decision hard-codes the extension set anywhere but `gen/config.c`.
2. **`Modules/Setup`-style static extension registration is the mechanism**
   (upstream's own no-dlopen answer, cpython#115983) — the §3.2 inittab
   expansion is the same mechanism pygame-ce's modules use in M3.
3. **⚠️ THE SDL MISMATCH, priced and visible: pygame-ce targets SDL2; "our
   SDL3" is real (jku).** The gucOS SDL surface is an SDL3-shaped veneer
   (`__SDL.c`, SDL3.md). pygame-ce's mainline is SDL2 (an SDL3 branch exists
   upstream but is not the shipping target — **status unverified here**).
   The resolution space for M2: (a) an SDL2→SDL3 compat layer under
   pygame-ce (the sdl2-compat direction — but that projects SDL2 API onto
   SDL3, which is exactly what gucOS's veneer would have to absorb; risk:
   unbounded surface), (b) port pygame-ce's SDL2 calls to the SDL3 veneer
   directly (the `sent`/`magicpoint` "patch the display layer" precedent;
   bounded by pygame-ce's actual call surface, which is enumerable), or (c)
   chase pygame-ce's SDL3 branch. **This is the single most likely place M2
   becomes an unbounded compat layer; it is priced as its own design pass at
   M2's head, and nothing in M1 forecloses any of the three.** Not resolved
   here, per the kickoff.
4. pygame games assume `subprocess`-less, socket-less operation almost
   always, but DO assume `math`/`random`/`struct`/`zlib`(via pygame image
   paths)/`unicodedata` — Tier 1 is the pygame floor, which is why it is in
   M1 and not deferred.
5. numpy (surfarray + games' own logic — 0313 found the need "unambiguous"):
   compile-stage YES at M0 confidence (83/164 TUs with the `__STDC_NO_COMPLEX__`
   guard extension); linking/running it is M4-adjacent and **unmeasured**.

## 9. Unmeasured / open

- **Everything in-OS.** All §3/§5 verification is host-side (node host.js).
  In-OS spawn, RemoteFS import latency over 548 files, pyc-cache write
  behavior, subprocess-over-kernel — all 0340 acceptance work, none expected
  novel, all unmeasured.
- Cold-start import cost of a real script (`import pygame`-scale graphs) on
  BlockFS — unmeasured; the zip/pyc lever exists if it hurts.
- `_sqlite3`/`_decimal` binary deltas — unmeasured (Tier 2 gates on
  measuring them).
- The deep-import tail beyond top-level sweep — bounded by §3.3's causes but
  not exhaustively walked.
- pygame-ce SDL3-branch viability — unverified (M2's first question).
