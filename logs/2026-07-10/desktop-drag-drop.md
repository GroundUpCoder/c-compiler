# Drag-and-drop files onto the desktop (todos/0067)

Dropping a file from the host onto the running OS's desktop now writes it
to `/root/Desktop`, where `/bin/wm`'s icon grid picks it up within ~1s —
"get a file into the OS" goes from a bake-time-only operation to a live
gesture. Pairs with 0066: drop a `.gb` ROM or a `#!/bin/sh` launcher and
double-click it.

## Shape

Two small pieces, zero wm/kernel.js/host.js change:

- **`os/os.html`** — `dragover`/`drop` listeners on the `#desktop` pane
  (the whole VT2 surface is a target; `dragover.preventDefault()` is what
  makes the drop legal). Per dropped `File`: `arrayBuffer()` then
  `postMessage({type:'drop-file', name, bytes}, [bytes])` — the buffer is
  TRANSFERRED, zero-copy. A `.droptarget` inset ring on the pane is the
  hover affordance. The page stays a dumb bridge: no policy here.
- **`os/kernel-worker.js`** — the `drop-file` handler owns ALL policy and
  writes through the kernel's MountFS directly (`OS_COMMON.writeFile`) —
  no process, no fd-RPC round trip. The MountFS instance graduated from
  a `boot()` local to the worker global `kfs` for this (the `var` in
  boot() would otherwise shadow it — easy to miss). Pre-boot drops are
  covered by the existing `pending` queue: `tty` is set after `kfs`, so
  a replayed drop always finds the fs.

## Policy decisions

- **Never overwrite**: name collisions get a `-N` suffix before the
  extension (`foo.gb` → `foo-1.gb`), probed with `lstat` (not `stat` — a
  dangling symlink still owns its name). A drop must not be able to
  clobber the seeded launchers or the user's files; 99 tries then refuse.
- **Sanitized basename**: last path component only (both separators),
  control chars stripped; empty/`.`/`..` becomes `dropped`. Mode is plain
  0644 — 0066's ruling means content decides runnability, not X bits, so
  a dropped launcher needs no chmod.
- **Feedback on the status line, not the tty**: the item sketch said
  "echo a tty line", but kernel text injected into the tty byte stream
  garbles the hush prompt and is invisible from VT2 — where the drop
  actually happens. `boot-log` (`[drop] foo.gb -> /root/Desktop/foo.gb
  (N bytes)`) shows on the status line on BOTH VTs and lands in
  `__osLogs` for agents. Failures (cap, collisions exhausted, write
  error) report the same way.
- **Durability is explicit**: `fsync` through the mount after the write
  flushes the owning volume's `SyncAccessHandle` to OPFS — the
  acceptance's reload-survival leg is real, not incidental.
- **128 MiB sanity cap** — not a quota, just refusing the obviously
  absurd before a multi-second synchronous write.
- **`mkdir` self-heal**: a user who `rm -rf`ed `~/Desktop` gets it back
  on the next drop (EEXIST is the normal case and ignored).

No image bump: nothing baked changed (os.html and kernel-worker.js are
served, not in the blob); wm.c untouched — its existing coarse
`desk_load` re-read is the whole notify story.

## Testing

New `tests/browser/os-drop.mjs` (manual sweep tier), driving the REAL
DataTransfer path with synthetic `DragEvent`s in page context: highlight
class round-trip; a 256-byte all-values binary payload md5-verified
in-OS (busybox `md5sum`); the icon appearing without a reboot (5th grid
cell — `blob.bin` sorts first, so cell 4 filling in is the signal);
collision → `blob-1.bin`; a dropped `#!/bin/sh` launcher double-click
spawning winbox (0066's activate, end to end); page close → reopen in
the SAME context (same OPFS; the 0045 lock frees on close) → both blobs
still md5-identical. PASS first run; os-boots / os-shell / os-wm re-run
serially — PASS (os.html + kernel-worker.js were touched). Kernel/unit
suites not re-run: compiler.js, host.js, kernel.js, wm.c all untouched.

Headless `boot.js` is unaffected by design — the message type exists
only in the browser worker's page protocol.
