# #296 putenv/environ ownership — independent post-fix audit (read-only lane)

Audited at pin `1449969a` ("#296: POSIX putenv — per-string environ ownership").
All line citations are to that commit. This lane edited nothing and ran no heavy
suites; measurements are standalone compiles via the pinned `compiler.js` +
`host.js` (`runModule`), plus two single-file `tests/run-unit.js` invocations.

## Verdict

The #296 fix itself is correct, the registry edge cases check out, and the
conformance test genuinely discriminates (watched red against the pre-fix
compiler). **But the audit found one real defect — a use-after-free CLASS in
the hush ⟷ libc interaction that #296's own root-cause analysis walks right
past: `__environ_take_ownership` registers its deep copies as libc-owned and
therefore FREEABLE, while hush's environ import aliases those same strings as
`max_len>0` = "startup env, immortal". Three shipped shell flows free a string
hush still holds.** Measured at the libc level (MEASURED); the hush mapping is
line-by-line source reading (REASONED); pre-existing, NOT a #296 regression
(measured identical against the pre-fix compiler). Filed as one ticket (one
root cause, three triggers).

## 1. The defect — inherited-env strings are freeable but hush aliases them as immortal

### Root cause chain

1. `__environ_take_ownership` (compiler.js:31271-31282) strdup's every initial
   environ string **and registers each copy in `__environ_mine`**
   (compiler.js:31277). Registered = the libc may free it later
   (`__environ_dispose`, compiler.js:31255-31263).
2. hush startup calls `unsetenv("HUSH_VERSION")` **unconditionally**
   (hush.c:10428) — take-ownership fires on every boot, so the import loop
   (hush.c:10440-10451) always aliases REGISTERED strings:
   `cur_var->varstr = *e; cur_var->max_len = strlen(*e)` (10445-10446).
