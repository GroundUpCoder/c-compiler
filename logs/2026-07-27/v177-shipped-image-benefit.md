# Does v177 (todos/0332) help any binary in the SHIPPED gucOS image?

**Answer: YES — exactly one binary, `/bin/sameboy`, one function, `GB_display_run`
(the PPU). Measured 6.0x faster on the emulator's core loop (4.50s -> 0.75s for
600 frames).**

Read-only measurement lane. Nothing shipped was modified; `compiler.js`, `os/`,
`packages/` and `os/image.json` are untouched on this branch. New files are four
measurement tools under `tools/bench2x2/` plus this log.

## The question

`todos/0332` (merged `ab94f903`, image 177, **not yet deployed** — prod edge is
still v176) moved one constant in `compiler.js`: the switch-lowering br_table
range cap `512` -> `MAX_BR_TABLE_RANGE = 65520`. Every number justifying it was a
**CPython** number, and CPython is not in the gucOS image. So the honest prior was
"v177's value to gucOS users is UNKNOWN". This lane converts that to a number.

## Why a static scan answers it exactly

`compiler.js` (`CodeGenerator`, the `dense` block, ~line 18597) lowers a switch to
a jump table only when

```
nonDefaultCount >= 4  &&  range <= MAX_BR_TABLE_RANGE  &&  density >= 40%
```

and the emitted table has exactly `range` entries. 0332 moved that cap and
changed nothing else — the density term was not touched. Therefore:

> **a br_table with more than 512 entries IS, by construction, a switch the old
> compiler would have emitted as a linear `br_if` chain instead.**

Counting them is counting the fix's beneficiaries. No estimation involved.

## What "the shipped set" is, and how that was established

`serve.js`'s `--minimal` comment documents the deploy shape: the deployed origin
(`comguc/scripts/build.mjs` step 1) bakes a **plain `mkimage.js --out=…` with no
`--packages` fold**, then publishes the mkpkg repo at `/packages` (step 2). So the
shipped image is the minimal bake, and the optional apps are separately-shipped
gucman packages.

Both were measured:

| set | bake | size | wasm binaries |
|---|---|---|---|
| **shipped image** | `node tools/mkimage.js` | 22.1 MiB | 34 |
| packages folded in | `node tools/mkimage.js --packages=all` | 111.3 MiB | 44 |

The 22.1 MiB matches the known ~23 MB prod minimal image (the standing hazard is
the other direction — the *test* fixture is the 111 MB fat one, so a binary can be
"in the tests" and absent from prod).

**v176 vs v177 ships the same binary set.** `git show --stat a755018c` changes only
`compiler.js` and `os/image.json` (the version bump) — no C source. So baking
HEAD's manifest yields exactly the shipped set, compiled with the new cap.

## Result 1 — the shipped image: ONE qualifying switch

`node tools/bench2x2/imgbrtables.js /tmp/v177m/os-system-minimal.img --all`

```
files: 111 regular, 34 wasm (16.6 MiB of wasm)
br_tables: 1096 total
  size buckets: 1-16:837  17-128:220  129-512:38  513-4096:1
OVER CAP 512: 1 br_table(s)
  /bin/sameboy  func #825  entries=568  non-default=568  funcbytes=30895
```

1096 br_tables across the whole shipped image; **exactly one** needed the raised
cap. All 34 binaries were scanned — including `netsurf` (5.6 MB), `doom`, `wm`,
`term`, `notepad`, `calc`, `coreutils`, `sh`, `mgp`, `deck`, `ksvc`. Every one of
them except sameboy: **no change from v177 at all.**

Identified by forcing `emitNames` at the `generateCode` seam (no file modified):

```
func #825  GB_display_run  entries=568 non-default=568 bodybytes=30895
```

`non-default == entries` (perfectly dense) is the signature of the irreducible
`while (1) switch (__state)` lowering — the same shape as CPython's eval loop in
0332, here with 568 basic blocks.

`GB_display_run` is SameBoy's PPU. It is called from `GB_advance_cycles`
(`vendor/sameboy/core/timing.c:513`) — i.e. on **every emulated machine cycle**.

### Confirmed by construction, not inference

`tools/bench2x2/abcap.js` builds a project twice, rewriting only that one constant
in an in-memory copy of `compiler.js` (`os-common.buildProject` already takes the
compiler as a parameter, so nothing on disk is touched):

```
cap=65520 : 771489 bytes, 66 br_tables (1 with >512 entries), 68 chains /  635 compares, longest chain  40
cap=512   : 775394 bytes, 65 br_tables (0 with >512 entries), 69 chains / 1203 compares, longest chain 568
delta: size -3905 bytes, br_tables +1, chain compares -568
```

So at v176 `/bin/sameboy` really does carry a **568-long linear compare chain**
(~284 compares per state transition on average); at v177 it is a single indexed
jump, and the binary is **3,905 bytes smaller**.

### Runtime: 6.0x on the emulator core

`/bin/sameboy` is a win32/SDL GUI app — run standalone under `host.js` it prints
nothing, and timing it in-OS needs the kernel harness this lane is barred from
running. So `tools/bench2x2/sameboy_core_bench.{c,json}` links the **same 14
`core/*.c` TUs the shipped binary links** (only the frontend `src/main.c` is
replaced) and runs the real `GB_run_frame` cadence headlessly. It reproduces the
shipped binary's delta exactly (same 568-entry table, same -3905 bytes), so it is
measuring the shipped code path.

