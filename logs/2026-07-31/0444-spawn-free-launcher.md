# 0444 (#189): spawn-free gucman launchers — and the hush store bug it uncovered

## What shipped

All six package launchers (`cpython-clang`, `etl-clang`, `quake`, `sent`,
`stl4`, `tinyrenderer-clang` — derived from `packages/*.json` at this HEAD:
27 packages, 6 with a `/bin/sh` launcher, 0 without the convention) drop the
`$(dirname "$(realpath "$0")")` self-location. That command substitution cost
four processes per launch: two subshells, `realpath`, `dirname`. The census
for `python --version` went from seven processes to three (cmdalt → launcher
hush → wasm).

## Design note: known-prefix probe, variable-free

The lane had to choose between a known-prefix probe and install-time prefix
substitution. The probe won. A package has exactly two plant sites —
`/opt/<name>` from `gucman install` and `/usr/opt/<name>` from the
`os-common.js` bake fold — so the launcher probes `/opt/<name>` first and
falls back to `/usr/opt/<name>`. The probe uses only hush builtins
(`[` via `CONFIG_HUSH_TEST=y`, `cd`, `exec`, `export`), so it spawns nothing.
Substitution lost because it needs twin rewrite machinery in two languages
(gucman's C install path and the JS bake fold), it complicates gucman's
checksum-gated remove (the DB records bytes as planted), and it breaks the
byte-identity of a payload across install and bake. The probe keeps one
payload byte-for-byte in both worlds. `/opt` wins when both sites exist —
the same installed-over-baked rule that puts `/usr/local/bin` ahead of
`/bin` on PATH.

The two launcher variants survive intact. The four exec-form launchers exec
absolute literal paths, so CPython's stdlib walk-up from the resolved
executable is unchanged, and the pyc cache export
(`PYTHONPYCACHEPREFIX=/var/cache/cpython-clang`) is preserved. The two
cd-form launchers (`quake`, `sent`) keep their load-bearing `cd` — quake
resolves `./id1/pak0.pak` and writes config.cfg relative to the CWD, sent
opens deck image refs relative to `share/` — as a builtin `cd`-else-`cd`
chain. The quake launcher deliberately stays the game's waiting parent
(no exec): the e2e's pkill contract and job control rely on it.

**Migration**: payloads rebuild from `packages/*.json` on every `mkpkg` run,
so every new install gets the new launcher, and a fat bake gets it at the
next image bake. Already-installed launchers keep the old bytes until the
package is reinstalled: `gucman remove <name>` then `gucman install <name>`
(gucman has no upgrade verb). The old launchers still function where they
functioned before, so no forced migration is needed.

## The bug the census found: #296

The first probe form used one variable (`pkg=/opt/<name>`; `[ -d "$pkg" ] ||
pkg=/usr/opt/<name>`). The census then showed the wasm spawn with an EMPTY
`$pkg` — and shrinking the repro revealed a P0 that has nothing to do with
launchers: **a plain shell-variable assignment inside a `sh`-run script FILE
silently expands empty under the default boot env** (`a=1` then `echo $a`
prints nothing). Interactive, `sh -c`, sourcing, and `export NAME=v` all
work. The trigger is the exact environ layout (five vars; leave-one-out
shows only dropping `PWD` fixes it; adding any sixth var also fixes it) —
a layout-sensitive store corruption, suspected in libc's setenv/putenv or
hush's NOMMU environ-backed store around the startup PWD replace. Filed as
#296 with the full sensitivity map.

Two things made this invisible until now. First, the only estate test that
executes an assignment-bearing launcher is `test_cpython_clang_e2e`, and it
SKIPs (exit 0) without the clang-simplified sibling overlay — so "kernel
N/N green" never proved those legs ran. Second, browser boots dodge the
layout (0443's Safari measurements were real). The old launchers repro
broken as far back as `af2059d2` (the 0340 merge fix) under today's default
env.

Consequence for this lane: the launchers landed VARIABLE-FREE — literal-path
`[ -d ] && exec` branches, `cd`-else-`cd`, one-line `export`. They work
under the bug and after its fix. `tests/host/test_launcher_convention.js`
pins the convention (no command substitution, both plant sites, no plain
assignment until #296 closes — L67 in the register).

## Numbers

- Census (in-OS strace, minimal image, cpython-clang the only installed
  python provider — micropython absent): **2 traced SPAWNs = 3 processes**,
  spawn lines name the launcher and the wasm. Red control: the pre-rewrite
  launchers fail the convention lint 6/6.
- Desktop Safari (0443 harness, warm p50, this rig): `python --version`
  **63 ms** (target ≤ 90; ticket projection 68), `python -c pass` **108 ms**
  (target ≤ 140; projection 109). Baseline the same morning on the same rig:
  611 ms / 187 ms (the harness does not check exit codes, and given #296 the
  old launcher's state in that boot is suspect; 0443's accepted before-value
  was 132 ms).
- Regression guards: `test_gucman_quake_e2e` (installed prefix) PASS,
  `test_os_apps_e2e` (baked quake) PASS, `test_present_e2e` (sent now driven
  through the baked `slides` launcher) PASS ×2.
