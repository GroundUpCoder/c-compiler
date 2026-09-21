# 0269 wasm-nondeterminism repro harness

Force-committed under a gitignored `build/` path (regression tripwire for the
SameBoy byte-identity deploy gate). See
`logs/2026-07-20/wasm-nondeterminism-rootcause.md` for the full finding.

- `build-once.js`          — build vendor/sameboy/bin.json @ HEAD, print sha256 + length.
- `build-once-orig.js`     — same, using compiler.js+os-common.js pinned at 7d04f1d (dir `orig/`).
- `run-harness.sh N [args]`— loop N FRESH node processes @ HEAD, tally distinct SHAs. Extra args pass to node (e.g. `--stack-size=300`).
- `run-orig.sh N [args]`   — same, pinned @ 7d04f1d.
- `inproc-repeat.js N`     — build N times in ONE process (mimics a bake). `PIN=1` uses `orig/`.

`orig/` (compiler.js + os-common.js @ 7d04f1d) is NOT committed — regenerate:

    mkdir -p build/nondeterminism-0269/orig
    git show 7d04f1d:compiler.js      > build/nondeterminism-0269/orig/compiler.js
    git show 7d04f1d:os/os-common.js  > build/nondeterminism-0269/orig/os-common.js

Result (2026-07-20): 185 builds, 1 distinct SHA. --stack-size sweep 66..4000 KB
identical. See the log.
