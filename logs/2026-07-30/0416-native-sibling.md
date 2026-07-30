# todos/0416 — the `native-sibling` packaging seam, `mkpkg --rust`, wc-rust

Lane A4 of the Rust program (todos/RUST.md §3 rules 4–6). Two commits: the
rename, then the second producer.

## The rename (one change, no alias)

`clang-sibling` → `native-sibling:clang`, `clangApp` → `nativeApp`,
`clangFile` → `nativeFile`, over the carrier set DERIVED by token grep (25
files: 11 package definitions — note `sdldemo` and `stl4` do not end in
`-clang`, so a filename glob misses two; find carriers by TOKEN), the seam
code (`tools/mkpkg.js`, `os/os-common.js`, `serve-with-clang.js`), five test
files, `tools/clang-unpackaged.json`, and four living `todos/` docs. The old
value is pinned DEAD by a parser check in `test_native_base_purity.js` — that
assertion is the one deliberate surviving occurrence of the old token.

**Decision — the gate names the producer in ONE field**:
`requires: "native-sibling:<producer>"` (`clang` | `rust`), parsed in one
place (`os-common nativeSiblingProducer`). The alternative — a separate
`producer` field beside `requires: "native-sibling"` — puts one fact in two
fields that can disagree, and every reader must check both. The rule can now
say which sibling a definition needs: "clang sibling present, Rust sibling
absent" enumerates correctly (`listPackages` takes `producers: [...]`,
scoped per producer; the old `withClang` boolean could not say this).

## The second producer

- `mkpkg` gained a `SIBLINGS` registry; `--clang` / `--rust` are independent
  booleans (neither/one/both — superset index over whatever was asked), each
  with `--<p>-root=` / `--<p>-unpackaged=`, per-producer overlay preflight
  (exit 1 + fix command when EXPLICITLY requested and absent; an unrequested
  absent sibling prints nothing) and a per-producer drift gate.
- NEW loud path: a gated def whose `requires` is not a known gate fails
  EVERY build (before, listPackages silently excluded it forever — base
  purity by construction had a silent-typo shadow). Naming a gated package
  without its flag now says `build it with --rust` instead of
  "unknown package".
- `serve.js --packages-index=<p>[,<p>]` generalizes the clang-only guard.
- The producer side: `gucos-rust tools/mk-overlay.mjs` (new, in the sibling)
  publishes `out-image/overlay.json` (`overlay@1`, id `rust-apps`,
  per-file sha256) from `out/*.wasm` — shipping tools only (`wc-rust`; the
  demo crates stay committed fixtures). `packages/wc-rust.json` consumes it
  through the ONE `loadOverlays` verifier, exactly as clangApps always did.

## Gotchas hit

- A kernel e2e that spawns `serve.js` must `process.exit(0)` explicitly on
  success: the server child's live pipes keep the event loop alive and the
  test HANGS GREEN after printing OK (the exit handler is what kills the
  child). Diagnosed via `sample` (idle kevent loop, no boot child).
- Piping a long-running test through `tail` makes its interim output
  invisible (tail prints only at EOF) — redirect to a file instead.
- **Fat bakes are nondeterministic on main itself** (the known quake
  `__TIME__`): two `--packages=all` bakes of the UNTOUCHED origin/main tree
  differ at byte 36 (the seal sha). The byte-identity guardrail is therefore
  proven on the PLAIN image (the deploy's base shape, which RUST.md rule 5
  names), plus a fold-set identity check on the fat pair. Without the
  main-vs-main control this would have read as a regression in this branch.

## The guardrail numbers (all measured on this branch vs origin/main@3802964b)

- plain base image: **byte-identical** (sha256 `0b70f0eb…9041` both sides,
  24,248,544 bytes, v199). Positive control in the same invocation: plain
  vs fat DIFFER (the comparator detects differences).
- fat pair: same v199, same 15-package fold set; not byte-comparable (the
  pre-existing quake nondeterminism above, proven main-vs-main).
- `mkpkg --rust` against the real sibling: drift gate `1 overlay app(s),
  all packaged`, wc-rust 1.0.0 payload built, index baseVersion 199.

Tests added: `tests/serve/test_mkpkg_rust.js` (21 checks — purity + the
POSITIVE control in one run, sha256 refusal, absent-sibling exits, rust
drift gate, unknown-gate validation), `tests/kernel/test_rust_pkgs_e2e.js`
(real-overlay channel e2e; SKIP without the sibling; kernel registry now
138), `tests/browser/os-rust.mjs` (the 0413-deferred browser leg: install +
run wc-rust in the gucOS terminal over a fixture-derived synthetic sibling;
sweep now discovers 43 files).
