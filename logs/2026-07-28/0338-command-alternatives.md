# 0338 — command alternatives: `cmdalt`, and the shadow that had to be closed twice

Branch `0338-dispatcher`, image **v179**. Ticket `todos/done/0338`, design
`todos/COMMAND-ALTERNATIVES.md`, independent verification
`CHECK-0338-dispatcher-shadow-CONFIRMED-2026-07-28` (meta repo).

## What shipped

`/usr/bin/cmdalt` — a multicall binary whose mode is `basename(argv[0])`. Under
its own name it is the admin CLI; under any other name it is a dispatcher for
that name. That one choice is what makes the thing both generic and safe: the
key comes from argv[0], so a second dispatched name costs one `link` line in
`os/image.json` and one baked store line and **no C at all**; and because the
dispatcher's own flags only exist as `cmdalt`, `python --help` / `-c` / a
`#!/bin/python` shebang can never be intercepted. The e2e proves the
genericity claim rather than asserting it — `foo` dispatches to `/bin/echo` and
`bar` to `/bin/pwd` at the same time, on base-image binaries only.

The store is the fourth `cfgstore.h` store, which is the whole reason this was
small: three layers, per-key overlay, delta-write, all already shipped. What it
needed on top was iteration (`cfg_each` for one key's lines, `cfg_keys` for the
distinct keys), `cfg_unset` (the same streaming write with the substitution
dropped — which also unblocks `0130`'s own Remove button), and the argv
splitter hoisted out of `openwith.h`'s private `ow_build` so both stores share
it. `ow_build` is now the `reserve = 1` wrapper; the loop bound
`maxargs - reserve - 1` IS the old `maxargs - 2`.

The hoist is **not byte-identical** and that is worth writing down, since the
design asked for byte-identity: `open.wasm` grew 227 bytes over keeping the
private splitter, and there is one extra `access()` in the nothing-installed
path (the shared `cfg_path_find` probes `/bin/<word>` before falling back to
it, where the old code fell back unconditionally — same `prog` either way).
Behaviour is identical, `test_openwith_e2e.js` is the guard, and the reason
`cfg_path_find` probes is that the shadow diagnostic needs an honest "first
EXISTING PATH entry", which is also exactly what the platform's own
`pv_execvp` does.

## The interesting part: the shadow, and the hole under the hole

The known failure mode: `PATH=/usr/local/bin:/bin` (a deliberate 0040 policy),
so a package that plants `/usr/local/bin/python` silently beats the base
image's `/usr/bin/python` dispatch link. It never breaks anything — it freezes
the default, and the only symptom is "switching does nothing". The independent
CHECK pass confirmed all four legs of this against `origin/main` and made two
points that changed the work:

- **Naive shadow-removal is strictly worse than the shadow.** Remove the stale
  link without registering the implementation in the store and `python` starts
  resolving to the uninstalled baked suggestion, i.e. exits 127. So the
  prescribed migration (`gucman remove X && gucman install X`) is INTERLOCKED
  with the `commands` claim step. That constraint now lives in `os/cmdalt.h`
  beside the code that prints the advice, because that is where the next person
  to touch the advice will actually read it.
- **The ticket's three diagnostics are all PULL.** `which` and `list` only help
  someone who already suspects the bug; the entry point IS the ineffective
  switch. So `cmdalt set`/`reset` warn too — one printf, at the one moment the
  confused user is guaranteed to be standing there, and it means the diagnostic
  no longer depends on the `0130` picker landing.

Then the hole under the hole. The design's release-atomicity argument is that
the fat bake is self-enforcing: `foldPackages` plants package bins at
`/usr/bin/<cmd>` and `claim()` throws on a duplicate, so the instant
`/usr/bin/python` enters the manifest, every `--packages=all` bake dies unless
`packages/micropython.json` drops its alias in the same commit. That is true,
and verified both ways here (reinstating the alias throws exactly the predicted
message). **But it only covers packages that are FOLDED.** A `requires`-gated
definition — every `*-clang` variant, *including the `python-clang` this ticket
names as its suggestion* — is never folded, so `claim()` never sees it. Such a
definition would have built clean and planted the shadow at install: the exact
bug this item exists to close, with no build-time signal anywhere, arriving via
the very next lane.

So the design's "optional gucman hardening" got promoted and funded in both
tiers: `tools/mkpkg.js` refuses to BUILD a definition whose `bin` names a
dispatched command (pointing the author at `commands`), and gucman's bin-plant
loop refuses to install one. Only the mkpkg half has a firing test — the gucman
half is unreachable through the shipped pipeline (mkpkg won't build the
payload, gucman sha-verifies against the mkpkg index), so what is covered is
its non-firing path, by every install leg in the estate. Stated plainly rather
than papered over.

## Smaller decisions

- **Fold order matters.** The runtime claim lands in `/etc/cmdalt`, which
  outranks the baked `/usr/share/cmdalt`. For the fat bake to resolve
  identically, folded `commands` claims are spliced **ahead of** the baked body
  rather than appended the way openwith keys are — otherwise `python` on a fat
  image would resolve to the uninstalled `python-clang` suggestion.
- **Candidates dedup by value.** Picking a candidate writes it to the user
  layer, where it shadows the same value lower down; without the dedup the
  picker offers the chosen entry twice. `ca_candidates` layers this on
  `cfg_each`.
- **`gucman install <word0>` only when the word is bare.** A baked suggestion's
  first word names a package by convention; a user's own `/opt/foo/bin/py` pick
  gets "no such program" instead of an invented package name.
- **The signal table is not "keep the defaults".** `SIGINT`/`SIGQUIT` are
  ignored while waiting — the pgroup already delivered them, and the default
  disposition would kill the dispatcher and orphan a REPL that handles `^C`.
  `kill -9` on the dispatcher still orphans the child; unfixable without exec,
  recorded, not scheduled.

## Test gotchas worth remembering

- `driveBoot` returns stdout only, and every one of these diagnostics goes to
  **stderr**. Legs asserting message text need `2>&1` in the shell line.
- `foo -c "kill -TERM $$"` in a JS-authored script line expands `$$` in the
  OUTER hush — which is pid 1. It kills the boot, and every later leg reports
  as an empty section rather than as a failure. Single-quote it so the CHILD
  shell expands it.
- `/usr` is sealed, so a test cannot create a dispatch link there. The links go
  in `/usr/local/bin` — which is what a manifest `link` entry produces anyway,
  just in the writable tier — and the shadow legs use the real baked
  `/usr/bin/python`, planted LAST so they cannot perturb anything before them.
