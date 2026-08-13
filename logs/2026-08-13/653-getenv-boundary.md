# #653 — `System.getenv` sandbox boundary: in-OS REACHABLE under Node hosting (escalated, no code change)

Ticket #653 asked which of two worlds `runSsModule`'s `System.getenv` lives in:
host-only tooling (full host env correct), or reachable from in-OS code (a real
boundary finding). The audit that filed it said "likely by design". The answer
is **conditional on the host, and the Node-hosted half is in-OS reachable** —
the escalation branch, not the document-and-close branch.

## The site

`host.js:10995`, inside `runSsModule` (`host.js:10971`), the `'ss'` import
namespace:

```js
'System.getenv': (typeof process !== 'undefined' && process.env)
  ? function (name) { return process.env[name] != null ? process.env[name] : null; }
  : function () { return null; },
```

`System.cwd` (`host.js:10998`) has the identical guard shape and is part of the
same finding: under Node it returns the **host** process's real cwd, not the
in-OS cwd the spawn spec set.

## The call path (kernel spawn → full host env), file:line

1. Any in-OS spawn (hush `./foo`, `activate()`, posix_spawn) reaches the kernel
   spawn path. `Kernel.prototype._moduleFor` (`kernel.js:2619`) compiles the
   image and **deliberately detects the ss flavor** (`kernel.js:2628`: any
   import with `module === 'ss'`) — excluding it from the module cache so the
   **bytes** ship to the process worker. ss-flavored spawns are a supported,
   first-class kernel path, not an accident.
2. Node hosting: `nodeCreateWorker` (`kernel.js:8965`) runs `BOOT_SOURCE`
   (`kernel.js:8891`) in a `worker_threads.Worker`, which calls `runModule`
   with `env: envObj(wd.envp)` — the in-OS env grant.
3. `runModule`'s flavor dispatch (`host.js:11095`) routes any module importing
   the `ss` namespace to `runSsModule` (`host.js:11101`) — passing **only**
   `{writeOut, writeErr, args}`. The in-OS `env` grant is dropped on the floor.
4. `runSsModule`'s `System.getenv` reads `process.env` directly. A Node
   `worker_threads` worker shares the host process's full environment. Every
   variable in the boot.js invoker's shell — not a grant list — is readable by
   the in-OS-spawned module.

Contrast with the C flavor, where the boundary HOLDS in every context: the same
`env` option is seeded into wasm memory via `__set_environ`
(`host.js:12854-12873`), so a C process sees exactly the envp its spawn spec
granted.

## Hosting contexts enumerated

| context | `process` | what an in-OS-spawned ss module's `getenv` returns |
|---|---|---|
| Browser gucOS (`os.html` → `os/process-worker.js:102`) | undefined (Web Worker) | `null` always — boundary holds by construction |
| Node-hosted gucOS (`os/boot.js` → `nodeCreateWorker` `kernel.js:8965`; the kernel e2e suite the same way) | defined, env shared with the host process | **the full host environment** (and `System.cwd` = host cwd) |
| Node CLI (`node host.js prog.wasm`, call sites `host.js:13205`/`13235`) | defined | full host env — but this is host tooling, and the C path there passes `env: process.env` explicitly too; uniform and correct, same trust as running any node script |
| serve.js | — | never runs modules |

## Can in-OS code actually produce an ss binary?

Yes, trivially. Nothing ss-flavored is baked (`os/image.json` and `packages/`
have zero ss entries; the ss compiler lives host-side in `~/git/self-hosting`
and is not seeded), so no baked binary hits this today — but the flavor
dispatch keys off the module's own imports, not provenance. A wasm module
importing anything from namespace `ss` is all it takes, and
`tests/kernel/test_module_cache.js:66-72` contains one **hand-written in ~30
bytes**, placed at `/bin/ssmod` and spawned through `kernel.service` — an
executable proof that placed bytes + spawn reaches `runSsModule`. Any in-OS
program that can write a file (cc-compiled C, lua, micropython) can construct
those bytes; spawn peeks `\0asm` and runs it.

## Verdict and severity, honestly stated

- **Browser production (groundupcoder.com): safe by construction.** No
  `process`, `getenv` returns `null`.
- **Node-hosted gucOS (boot.js, kernel e2e): the in-OS sandbox's environment
  boundary does not hold for ss-flavored binaries.** An in-OS actor who can
  write a file and spawn it reads the invoking developer's full shell
  environment. Today's exposure is bounded — boot.js runs dev/test workloads,
  nobody feeds it adversarial in-OS code — but the pkgdev epic's premise is
  exactly that in-OS-developed code runs inside gucOS's guarantees, and this is
  a written-down place where that claim is false under Node hosting.
- **Secondary functional gap, independent of the leak:** ss modules never
  receive their spawn envp grant in ANY context — `runModule` drops the `env`
  option at the ss dispatch (`host.js:11101`), so even in the browser an ss
  module gets `null` where its spawn spec granted variables. The natural fix
  for both findings is the same: plumb the granted `env` into `runSsModule` and
  serve `System.getenv` from it (and `System.cwd` from the spawn cwd) whenever
  a grant is present, keeping the raw `process.env` fallback only for the
  direct host CLI path, which already passes `env: process.env` explicitly.

## Why no code or comment landed under this ticket

The ticket's own text: "If in-OS code can reach it: that is a real boundary
finding and should be re-filed at a priority this ticket does not carry —
surface it rather than fixing it quietly under a P3." This log + the escalation
report to master is that surfacing. A rationale comment at `host.js:10995` was
deliberately NOT added either: the acceptance is an OR (rationale at site for
the host-only outcome, escalation for this one), and a true gap comment
requires a funding ticket plus a `todos/LIABILITIES.md` entry in the same
commit (the enrolment rule) — the funding ticket is master's to file. The
follow-up ticket should carry the site comment and the register entry with it.
