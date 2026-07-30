# 0444 — spawn-free gucman launcher

- **Status**: open
- **Design**: parent `todos/0385` (investigation + emailed options); ruled 2026-07-30 (fix **B** of A/B)

## Goal

`python --version` is **seven** process spawns: hush → cmdalt → `/bin/sh` launcher → `$(dirname …)`
subshell → `$(realpath …)` subshell → realpath → dirname → the wasm. **Four of the seven exist only so
the launcher can locate its own directory.** Remove them.

With `todos/0443` landed this took desktop Safari `python --version` to **68 ms** and `python -c pass`
to **109 ms** (warm p50).

## Scope

Replace the `$(dirname "$(realpath "$0")")` self-location convention. **The launcher must contain zero
subshells.**

The lane picks **known-prefix probe** (`/opt/<name>` else `/usr/opt/<name>`) vs **install-time prefix
substitution**, and records a one-paragraph design note saying which and why. **The ticket must state
how already-installed launchers migrate** — regenerate on gucman upgrade, or a documented reinstall.
Build the general fix; do not special-case one package.

🔴 **DERIVE the launcher set from `packages/*.json` (the `content` field) and PRINT THE COUNT.**
Re-derived at `922dabe4`: **26 packages, exactly 6 ship a `/bin/sh` launcher, all 6 use the
convention, 0 ship a launcher without it.**

```
cpython-clang.json  etl-clang.json  quake.json  sent.json  stl4.json  tinyrenderer-clang.json
```

If you derive **fewer than 6**, your grep is wrong; if **more**, the estate grew and that is the real
answer. Do not carry the number — re-derive it.

🔴 **Two variants exist and they are NOT interchangeable:**

- **4 exec-form** — `here="$(dirname "$(realpath "$0")")"` then `exec "$here/…"`
  (`cpython-clang`, `etl-clang`, `stl4`, `tinyrenderer-clang`).
- **2 cd-form** — `cd "$(dirname "$(realpath "$0")")"`, because they resolve data **relative to CWD**:
  `quake` (`./id1/pak0.pak`; `sys_sdl.c` basedir `"."`) and `sent` (`.../share`, then
  `../sent demo.sent`). 🔴 **A rewrite that drops the `cd` breaks these two.**

**State per launcher why the new form preserves its contract.** Each existing launcher also documents
its own reason (`todos/0263` realpath-through-symlinks; the pyc cache prefix) — **preserve those.**

## Acceptance

1. In-OS strace census shows **3 processes** (hush → cmdalt → wasm).

   🔴 **The census must name `cpython-clang` explicitly and pin which package provides `python` in the
   image under test.** `grep -ln '"python"' packages/*.json` returns **BOTH `cpython-clang.json` AND
   `micropython.json`** (micropython maps `commands: { python: micropython }`), and **micropython
   already exhibits 3 processes** — so a census of bare `python` can **pass having measured the wrong
   binary entirely.**

2. With `todos/0443` landed, desktop Safari warm p50 **≤ 90 ms** (`--version`) / **≤ 140 ms**
   (`-c pass`). **Report both numbers.** Measured endpoints were 68 ms / 109 ms.

3. 🔴 **`quake` and `sent` still find their data.**

   ⚠️ **This arm REPLACES the written ruling's arm 3, which is UNSATISFIABLE.** The ruling reads *"the
   micropython launcher passes the same census"*, inherited from `todos/0385`'s own "(micropython
   too)". **`packages/micropython.json` ships NO launcher at all** — it is
   `files: { micropython: { project: vendor/micropython/bin.json } }`, `bin: { micropython:
   "micropython" }`, `commands: { python: "micropython" }`, invoked **directly as a wasm binary**.
   There is nothing to fix and nothing to census.

   ⭐ **Micropython inverts into the useful thing: it is ALREADY the 3-process shape this ticket is
   chasing** — an in-tree existence proof of the target, and a reference for the design.

   `quake` and `sent` are the cd-form regression risk and **the only launchers that can break
   silently**, which is why they are the real arm 3.

4. Gate green, every suite reported **with a NUMBER**. Heavy numbers live in `summary.json` at
   `runs[0]`, not the top level.

## Sequencing

**After `todos/0443`** — the ≤ 90 ms / ≤ 140 ms thresholds in arm 2 assume A's module cache has
landed. Both tickets sit after the P0 Rust band by insertion order and are deliberately **not**
`--blocked-by` it, so they slide with the band if it slips. The parent `todos/0385` is hard-blocked on
0443 and this ticket.
