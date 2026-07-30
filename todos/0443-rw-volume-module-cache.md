# 0443 — module cache for rw-volume binaries

- **Status**: open
- **Design**: parent `todos/0385` (investigation + emailed options); ruled 2026-07-30 (fix **A** of A/B)

## Goal

`python --version` costs ~2 s on jku's iPhone. The measured cause is that a gucman-installed binary
lives on the **rw root volume**, so the kernel module cache (`todos/0037`) excludes it and every spawn
compiles a fresh `WebAssembly.Module`. On JSC a non-shared module spawn costs ~150–230 ms against
~20–25 ms for a warm shared one. Give rw-volume binaries a **validated** cache entry.

This is the 4–10x lever: desktop Safari `python --version` **645 ms → 151 ms**.

The present RO-only policy is a special-case-the-easy-path artifact. **This ticket is the general
fix** — do not add a second narrow special case beside it.

## Scope

🔴 **`kernel.js` and `host.js` are at the REPO ROOT. `os/kernel.js` and `os/host.js` DO NOT EXIST.**
The written ruling names the `os/` paths; that is wrong and was verified wrong against the tree.
Anchors below were re-derived at `922dabe4` — **re-grep the symbol, do not trust the line number**:

- `kernel.js:2449` `Kernel.prototype._imageCacheKey`, `kernel.js:2459` `Kernel.prototype._moduleFor`.
  Call sites ~2370 (`this._imageCacheKey(spec.path)`) and ~2395 (`self._moduleFor(mkey, image)`).
- 🔴 **`host.js:9820` carries a load-bearing coupling — honour the ABI, do not fork it:**
  `const compileOptions = { builtins: ['js-string'], importedStringConstants: '#' };   // MUST MATCH kernel.js _moduleFor`
  ~9831 records that ss-flavored binaries are excluded by `_moduleFor`.

Validated key = **ino + size + mtime read through the store**. One entry per path; replace the entry
on key change.

## Plan

1. Extend the key derivation so a **mutable** path yields a *validated* key instead of falling to the
   bytes path. Keep one entry per path and replace on key change.
2. Keep these EXACTLY as they are: the RO `immutableKey` policy, the ss-flavor exclusion, the
   engine-rejected-bytes path, and the no-fs-dormant path.
3. Convert the rw-volume assertions in `tests/kernel/test_module_cache.js` — see Acceptance 1.
4. Measure warm `python --version` on desktop Safari, minimal image + gucman install.

## Acceptance

1. 🔴 **An automated in-OS recompile test** — `cc -o a.out && ./a.out`, edit, recompile, rerun; the
   second run must show the new binary's behaviour and **never** a stale Module.

   ⚠️ **This arm is ALREADY GREEN TODAY, and it is green for the WRONG REASON.**
   `tests/kernel/test_module_cache.js` (registered at `tests/kernel/run.js:49`) already asserts, under
   the comment *"Mutable (rw-volume) binary: bytes path, and a rewrite is seen at once"*:

   | existing assertion | line | fate under this ticket |
   |---|---|---|
   | `'rw binary ships bytes, no Module'` (`s3.module === null && s3.image !== null`) | 125 | 🔴 **must INVERT** |
   | `'rw binary never touches the cache'` (`st.misses === 1 && st.entries === 1`) | 127 | 🔴 **must INVERT** |
   | `'rebuilt rw binary ships the NEW bytes'` (rewrite seen at once) | 133 | 🟢 **must SURVIVE, converted** |

   The third assertion **is** the stale-Module guard, and it becomes *meaningful only now* — a bytes
   path cannot go stale, so today it guards nothing.

   ⇒ **A RED in this suite is EXPECTED. Invert assertions 1 and 2; preserve assertion 3's intent via
   the validated key. Delete nothing. Opt out of nothing.** The cheapest route to green is to weaken
   these assertions, which would destroy the guard that proves the RO / ss / engine-reject / no-fs
   paths are still correct. **Say in your report which assertions you converted and why.**

   ⭐ Extending this existing file adds **no** test file ⇒ the registered kernel total does not move.
   It was **137 registered / 138 on disk** at filing; the gap is `test_punes_e2e.js` = `todos/0396`,
   **not yours**. 🔴 **Re-derive both counts yourself — do not carry these numbers.**

2. Desktop Safari, minimal image + gucman install, **warm `python --version` p50 ≤ 210 ms** (parity
   with the 151 ms experiment plus noise). **Report the number.**

3. **No change** to the RO-volume (`todos/0037`) cache semantics.
   ⚠️ This is a **do-no-harm** arm — it is green before you start, so satisfying it is **not
   progress**. It exists to stop a regression.

4. Full gate green, every suite reported **with a NUMBER**. Heavy numbers live in `summary.json` at
   `runs[0]`, **not** the top level. A suite without a number is NOT RUN.

## Sequencing

**A before B** (`todos/0444`). Both sit after the P0 Rust band by insertion order and are deliberately
**not** `--blocked-by` it, so they slide with the band if it slips rather than freezing on it.
The parent `todos/0385` is hard-blocked on this ticket and 0444.
