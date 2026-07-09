# serve.js: auto-bake a stale os-system.img before listening

**Problem.** The 0040 fast-boot path (browser fetches the prebaked
`os/os-system.img` instead of compiling the world in-worker) has a silent
failure mode: the blob is gitignored and rebaking after an `image.json`
version bump is a manual `node tools/mkimage.js` step. Miss it and the
kernel worker's version check rejects the served blob and quietly falls
through to the full ~16s in-worker bake — which reads as "first load
recompiles everything" even though the mechanism landed days ago. That is
exactly what happened in manual testing: the image version was bumped
several times (0043, 0044, …) and any boot in a bump→rebake window paid
the full bake with only a boot-log line to tell.

**Fix.** `serve.js` now runs `ensureSystemImage()` before listening: when
the served root looks like the OS tree (`os/image.json` +
`tools/mkimage.js` present), it compares the manifest version against the
blob's baked `VERSION_ID` (same `os-common.bakedVersion` the kernel worker
uses, over a `NodeFileStore`) and, if the blob is missing or older, runs
`tools/mkimage.js` synchronously first. Decisions:

- **Same staleness rule as kernel-worker.js**: rebake only when
  `baked < manifest`; a newer blob is kept (the upgrade/rollback
  contract — "a NEWER blob than the manifest is kept").
- **Bake before listen**, not concurrently: mkimage writes the image in
  place, so serving during a bake could hand a booting page a half-written
  blob (whose version check would fail → in-worker bake, the exact thing
  being fixed).
- **Hard failure**: mkimage failing kills the server rather than serving a
  stale blob. The in-worker bake runs the same pipeline, so it would fail
  the same way — a quiet fallback here is a zombie path.
- Non-OS trees (`node serve.js build`, single-file mode) are untouched —
  the check keys off the OS-tree files existing under the served root.

Side benefit: every `tests/browser/os-*.mjs` spawns `serve.js ROOT`, so
the suite now always boots against a current blob instead of each run
silently in-worker-baking after a version bump.

Verified: fresh blob → instant listen, no bake; deleted blob → bake runs
first (`missing < manifest v33 — baking…`), then the served image is the
full 4.8 MB and reads back v33/sealed.

Also confirmed while here: **no disk image is version-controlled** — all
four (`os.img`, `os-system.img`, `os-user.img`, `os-root.img`) are
gitignored and none has ever been tracked. Related: todos/done/0040,
todos/DISK-IMAGE.md.
