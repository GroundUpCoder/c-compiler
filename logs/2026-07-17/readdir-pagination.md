# FS_OPENDIR pagination (todos/0241, arch CS2)

## The bug

`FS_OPENDIR` read the ENTIRE directory kernel-side and shipped it as one
JSON payload; `_respond` silently degrades anything over `KP_PAYLOAD_CAP`
(65440 bytes) to `{errno:'ENOMEM'}`. Entry JSON runs 35–60 bytes, so a
directory past ~1200–1800 entries made `ls`/`find`/fileman fail outright
on every brokered volume — a correctness cliff that user data was always
going to walk off. Measured red state: a 3000-entry dir is a 166KB
one-shot payload → `{"errno":"ENOMEM"}` on the unpatched kernel
(`tests/kernel/test_readdir_page.js` captured it failing before the fix).

One surprise vs the arch-scan notes: the client (`RemoteFS`) lives in
**kernel.js**, not host.js — host.js only wires it. The whole fix is
kernel.js + tests; host.js untouched, no image bake (JS runtime only).

## The design: cursor in request, `more` in reply, handle parked kernel-side

Chose a NEW op (`FS_READDIR 0x0421`) over overloading `FS_OPENDIR` with a
cursor argument:

- `FS_OPENDIR` keeps its one-shot shape (path in → first page out), and a
  small-dir reply is byte-identical to before (no `more` key) — zero
  regression surface for the common case.
- The continuation is semantically a different thing: it operates on
  KERNEL-HELD state (a parked dir handle), not on a path. A polymorphic
  request ("path XOR cursor") would smear that distinction, and strace
  decode is clearer as two ops (`FS_OPENDIR(path=/big)` then
  `FS_READDIR(dir=1)` lines).
- 0x0421 because `FS_WAIT` (0178) already took 0x0420.

Mechanics: `_readdirPage` accumulates entries while the MEASURED bytes
(UTF-8 of each entry's JSON + the array comma) stay under `KP_DIR_PAGE =
KP_PAYLOAD_CAP - 64` (a 0235-style derived constant; the 64 reserves the
`{"entries":[…],"more":N}` envelope — measured, not estimated, because
names are UTF-8 and JSON-escaped). When the next entry would overflow, the
open backend handle parks in `pcb.dirRpc` keyed by a per-process cursor
id, with the overflow entry carried as `pending` so nothing is re-read or
lost. The final page closes the handle and omits `more`. Client side,
`RemoteFS._opendirBrokered` drains `while (r.more !== undefined)` and then
snapshots — `readdir`/`closedir`/pos semantics unchanged for every caller.

Handle lifecycle (no leak by construction): released on exhaustion (the
only path the client loop takes), on a bad-cursor EBADF the cursor never
existed, and at `_exitProcess` for a client that dies mid-drain — the same
discipline as fds ("the kernel, not the dead worker, owns the
descriptions"). The `entries.length > 0` guard in the overflow check keeps
forward progress even for a hypothetical single entry over budget (can't
happen at NAME_MAX scale, but a wedge is worse than one oversize attempt).

## Why pagination at the RPC layer covers every backend

BlockFS, ProcFS, and MountFS (routing) all hold STATEFUL dir handles that
survive across calls — BlockFS snapshots the extent scan on the handle
(the documented O(N²) guard), ProcFS snapshots at opendir, MountFS routes
`{vol, h}` pairs. So parking `dh` across RPCs needed zero backend change,
and all three list fully through the new path (asserted in the test). The
RO-/usr fast path (0180) serves opendir process-locally with no RPC at
all — unaffected; its brokered fallback (escapes, relative paths) gets
pagination like everything else.

POSIX note: entries added/removed between pages are unspecified-behavior
territory (POSIX says so for any readdir concurrent with mutation), and
each backend's per-handle snapshot means a paginated listing is exactly as
consistent as a one-shot listing was.

## Test + gate

`tests/kernel/test_readdir_page.js` (registered in the kernel suite):
3000-entry dir (asserts it really exceeds one payload) lists fully and IN
ORDER over both the raw RPC protocol and the real RemoteFS drain loop;
multiple pages observed; small dirs stay single-page/no-cursor; ProcFS
through the same path; stale cursor → EBADF; backend `_dirTable` handle
counts back to baseline after exhaustion AND after a process dies holding
a parked cursor.

Gate (all foreground): unit 757/0 (8 xfail preserved), host 2.3s green,
blockfs 15/0, kernel 76/0, browser sweep 27/27. No image.json bump —
kernel.js is runtime JS, not baked content.
