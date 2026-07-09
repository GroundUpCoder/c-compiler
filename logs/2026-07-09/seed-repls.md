# 0036 — seeding the REPLs: lua, micropython, sqlite3

Closed `todos/0036` (now in `todos/done/`): the three interpreter vendor
projects are seeded into the OS image as `/bin/lua`, `/bin/micropython`,
`/bin/sqlite3` — three `project` entries in `os/image.json`, version 30 → 31.

## Seed cost (the item's "measure first" gate)

Full fresh bake via `tools/mkimage.js`, same machine, same session:

| | wall | blob size |
|---|---|---|
| before (v30 manifest) | 9.1s | 2.6 MiB |
| after (v31, +3 REPLs) | 16.1s | 4.8 MiB |

The +7.0s split (standalone CLI builds): **micropython ~4.2s** (119 TUs),
sqlite ~1.8s (the 250-KLOC amalgamation is ONE big TU — cheaper than
feared; the item guessed sqlite would be the heavy one, it's mp),
lua ~1.0s. Wasm sizes: lua 257K, mp 502K, sqlite 1.26M.

Verdict: all three go in. Since 0040 the browser fetches the prebaked
`os/os-system.img` (or reuses a current OPFS blob), so the 16s bake is
only the no-blob fallback path; headless boot.js re-bakes only when the
manifest outruns the blob. Nobody pays 16s on a warm boot.

## One enabler in the bake pipeline

`os-common.js buildProject` threw on unknown compilerArgs — micropython's
bin.json carries `--gc-spill-locals` (precise-GC root scanning). Mapped it
to `compilerOptions.gcSpillLocals` exactly like the CLI flag. (`-D`/`-I`/
`--allow-old-c` were already handled.)

## The find: brokered fsync crashed the process worker

Acceptance testing sqlite3 against a **file-backed** DB under the OS died
with `SEGV` on the first write statement (in-memory DBs and standalone
`node host.js` runs were fine). Kernel log had the real story:

    pid 4 crashed: TypeError: Cannot read properties of undefined (reading 'flush')

`toWasmEnv`'s `fsync`/`fdatasync` were inline `this._s.flush()` — `_s` is
the BlockFS-private store handle, and RemoteFS (the brokered process-side
fs, which reuses toWasmEnv over its RPC method surface) has no `_s`. The
env comment even documents the contract ("implements the same JS method
surface that toWasmEnv dispatches to via `this.`") — fsync just predated
its enforcement, and nothing brokered had ever called fsync until
sqlite3's journal did.

Fix (test-first: failing leg in `test_fs_e2e.js` committed at `47d29d7`,
fix at `f4203f6`): `fsync` is now a real method on the fs surface —
BlockFS flushes its store (semantics unchanged, still no fd validation),
MountFS routes by fd to the owning volume, RemoteFS sends the new
`FS_FSYNC` (0x041F) RPC; kernel-side, `file` OFDs flush the one kernel
fs, tty/pipe/socket/null answer a harmless 0, bad fds get EBADF.

**Lesson**: the RemoteFS/toWasmEnv reuse contract is only as strong as
the env entries that honor it. When adding an env entry, dispatch via
`this.` — never reach for BlockFS-private state. (Swept the rest of the
env body for siblings: everything else touches state RemoteFS actually
has — `_fdTable` markers, `_stdinSab` nulls, `_sigcheck`, `_lastError`.)

## Acceptance

- Piped, in-OS (`os/boot.js`): `echo 'print(1+1)' | lua` → 2,
  `| micropython` → 2, `echo 'select 1+1;' | sqlite3` → 2; all EXIT on
  EOF (the mp spin-on-EOF class stayed fixed — uart_core.c's EOF→Ctrl-D
  is load-bearing here). sqlite3 file-DB round-trip: create/insert/
  reopen/count across three invocations, `.quit`, argv-SQL.
- Interactive over a kernel pty: NEW `tests/kernel/test_repl_pty_e2e.js`
  — a C master (openpty + spawn-on-slave, own pgroup so the master-close
  SIGHUP can't shoot the driver) runs all three: banner/prompt, eval,
  canonical-mode `\x7f` erase in front of mp's readline, `^D` exit.
  Builds the real vendor bin.jsons (~8s) — deliberately the headless twin
  of "open term, type at the REPL".
- Suites: blockfs PASS, kernel PASS (incl. the new test).

## Pty framing gotchas (for the next REPL-shaped test)

- micropython emits `\r\n` itself; the slave's ONLCR then doubles the
  `\r` — the result line arrives as `\r\n42\r\r\n`. Markers must not
  assume `42\r\n`.
- sqlite3 on a tty defaults to BOX-DRAWN result tables (UTF-8 borders) —
  `.mode list` first if you want to match bare values.
- Writing two lines before the first one's prompt returns interleaves
  echo and prompt ordering; don't anchor markers on `\r\n` boundaries
  across that seam.

## Scope notes

- micropython is the **minimal port**: REPL only — argv ignored, no
  `open()` builtin, no import-from-fs (`mp_lexer_new_from_file` raises
  ENOENT). A unix-port-style upgrade (script args, vfs) would be a new
  queue item if wanted.
- lua prints its banner/prompts even when piped: `-DLUA_USE_C89` defines
  `lua_stdin_is_tty()` as constant 1 (ANSI C has no isatty). Upstream-
  vanilla behavior, not an isatty bug — sqlite3, which really calls
  `isatty(0)`, is correctly byte-clean under pipes.
- No Start-menu entries for the REPLs: os-shell.mjs pixel-asserts the
  baked menu at exactly 7 entries; menu/desktop integration belongs to
  the desktop wave (0047–0049) if wanted.
