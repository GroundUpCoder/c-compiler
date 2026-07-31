# #312 — hush ⟷ libc environ use-after-free class: inherited strings are immortal now

Branch `0312-environ-uaf`. Fixes the class the #296 post-fix audit found
(`logs/2026-07-31/0296-putenv-audit.md`): `__environ_take_ownership` registered
its deep copies of the inherited environment in `__environ_mine`, making them
freeable by `unsetenv` and same-name `putenv` replacement — while busybox
hush's environ import loop aliases exactly those strings as `cur_var->varstr`
with `max_len > 0`, hush's marker for "startup env space: edit in place, NEVER
free". That immortality assumption is true on musl/glibc (an execve'd
environment is never freed) and was false here.

## The fix (the ticket's ruled plan, decider-concurred)

`__environ_take_ownership` still strdups every inherited string, but no longer
registers the copies — the registry holds setenv-allocated entries ONLY. This
restores the invariant for every environ-importing port, not just hush.
Accepted cost: replacing/unsetting an inherited entry leaks its copy, bounded
by one initial environment per process (glibc leaks the same way by design).
One-line mechanical change (drop the `__environ_mine_add` in the copy loop);
the rest is comments pinning the why.

## Red control (MEASURED — the audit lane could not run this; this lane did)

The audit's hush mapping was line-cited source reading; its repros were
standalone pointer-flow simulations. This lane ran the real flows through real
hush in a booted OS (`os/boot.js`, default boot env, piped stdin), UNFIXED
tree first:

    HOME0=/root          ← correct start
    T1=                  ← `HOME=/x true; echo $HOME` — EMPTY, expected /root
    T2=                  ← `export -n HOME; echo $HOME` — EMPTY, expected /root
    0
    T2b=                 ← still empty after re-export
    exit=139             ← `export -n TERM=vt999` (T3) CRASHED pid 1:
                           RuntimeError: memory access out of bounds
                           ("alive" never printed)

Worse than the audit's model predicted: T3's strcpy-into-freed-block doesn't
just corrupt silently — it kills the shell outright. Same flows on the fixed
tree:

    HOME0=/root  T1=/root  T2=/root  0  T2b=/root  T3=vt999  alive  exit=0

The conformance test (`tests/unit/conformance/environ_inherited_immortal/`,
clang-verified golden) was also watched red first: unfixed, lines 2/3/5 print
`0` — the aliases read scribbled memory after unsetenv, same-name putenv
replacement, and the export-n in-place-edit shape. It installs its own
"inherited" environment via `environ = boot_array` before the first mutation
(the unit harness seeds no env), which is exactly the shape take-ownership
consumes; glibc/macOS agree on the golden because neither ever frees strings
it didn't allocate.

Commit order is test-first: the red tests landed as their own commit, then the
fix.

## What was measured vs reasoned

- MEASURED: unit-level red (2/3/5 → 0) and green; in-OS red (empty $HOME ×2 +
  pid-1 crash exit 139) and green through real hush; every suite below.
- REASONED: the hush line mapping (hush.c:2382-2444, 2557, 10445-10446,
  11306-11320) — re-read this lane against the audit's citations, confirmed
  verbatim; the bounded-leak cost argument (mirrors glibc's documented
  behavior).

## Gates (derived via `planFromDiff`, not inherited)

Diff = compiler.js, os/image.json, tests/kernel/test_os_boot.js, the new
conformance dir. Plan = every suite except netsurf-patch (compiler.js maps to
the whole estate). All run, all green, no filters except where stated:

- `tests/run.js todos unit host blockfs`: 4/4 pass; blockfs 15/15
  recorded==total.
- `py[ast,extra,ext,projects,disw,sourcemap,fuzz,fakegit]`: 172 passed,
  0 failed, 1 skipped — the skip is fuzz's live-csmith native-side
  slow/odd path ("not our problem" skip); a verbose rerun of all eight
  categories passed 173/173 with zero skips.
- `py[zlib,lua,freetype,libpng,cairo]`: 60 passed, 0 failed, 7 skipped
  (exactly the static LUA_SKIP set).
- `py[micropython,sqlite,tcc,libc]`: 56 passed, 0 failed, 48 skipped (all in
  libc's static LIBC_TEST_SKIP; sqlite/tcc/micropython rerun individually:
  0 skips).
- `py[micropython-upstream]`: 574 passed, 0 failed, 65 skipped (574+65 = the
  639-file corpus; 65 is the recorded R2 skip set).
- kernel: **141 passed, 0 failed**, summary identity
  done:true, filter:null, total==selected==executed==recorded==results==141,
  carried 0. The #312 leg's six checks green in test_os_boot.js.log; the #296
  varstore leg stays green.
- sweep: **44 passed, 0 failed**, ONE unfiltered run, top-level identity
  done:true, filter:null, 44 across all counters, carried 0.
- `putenv_pointer_semantics` and `stdlib/environ` unit tests: green.

Image bumped to **v205** (the fix changes shipped hush behaviour).

The sweep rewrote committed evidence PNGs under `logs/2026-07-18/` and
`logs/2026-07-25/` (vt2-zoom, hires) and dropped one untracked PNG — known
sweep side-effect, not this lane's changes, left untouched.

## Gotcha for the next reader

The audit's §2 latent gap stands unchanged: wholesale `environ = my_array`
followed by setenv still hits `realloc` on a pointer the libc never allocated.
The new conformance test deliberately assigns `environ` BEFORE the first libc
mutation, so take-ownership copies it first — that ordering is what makes the
test (and any port doing the same) safe.