3. `max_len > 0` is hush's marker for "this string is startup-env space:
   edit in place, never free" (hush.c:2435-2445, 2545 `if (!cur->max_len)
   free(...)`). That assumption is TRUE on musl/glibc — an execve'd environment
   lives in the process image and is never freed — and FALSE here, where the
   take-ownership copies are registry-owned heap blocks.
4. Therefore any libc-side free of a registered string while hush keeps its
   `varstr` alias is a use-after-free. #296 fixed exactly ONE such flow (the
   `putenv(varstr)` alias, now a no-op at compiler.js:31364) and left the
   `unsetenv`/replacement flows.

### The three shipped triggers (hush 1.37, all compiled in per busybox.config)

- **T1 — `VAR=VAL cmd` prefix on an inherited exported var** (e.g.
  `HOME=/x true`). `set_vars_and_save_old` → `set_local_var` shadows the old
  var into the save list with varstr intact (hush.c:2405-2414), the temp var's
  `putenv` (hush.c:2480) makes the libc dispose-free the inherited string
  (compiler.js:31365), and after the command `add_vars` restores by
  `putenv(var->varstr)` (hush.c:2557) — **putenv of a dangling pointer**.
  Reachable for builtins/nofork (hush.c:9650) and for external commands on
  NOMMU (hush.c:9792) — gucOS is NOMMU, so every prefixed assignment on an
  inherited var takes this path in the parent shell.
- **T2 — `export -n VAR`** (inherited var). `helper_export_local`
  (hush.c:11306-11312) calls `unsetenv(name)` but **keeps the variable and its
  varstr**; libc unsetenv frees the registered string (compiler.js:31343).
  `echo $VAR` afterwards reads freed memory; a later `export VAR` putenv's the
  dangling pointer (hush.c:11319-11320).
- **T3 — `export -n VAR=VAL`** (inherited var, new value fits the old length).
  `set_local_var` with `SETFLAG_UNEXPORT` first `unsetenv`s (hush.c:2382-2386,
  frees the registered string == `cur->varstr`), then the `max_len` in-place
  path `strcpy(cur->varstr, str)` (hush.c:2436-2439) — **a write into the
  freed block**. Heap-corrupting, the worst of the three.
  (`ENABLE_HUSH_EXPORT_N=1`, autoconf.h; `export -n NAME=VAL` parses at
  hush.c:11360-11364.)

### Measurement (MEASURED — libc level, hush flow simulated pointer-for-pointer)

Standalone C repros compiled by the pinned compiler, seeded with the 5-var boot
env shape, run via `host.js` `runModule` (no kernel, no heavy lock).

Repro 1 (T1 shape): take ownership; alias HOME's environ string; putenv a temp
`HOME=/x`; one same-size malloc; putenv the saved alias back:

    inherited varstr: HOME=/root
    clobber reused the freed block: 1        ← the very next malloc reuses it
    HOME after restore: [/x]  (hush expects /root)
    environ now: … HOME=/x … CLOB=BERED      ← ghost variable installed

Repro 2 (T2 shape): take ownership; alias HOME; `unsetenv("HOME")`; one malloc:

    clobber reused varstr block: 1
    hush's $HOME varstr now reads: [JUNKJUNKJU]

The reuse-on-next-same-size-malloc dynamics are exactly the ones #296's own
dev log established for the script-file case (low churn ⇒ immediate reuse).

**Regression check (MEASURED):** both repros produce byte-identical corruption
under the pre-fix `compiler.js` (`1449969a^`) — the pre-fix putenv/unsetenv
freed `environ[i]` unconditionally, including these same strings. So this is a
pre-existing sibling of #296, narrowed (the alias no-op subcase fixed) but not
closed by it. Filed as P0 (correctness bug in the shipped shell) — see ticket.

**NOT measured:** the three triggers end-to-end inside a booted OS through real
hush. That requires `os/boot.js` (heavy-lock holder) which this lane must not
run. The hush-side mapping is REASONED from the vendored source at the cited
lines; the libc-side free-while-aliased and allocator-reuse behavior is
MEASURED above.

### Fix direction (suggestion only — master sequences)

Make the take-ownership deep copies **immortal**: strdup them but do NOT
register them (`__environ_mine_add` only for setenv entries). That restores the
musl/glibc property hush's `max_len` logic assumes — inherited environ strings
are never freed — and fixes T1/T2/T3 at the root. Cost: replacing/unsetting an
inherited entry leaks its copy, bounded by one initial environment per process
(glibc leaks the same way by design). The #296 alias no-op and the conformance
test are unaffected. The alternative (patch hush to strdup at import / drop
max_len) diverges further from upstream and only fixes hush, not the next
environ-importing port.

## 2. Independent whole-estate caller survey (doubt #1 — redone from scratch)

Grep basis: `putenv|setenv|unsetenv|clearenv|environ` over all `*.c`/`*.h`
outside `build/`, plus `os/` and `host.js`/`kernel.js` JS boundaries. Every
call site examined:

**putenv callers** (the POSIX-pointer-semantics-sensitive set):
- `vendor/busybox/src/shell/hush.c:2480, 2557, 10454, 11320` — varstrs: heap
  strings hush owns, or the registered imports (the defect above). hush's own
  free-after-putenv (hush.c:2450-2453, `free_me`) only fires for
  `max_len==0` strings hush malloc'd — those are never registered, so
  `__environ_dispose` correctly no-ops on them: **no double free** (verified
  by reading the `free_and_exp`/`set_str_and_exp` paths; the can't-reuse path
  at 2442-2444 drops the alias *before* putenv, so plain `VAR=newval` and
  `cd` are clean).
- `vendor/busybox/src/coreutils/env.c:81, 85` — argv strings (live to exec) and
  the `putenv("name")`-unsets form; safe. `clearenv()` at :72 resolves to the
  REAL libc clearenv (`HAVE_CLEARENV=1`, platform.h:415; the `environ[0]=NULL`
  macro at libbb.h:162 is dead — the undefs at platform.h:511/523/549 are
  Cygwin/BSD/Apple-only). Our clearenv never sets `environ=NULL`; env.c
  handles both (:95).
- `vendor/busybox/src/coreutils/date.c:189` — string literal; safe.
- `vendor/busybox/src/archival/tar.c:1096` — literal, and dead anyway
  (`ENABLE_FEATURE_TAR_TO_COMMAND=0`, autoconf.h:839).
- `vendor/libc-test/src/functional/env.c:21`, `time.c:98` — literals; env.c is
  wired as the `libc` run.py category and asserts pointer-verbatim install
  (`environ[0]` comparison) — passes the new semantics by design.
- `tests/unit/stdlib/environ/environ.c:29,32` — literals, including the
  two-different-literals-same-name replacement (dispose no-ops on the first
  literal — correct). `tests/unit/conformance/putenv_pointer_semantics` — see §4.
- `vendor/cpython/Modules/clinic/posixmodule.c.h` — docstrings only; the real
  `os_putenv_impl` (posixmodule.c:12990) uses **setenv** on non-Windows.

**setenv/unsetenv/clearenv callers** — all copy-semantics, lifetime-safe:
micropython `portmodos.c:49,57`; CPython `pylifecycle.c:283,392`,
`posixmodule.c:12990,13033-13035`, `getpath.c:725` (arg only read);
busybox `xsetenv` (xfuncs_printf.c:356) and `bb_unsetenv` (:363-386 — the
on-stack name copy is read-only input to unsetenv; its comment about putenv'd
entries is handled); `os/gcode/gcode.c:939` (values copied by setenv; the
stack `tmp` is only read); jq `builtin.c:1361,1364` via its private setenv
at :1305 — **dead** (`#if defined(WIN32) && !defined(HAVE_SETENV)`); quickjs
`quickjs-libc.c:758-776` private setenv/unsetenv — **dead** (`#if
defined(_WIN32)`), POSIX path uses the libc (confirming the dev-log claim);
hush bans setenv outright (`hush.c:776`).

**Direct `environ` writes / wholesale assignment:** none live in the estate.
Only the dead libbb clearenv macro and CPython posixmodule.c:7397's *local*
`char **environ` shadow (Darwin host path). jq `compile.c:1133-1139` and
hush's `builtin_export` read-only walk it. **Latent, unreachable-today gap
(REASONED, noted not ticketed):** a program that legally does
`environ = my_array` (POSIX allows it) and then calls setenv would hit
`realloc(environ, …)` (compiler.js:31326/31371) on a pointer the libc never
allocated — a crash. Pre-existing, identical before #296, no estate caller;
glibc handles this case by tracking its last-allocated array. If a future
port does this, that's the line that breaks.