600 frames (10 emulated seconds), 3 runs each, `node host.js`:

| build | runs (s) | median | frames/s | vs realtime |
|---|---|---|---|---|
| cap=512 (**v176, what prod ships today**) | 4.56, 4.41, 4.50 | **4.50** | 133 | 2.2x |
| cap=65520 (**v177**) | 0.78, 0.74, 0.75 | **0.75** | 800 | 13.3x |

**6.0x.** Both builds print an identical framebuffer checksum
(`fbsum=30268f3e`, `vblanks=600`), so the work was neither skipped nor changed.

The headroom framing is the part that matters for a browser OS on modest
hardware: at v176 the PPU alone eats ~45% of the realtime budget on this machine
before any compositing, audio or rendering; at v177 it eats ~7.5%.

## Result 2 — the packages (also shipped, over `/packages`)

Same census on the all-packages bake: **7 qualifying br_tables across 5 binaries.**

| binary | function | entries | non-default | what it is |
|---|---|---|---|---|
| `/opt/sqlite3/sqlite3` | `sqlite3VdbeExec` | 1720 | 1720 | VDBE bytecode interpreter |
| `/opt/jq/jq` | `match_at` | 1667 | 1667 | Oniguruma regex matcher |
| `/opt/jq/jq` | `fetch_token` | 591 | 591 | lexer |
| `/bin/sameboy` | `GB_display_run` | 568 | 568 | PPU (the shipped-image one) |
| `/opt/jq/jq` | `jq_parse` | 551 | 551 | parser |
| `/opt/micropython/micropython` | `mp_execute_bytecode` | 529 | 529 | **bytecode interpreter — gucOS's `python`** |
| `/opt/punes/punes` | `cpu_exe_op` | 513 | 258 | NES CPU opcode dispatch |

0332's finding generalises exactly as its ticket predicted: **every bytecode
interpreter in the tree was hit.** Six of the seven are perfectly dense
(irreducible-lowering state machines); `punes` is the one ordinary user switch.

Runtime A/B for the two that run headlessly under `node host.js`:

| workload | v176 (cap 512) | v177 (cap 65520) | speedup |
|---|---|---|---|
| MicroPython, 2M-iteration arithmetic loop | 14.46s | 0.91s | **15.9x** (16.7x startup-corrected) |
| SQLite, 200k-row insert + aggregate + group-by | ~15.4s | 0.58s | **~26x** |

Both produce byte-identical output across the two builds. Startup is unchanged
(0.045s either way), consistent with 0332's own finding that startup is a
separate defect (todos/0334).

MicroPython is the notable one: it is `/usr/local/bin/python` in gucOS, so **the
`python` users actually run is ~16x faster on CPU-bound work** once v177 deploys
and packages are rebuilt.

## Limits — what this does NOT establish

- **The 6.0x sameboy number is from a PPU-dominated workload.** The bench ROM is
  an infinite `JR -2` spin, which isolates per-cycle PPU work by design. A real
  game also runs CPU work that gets no benefit (the SM83 opcode dispatch is a
  256-entry switch — already under the old cap, unchanged). So 6.0x is an **upper
  bound** on the whole-emulator speedup for a real ROM. The in-OS,
  real-ROM, real-compositor speedup is **UNMEASURED**.
- **No in-OS or browser measurement was taken at all.** Heavy suites (kernel,
  sweep) were deliberately not run. Everything here is `node host.js` standalone.
- **The SQLite row is 2 runs per arm, not 3** (14.91/15.83 vs 0.57/0.59). The
  MicroPython and sameboy rows are 3 runs each.
- **Package numbers assume a v177 rebuild.** Packages are built by `mkpkg` at
  deploy time, so they pick the fix up with the deploying compiler — but that is
  a property of the deploy, not something measured here.
- Only the **wasm** payloads were scanned; JS assets (`kernel.js`, `os.html`,
  `host.js`) are not compiler output and are out of scope by construction.
- Symlinks were not followed during the image walk, so `/bin/*` -> `coreutils`
  links are counted once via the real `/bin/coreutils` inode. No binary is
  double-counted, and none is missed.

## Tools added (all read-only w.r.t. shipped code)

- `tools/bench2x2/imgbrtables.js` — br_table census over every wasm binary inside
  a baked BlockFS image. Fails loud (exit 3) if it finds zero wasm, because a
  broken walk otherwise reports as "0 over cap", which reads like a real answer.
  (It did exactly that on the first run: `BlockFS.read` is POSIX-shaped
  `read(fd, buf, count)`, not `read(fd, count)`.)
- `tools/bench2x2/abcap.js` — builds one `bin.json` at both caps by rewriting the
  constant in an in-memory copy of `compiler.js`, and diffs br_tables / compare
  chains / size.
- `tools/bench2x2/sameboy_core_bench.{c,json}` — headless SameBoy core harness.

## Bottom line

v177 is **not** a no-op for today's users, but its shipped-image footprint is
narrow and specific: **one binary of 34, one function, 6.0x on that function's
loop, 3.9 KB smaller.** The much larger win is in the separately-shipped
packages — MicroPython (~16x) and SQLite (~26x) — which is where the "every
bytecode interpreter was hit" story actually pays off.
