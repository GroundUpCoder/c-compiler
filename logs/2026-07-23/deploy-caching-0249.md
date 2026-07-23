# 0249 — deterministic bake + content-hashed immutable image (c-compiler half)

Todo: `todos/0249-deploy-caching-immutable.md`. Design:
`~/git/meta/notes/deploy-caching-fix-scope.md`. The comguc half (publish the
blob under `os-system.<sha16>.img` with `immutable` headers, keep the fixed
name as the compat fallback) lands separately in the deploy repo.

## Why

Every version bump forces a one-time full ~19.5 MB image re-download (the
image is served must-revalidate, and the OPFS copy is orphaned by design).
Content-hashing the published name + `immutable` headers fixes that — but
only once the bake is byte-deterministic, and it wasn't: two bakes of an
identical tree hashed differently.

## Where the non-determinism actually was

The design doc pointed at `tools/mkimage.js`'s `bakeStart` mtime stamp — but
that only sets the output FILE's mtime (the 0082 freshness-gate signal),
which never enters the sealed content bytes. The real leak was
`BlockFS.prototype._now()`: every inode a/m/c/btime stamped from `Date.now()`
across ~25 create/write/link sites during the bake. Confirmed empirically:
after fixing only the clock, two full-manifest bakes came out byte-identical
(sha256 `5329719c…`, ~44 s each) — timestamps were the ONLY source of
variation (consistent with the 0269 finding that `buildProject` is pure).

## The fix

- `host.js`: `createV4(store, opts)` grew `opts.clock` — a `() -> ms` source
  threaded through the BlockFS **constructor** (not attached after: the
  constructor's `_createRootDir` already stamps times) and honored by
  `_now()`. Default path unchanged — live volumes keep the wall clock.
- `os/os-common.js` `bakeSystemImage`: passes a fixed clock derived from the
  manifest version — `Date.UTC(2026,0,1) + version*1000` — to the sealed
  volume AND the throwaway tmpRoot (one clock for the whole bake namespace).
  Version-derived over a bare constant so unchanged tree → unchanged bytes,
  while a higher version always stamps later than a lower one (an upgraded
  /usr never *looks* older), and `ls -l` shows an obviously synthetic 2026
  stamp rather than 1970. This covers ALL bakers (mkimage, boot.js, the
  in-worker dev bake) since they share `bakeSystemImage`.
- `os/kernel-worker.js`: the prebaked-blob fetch is now
  `fetch(manifest.image || 'os-system.img')`. The repo's `image.json` never
  carries `image`, so every dev/test path (serve.js + its overlay swap,
  boot.js, fixtures) keeps the fixed name; only a transformed DEPLOY
  manifest opts into the hashed URL.
- New `tests/serve/test_image_determinism.js` (host suite): drives the real
  `tools/mkimage.js` twice over a tiny manifest exercising every timestamped
  seed path (mkdir / inline content / cc-compiled binary / symlink), asserts
  byte-identical outputs + seal + version read-back. Red-checked: with the
  clock injection reverted it fails on the hash compare. Kept tiny (~8 s)
  instead of 2× full bakes (~88 s) — full-manifest determinism was verified
  manually above, and the mechanism under guard is the clock plumbing.

## Deliberately unchanged

- `newestBakeInput` / the blob FILE mtime (`bakeStart`) — that's the 0082
  dev freshness gate, orthogonal to in-image inode times.
- **No image version bump**: in-image timestamps on a read-only /usr are
  cosmetic; bumping would force the very re-materialize this item exists to
  avoid.
