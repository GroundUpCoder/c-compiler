# 0403 — `quake-renders.mjs` claims to refuse stale artifacts but only checks existence

- **Status**: open
- **Design**: none needed — the fix is a freshness comparison, not a new mechanism.

## Goal

Make the guard in `tests/browser/quake-renders.mjs` do what its own comment says. Today the
comment promises freshness and the code proves existence only.

## The defect, verbatim

`tests/browser/quake-renders.mjs:48`:

```js
// Build artifacts must exist — refuse to test stale state.
for (const f of ['quake.wasm', 'pak0.pak', 'host.js']) {
  const p = path.join(__dirname, 'www', f);
  if (!fs.existsSync(p)) {
    console.error(`Missing ${p} — run 'npm run build:quake' first.`);
    process.exit(1);
  }
}
```

`fs.existsSync` answers "is there a file here", never "was this file built from the current
sources". A `quake.wasm` produced by an older `compiler.js` passes this guard. The suite then
renders that stale artifact and reports a result **as if it had refused to**.

## Why it matters

This is the failure mode that makes a render measurement lie in the safe direction. The suite
exists to catch codegen and renderer regressions. If a compiler change does not rebuild
`quake.wasm`, the guard waves the old binary through and the suite reports the OLD compiler's
behaviour under the NEW compiler's name. A regression reads as green, and a fix reads as
already-landed.

⚠️ This has already burned a measurement once in this estate: the mGBA investigation chased a
codegen bug that turned out to be a stale measurement (see the `mgba-fix-plan-compiler-js-first`
history — only the upstream ALU-flush backport was real).

⭐ **The comment is the tell.** A comment that states a stronger guarantee than its code
delivers is more dangerous than no comment, because the next reader stops looking.

## Plan

1. Decide the freshness relation. The cheap, honest one is an **mtime comparison**: every
   artifact in `www/` must be newer than every input that produces it (at minimum
   `compiler.js`, the quake sources, and the packer). A stronger one is a **content hash of
   the inputs** recorded beside the artifact at build time and re-checked here.
2. Implement it in the guard, and make the failure message name **which** artifact is stale
   and **which** input outran it — not just "missing".
3. Audit the sibling browser suites for the same shape. This guard was almost certainly copied.
   Any other `existsSync` loop under a "must be fresh"/"refuse stale" comment is the same bug.
4. If the freshness check cannot be made reliable for one artifact (e.g. `pak0.pak` is a
   downloaded asset with no local input), say so **in the comment**, and narrow the comment to
   the guarantee the code actually gives. Do not leave a promise the code does not keep.

## Acceptance

- A deliberately stale `quake.wasm` (touch an input after building) makes the suite **exit
  non-zero** with a message naming the stale artifact and the newer input.
- A clean build passes unchanged.
- No comment in the touched files promises a guarantee its code does not enforce.
- `node todos/queue.js check` and `node tests/todos/run.js` pass.

## Notes

- Filed by the coordinator at cont-149. The defect was found by reading, not by a failing
  test — there is **no repro in the queue** and nothing is currently known to be measuring a
  stale artifact.
- todos/tests-only change ⇒ **no `os/image.json` bump owed**, unless the fix changes the build
  itself.
