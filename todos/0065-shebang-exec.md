# 0065 — shebang (`#!`) exec support

- **Status**: open
- **Depends**: none
- **Design**: `KERNEL.md` (spawn/exec path)

## Goal

Make the kernel honour a `#!` interpreter line so a text file starting
with `#!/bin/sh` is executable directly (`./foo`, or double-clicked from
the desktop), not just via `sh foo`. This is the enabling primitive for
`0066`'s unified run mechanism — a desktop launcher is then just a normal
executable shell script:

```sh
#!/bin/sh
exec /bin/gameboy /root/roms/DrMario.gb
```

## Background

Today the spawn path (`kernel.js` `_spawnBytes`, ~L1178) reads the file
bytes and hands them straight to `WebAssembly.compile()`. There is no
magic-number inspection: a WASM binary works, anything else crashes the
child with a `CompileError`. Neither the kernel nor busybox's exec path
(`vendor/busybox/port/vfork_spawn.c` `pv_execve`/`pv_execvp`) looks for
`#!`.

## Plan

- In `_spawnBytes`, after the image loads and **before** the WASM compile
  attempt, peek the first two bytes. If they are `#!` (0x23 0x21), parse
  the interpreter line (up to newline): interpreter path + one optional
  arg, POSIX-style.
- Re-dispatch `_spawn` with the interpreter as `path` and
  `[interp, optarg?, scriptPath, ...origArgv[1:]]` as argv (argv[0]
  convention: the script path, per Unix).
- Add a small nesting-depth cap (e.g. 4) so a script→script→… chain can't
  loop the kernel forever; exceed it → `ENOEXEC`/`ELOOP`.
- Leave the WASM magic path untouched: non-`#!` bytes still go to
  `WebAssembly.compile()` exactly as now.

## Acceptance

- A file `/root/foo` = `#!/bin/sh\necho hi\n`, made executable, run as
  `/root/foo` (no explicit `sh`) prints `hi`.
- `#!/bin/sh -e` style single-arg interpreter lines pass the arg through.
- A shebang cycle terminates with an error instead of hanging.
- Existing WASM binaries and `sh script.sh` keep working; browser pixel
  tests stay green.
