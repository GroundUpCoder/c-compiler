# #319 — win32 memory-safety batch (W1-TB)

Four measured memory/data-corruption bugs in the veneer's string/path/hive
plumbing. Each corrupted memory or operated on the wrong data **while
reporting success** — the class where silence is the bug.

## Gap #33 — wsprintf wrote 1025 units into a 1024-unit contract

`wvsprintfW`/`wsprintfA` called their formatter with cap **1025**, so a
long format stored 1024 characters and landed the terminator at
`out[1024]` — one unit past MSDN's 1024-unit buffer contract, i.e. real
corruption of whatever the caller put after the buffer. Fix: cap 1024
(1023 chars + NUL at `[1023]`), return capped at 1023. `wvsprintfW`,
`wsprintfA` in `os/win32/crt16.c`. Pinned by canary-fenced checks in
k32demo (`test_strings`): the words at `[1024]`/`[1025]` must survive.

## Gap #34 — DrawText silently truncated at 128 lines / 255-byte `&` lines

Two independent silent cuts: a fixed 128-entry line array (DT_CALCRECT
under-reported tall texts, so callers mis-sized controls) and a fixed
256-byte strip buffer that only ever cut lines *containing `&`* —
data-dependent truncation. Both are LIFTED, not capped-loudly: the line
list is a growable span array (`DtSpan` + `dt_push`, stack batch of 128,
heap doubling past it) and the strip buffer is sized to the longest
`&`-bearing line. The only remaining cut is malloc failure, which
reports via `WIN32_UNSUPPORTED`. `DrawText`, `dt_push` in
`os/win32/gdi32.c`. Pinned by gdidemo selftest: `drawtext_200_lines`
(200 × tmHeight exactly) and `drawtext_long_amp_line_not_cut` (a
300-char `&`-line measures equal to its DT_NOPREFIX twin).

## Gap #35 — path_from_w truncated then operated on the wrong file

A path whose POSIX form exceeded 1023 bytes was silently cut to its
prefix, and every path API (CreateFile/DeleteFile/MoveFile/…) then
operated on that WRONG file and reported success. `path_from_w` now
returns success/failure (detection rides `WideCharToMultiByte`'s
insufficient-buffer return — no second conversion pass), and the new
`path_arg` wrapper sets `ERROR_FILENAME_EXCED_RANGE`; all 14 call sites
across CreateFileW…CreateProcessW refuse. `path_from_w`, `path_arg` in
`os/win32/kernel32.c`. Pinned by k32demo `test_longpath`: a >1023-byte
path refuses with the right last-error AND no truncated-prefix file
appears; a 1000-byte path still round-trips.

## Gap #36 — the registry hive line format was injectable

Value/key names passed `|` and newlines raw into the `|`-delimited
`$HOME/.win32reg` line format — the next load misparsed silently. The
`u%04x` non-ASCII escape collided with literal names spelled that way
("u00e9" the string vs U+00E9 the char became one record). And the
512/256-byte key/name snprintf truncations made distinct long keys
collide on their common prefix. Fix: one encoder, `hive_enc` in
`os/win32/advapi32.c`, used by both `key_path` and `name_u8`:

- `c >= 0x80`, `|`, `\n`, `\r` escape as `u%04x` (lowercase);
- a literal `u`/`U` followed by four hex chars (either case, so the
  registry's case-insensitive lookups stay honest) escapes as
  `u0075`/`u0055` — in encoded text every u+4-hex run IS an escape, so
  the map is injective up to case-insensitivity. Nothing decodes yet
  (no RegEnum); injectivity is what keeps distinct names distinct.
- over-cap keys/names return -1 and the APIs refuse with
  `ERROR_INVALID_PARAMETER`, plus a once-only stderr note (`cap_warn`) —
  loud, never a truncated collision. This also removed a latent
  one-byte stack overflow in the old `key_path` (`sb[o] = 0` could land
  at `sb[400]` when a `u%04x` escape straddled the guard).

Existing hives keep working: ASCII names without `|`/newline/u-hex runs
(winmine's "Difficulty", notepad's "lfFaceName", …) encode to
themselves, byte-identical to the old form.

Pinned by k32demo `test_registry` hostile block (in-process semantics:
`|`, newline, literal `u0041`, literal-`u00e9`-vs-U+00E9 distinctness,
over-cap refusal) and — the part that proves the FILE format — the
`reg-persist` second-boot leg re-reads all five hostile names from a
freshly parsed hive (`reg-persist: hostile=ok`, asserted by
`tests/kernel/test_kernel32_e2e.js` sessionB).

## Red control

With the four fix files stashed (tests kept): kernel32 e2e 6 harness
FAILs (10 in-demo checks red — 4 long-path, 4 wsprintf, 2 hostile) plus
`hostile=LOST` across the boot; gdi32 e2e 3 harness FAILs (both new
drawtext checks red). Restored: both suites fully green.

## Notes

- `tools/win32ports.js --check` green — the corpus (winmine/notepad/
  calc + the in-tree apps) compiles and links against the new
  signatures unchanged.
- No image.json bump here (master's, per lane contract); the veneer
  sources are bake inputs, so freshness gates re-bake on merge.
