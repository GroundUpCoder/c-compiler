# gucOS developer documentation

This directory tells you how to develop software inside gucOS. You do not
need access to the host repository. Everything here describes what works
in this image today.

`/usr/doc` and `/usr/share/doc` are the same directory. `/usr/doc` is a
symlink.

## The chapters

| File | Contents |
|---|---|
| `toolchain.md` | The C compiler: flags, headers, libraries, diagnostics |
| `packages.md` | gucman, package anatomy, sources packages, rebuilds |
| `git.md` | The in-OS git: commands, network, credentials |
| `publish.md` | How to publish a package from inside gucOS |
| `gcode.md` | gcode, the in-OS coding agent |
| `debugging.md` | strace, exit codes, /proc, wmctl |
| `sdl-gucos.md` | SDL3 on gucOS: main loops and the software renderer |

## What gucOS is

gucOS is an almost-POSIX operating system. Every program is a WebAssembly
module. The in-OS C compiler, `cc`, builds all of them. The shell is
`/bin/sh` (busybox hush). There is no `fork()`; programs spawn with
`posix_spawn`. There is no `make` and there are no object files.

## Where you can write

- `/root` is your home directory. Work here.
- `/usr/local` is writable. Installed commands go to `/usr/local/bin`.
- `/usr` is read-only. A write there fails with `EROFS`.
- `/tmp` is writable scratch space.

## Your first program

1. Write a source file:

   ```sh
   cat > /root/hello.c <<'EOF'
   #include <stdio.h>
   int main(void) { printf("hello, gucOS\n"); return 0; }
   EOF
   ```

2. Compile and run it:

   ```sh
   cd /root
   cc hello.c -o hello
   ./hello
   ```

One `cc` command compiles and links the whole program. Read
`toolchain.md` for the full compiler surface.

## How to read these documents

Use `cat`, `less`, or `vi` on any file here. The gcode agent can read
them with its `read_file` tool. Start with `toolchain.md`, then
`packages.md`.
