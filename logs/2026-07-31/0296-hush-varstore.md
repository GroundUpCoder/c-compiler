# #296 — hush script-file variable store corruption: the libc's putenv was the bug

**Ticket**: #296 (P0). **Symptom**: `a=1` then `echo $a` expanded EMPTY inside a
`sh`-run script FILE under the default boot env — env-layout dependent (the
exact 5-var layout `PATH, HOME, TERM, PWD, HUSH_VERSION`; only dropping `PWD`
fixed it; a 6th var fixed it). Found by the 0444 lane while converting the
gucman launchers; worked around there by making launchers variable-free
(lint rule 3 + register L67, both retired here).

## Root cause — a use-after-free the libc handed to hush

The ticket's suspicion ("libc setenv/putenv environ handling, or hush's
NOMMU environ-backed store, corrupting on the PWD replace") was right on the
first count, and the sensitivity map decodes exactly:

1. hush's startup calls `unsetenv("HUSH_VERSION")` BEFORE its environ-import
   loop. That first mutation triggers the libc's `__environ_take_ownership`:
   every environ string becomes a libc-owned heap strdup.
2. The import loop then points hush's variable store DIRECTLY at those heap
   strings (`cur_var->varstr = *e; max_len = strlen(*e)`) — varstr and
   `environ[i]` are the SAME pointer.
3. `set_pwd_var(SETFLAG_EXPORT)` re-exports the inherited PWD. Whether the
   value changed or not, the exported path ends in `putenv(cur->varstr)` —
   putenv of the very pointer environ holds.
4. Our putenv deviated from POSIX: it strdup'd the argument and then
   `free(environ[i])` — freeing the buffer hush's PWD variable still points
   at. Dangling `varstr` in the store.
5. In script-file mode there is almost no allocation churn before the first
   command, so the very next `xstrdup("a=/optA")` (10 bytes, same size class
   as the freed `"PWD=/root"`) reuses the freed block. hush's set_local_var
   walk then reaches the PWD entry, whose corpse now reads `a=/optA`,
   false-matches it as an existing `a` with the same value — "assignment
   does not change anything" — frees the new string (double free) and never
   inserts `a`. By the time `echo $a` expands, the block has been reused
   again and nothing in the store matches `a`: empty.

Every map row follows: only PWD is re-exported at startup (leave-one-out);
`-c`/interactive/sourced put allocations between the dangle and the first
assignment, so the hole is filled harmlessly; a 6th var shifts the size
classes; `export` in a script takes the fresh-malloc path (no alias).
Browser boots dodge it by layout luck — 0443's Safari numbers stand.

## Fix — POSIX putenv + per-string ownership (compiler.js environ block)

busybox hush is *written against* POSIX putenv ownership semantics (its own
comment: "wait until putenv, then putenv(new)+free(old)"). musl's libc-test
(`functional/env.c`, vendored) likewise asserts the caller's string is
installed verbatim. So the fix is to make the libc POSIX-correct, not to
special-case hush:

- `putenv(s)` installs the CALLER's pointer verbatim — no copy. Later edits
  to the buffer are visible via getenv. `putenv` of the exact pointer
  environ already holds is a no-op (the hush PWD call). The libc never
  frees a putenv'd entry.
- Ownership is tracked PER STRING in a registry (`__environ_mine`) holding
  exactly the strings the libc allocated into environ: setenv entries and
  the take-ownership deep copies. `setenv`/`unsetenv`/`clearenv` free an
  entry only when the registry says the libc owns it (`__environ_dispose`).
- Caller survey: busybox putenv sites pass long-lived strings (argv,
  literals, hush varstrs — all POSIX-shaped); micropython uses setenv; the
  quickjs `_putenv` site is dead `_WIN32` code. Nobody relied on the old
  copying behavior.

## Tests (test-first: committed red, then the fix)

- `tests/unit/conformance/putenv_pointer_semantics/` — pins the POSIX
  contract (edit-after-putenv visible, alias no-op, setenv replaces without
  freeing or editing the caller's buffer, buffer survives unsetenv).
  Clang-verified; was red at line 2 (`bar` for `baz`).
- `tests/kernel/test_os_boot.js` new leg — the ticket repro under the
  DEFAULT boot env: a script FILE assigns two vars and echoes them, spawned
  as `sh /root/p296.sh` from pid 1 (that spawn is what produces the exact
  5-var env). Was `A= B=`; now `A=/optA B=B2`.
- Post-fix in-OS probes: script file, `sh -c`, sourced, `env X=1`, `export`,
  and the pre-0444 launcher pattern `here="$(dirname "$(realpath "$0")")"`
  (prints `HERE=/root`) all green; `$PWD` intact.

## Workaround retirement

0444's var-free launchers keep working (they are also SPAWN-free, which is
about latency, not this bug — rules 1–2 of the launcher lint stay). Rule 3
(no plain assignments) existed only to fence #296 and is deleted; register
entry L67 is retired in the same commit. `image.json` bumped to 201 (a libc
change re-bakes every binary; the browser OPFS gate needs the version).
