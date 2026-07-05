# 0004 — os/ reference page + C protoshell (pid 1)

- **Status**: queued
- **Depends**: 0001 (usable already; better after 0002)
- **Design**: `todos/OS.md` (Reference build: os/ in this repo)

## Goal

The OS boots in a browser tab from this repo: `os/os.html` (thin UI bridge:
xterm + kernel worker), first-boot BlockFS seeding from a manifest, and a
~200-line C protoshell as pid 1 (read line → spawn → wait; Ctrl-C
forwarding once 0002 lands). Doubles as the live harness for kernel phases.

## Plan sketch

- `os/os.html` + minimal bridge script; kernel worker imports kernel.js +
  host.js (BlockFS over OPFS) + compiler.js (backs /bin/cc via the existing
  __compile hook); browser createWorker factory lands here (the Node one is
  already the tested reference).
- `os/image.json` manifest: path → fetch URL of built wasm; first boot
  formats, mkdirs /bin /dev /etc /root, seeds binaries + device nodes.
- `os/protoshell.c`: prompt, tokenize, posix_spawnp, waitpid, `cd`, `exit`
  builtins; run `cc hello.c && ./a.out` end to end.

## Acceptance

- `node serve.js .` → open the page → land in the protoshell over a
  persistent BlockFS; spawn programs; reboot the tab and files persist.