**The specific doubt-#2 hazard — putenv of a stack/short-lived buffer: NOT
FOUND anywhere in the estate.** Every putenv argument is a literal, argv,
static, or owned-heap string. The dangling-entry class the audit DID find
(above) is the freed-heap variant, produced by the libc itself.

**Spawn/exec boundary (REASONED from host.js):** env crosses as bytes —
`readStrVec` copies strings out of wasm memory at spawn-RPC time
(host.js:6482-6494), and envp=NULL inherits by walking `__get_environ()`
then, so caller-owned putenv strings are safe across spawn provided they are
alive at spawn time. Initial env is seeded once pre-main via `__set_environ`
(host.js:12435-12461); nothing calls it twice, so its registry-blanking loop
(compiler.js:31401) is the documented pre-main no-op.

## 3. Registry edge-case walk (all at 1449969a; MEASURED where noted)

- **putenv of the same string twice** — `__environ_find` hits the same slot,
  `environ[i] == string` → no-op (compiler.js:31363-31364). Pinned by
  conformance line 3. ✔
- **Two different strings, same NAME** — dispose no-ops on the caller-owned
  first (not registered), pointer swaps in; first string stays caller-owned.
  POSIX-correct. ✔ (environ.c literals + conformance line 5 exercise it.)
- **putenv then setenv same name** — setenv allocates its own entry, disposes
  the old only if registered (compiler.js:31320): caller's putenv buffer is
  neither freed nor edited. Pinned by conformance line 4 (prints the buffer).
  ✔
- **setenv then putenv same name** — the setenv entry IS registered → disposed
  (freed) on replacement; no leak, caller string installed. ✔
- **unsetenv of a putenv'd entry** — dispose no-ops (never registered; a
  registry entry never existed, so there is nothing to retire), entry shifts
  out (compiler.js:31342-31346). Buffer survives — pinned by conformance
  lines 6-7. ✔
- **clearenv** — disposes registered strings only, frees the array, installs a
  fresh owned empty (compiler.js:31379-31390). Caller putenv strings pass
  through untouched. libc-test env.c's `clearenv() || (environ && *environ)`
  passes (non-NULL environ, NULL first slot). ✔
- **Wholesale `environ =` assignment** — registry survives *safely* (leaked
  registered strings are never freed, so their addresses can never be recycled
  into a false dispose match) but the array realloc breaks — see §2 latent
  gap. No estate caller.
- **spawn/exec** — bytes copied at the boundary (§2); ownership does not
  cross. No fork exists by design. ✔
- **environ array growth** — take-ownership mallocs the array, later
  realloc'd only by the libc; the setenv new-var ENOMEM path (compiler.js:
  31326-31330) grows the array before allocating the entry, but the old
  terminator at `environ[n]` is preserved by realloc, so a failed entry
  alloc leaves a consistent environment. ✔
- **Registry growth ENOMEM** (`__environ_mine_add`, compiler.js:31246) —
  untracked entry leaks instead of double-freeing; documented, sound.
- **`putenv("=foo")`** — nlen 0 matches any entry starting `=`; degenerate
  input, glibc-ish don't-care. Not filed.

## 4. The conformance test judges (doubt: does it pin or record?)

`tests/unit/conformance/putenv_pointer_semantics/` asserts concrete values
against a clang-verified golden — it judges. **Red control (MEASURED):**
compiled with the pre-fix `compiler.js@1449969a^` it prints `2 bar` against
expected `2 baz` — the copying putenv fails the golden at exactly the line the
dev log claims. Post-fix at the pin: `1 passed` (run via
`tests/run-unit.js --filter=putenv_pointer_semantics`; likewise
`stdlib/environ`). Note the discrimination lives almost entirely in line 2
(lines 3-7 print identically under both implementations — the old copy
semantics happens to satisfy them); that is sufficient but worth knowing.
What the test does NOT cover — and cannot from C without an allocator probe —
is the take-ownership registration hazard of §1.

## 5. What this audit did NOT cover

- No end-to-end hush demonstration in a booted OS (heavy-lock; read-only
  lane). T1-T3 are libc-measured + source-mapped, not shell-observed.
- No run of the `libc`/kernel/browser suites; only two single-file unit-runner
  invocations and standalone runModule compiles.
- JS-side env handling audited only at the two boundaries (`__set_environ`
  seeding, spawn `readStrVec`); serve.js/tools' Node `process.env` use is out
  of scope (different environ).
- Vendored survey is grep-based over `*.c`/`*.h` (+ the clinic headers where
  flagged); binary/asset payloads and gucman package sources outside the repo
  tree were not re-derived (cpython-clang builds from the vendored tree
  surveyed here).

## Filed

- Ticket **#312** (P0): hush ⟷ libc inherited-env use-after-free class
  (T1/T2/T3 above). This audit: no other defects found; the #296 fix and its
  registry are otherwise sound.
