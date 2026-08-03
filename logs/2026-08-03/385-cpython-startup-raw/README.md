# 0385 cpython-clang startup — raw driver output + two unsalvaged harnesses

**Provenance.** Recovered by the night decider on 2026-08-03 from a pruned worktree
(`~/worktree/salvage/c-compiler-2026-08-03/0379-cpython-startup/`), which existed in no
git object.

**🔴 Read this before assuming the harnesses were lost.** Most of that salvage tree was
**already committed** and is NOT duplicated here. The 0385 lane's probe drivers live at
`logs/2026-07-28/0385-*.js` / `*.mjs` and are referenced by name in the design log
`logs/2026-07-28/0385-cpython-startup.md`. The salvaged copies differed from the
committed ones only by the `0379`→`0385` id rename and the `__dirname` relocation applied
when they were committed — i.e. they were the pre-commit originals, strictly redundant.
(The lane's branch was named `0379-cpython-startup` because the kickoff hand-wrote an id
that was already taken; the ticket and log carry the real id, **0385** = ticket `#159`.)

What was genuinely missing, and is committed here:

| File | Why it was not already in git |
|---|---|
| `compile-price.js` | A probe driver that never got the `0385-` rename treatment, so it was never committed alongside its siblings. |
| `measure-safari3.mjs` | Third Safari measurement iteration; only `measure-safari.mjs` and `measure-safari2.mjs` were committed. |
| `boot1.{out,err}.txt`, `boot2.out.txt`, `safari{,3,4,5}.{out,err}.txt` | **Raw driver output.** The design log summarises these numbers; the raw streams behind them were never committed. |

## Why keep the raw output

Ticket **`#159`** (`0385` — cpython-clang startup latency, ~2 s for `python --version`
on iPhone) is **open, P2, medium, ready**. Its recorded status is *"root cause measured,
fix path measured (~10× on desktop Safari), options reported to jku by email — nothing
landed in the product; the fixes need a decider/coordinator call."*

So the measurement is the asset and the fix is the open question. When someone finally
takes `#159`, the fix has to be validated against the **same** numbers — and a summary
in a design log is not re-checkable the way the raw driver streams are. These files are
the before-picture for a change nobody has made yet.

Nothing here is a test. Nothing here is expected to be green.
