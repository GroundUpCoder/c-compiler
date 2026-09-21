# 0249 — Deploy caching: content-hash + immutable headers, deterministic mkimage mtimes

- **Status**: done (was QUEUED as a non-blocking improvement — the user chose ship-as-is over blocking on this; it was never a deploy blocker)
- **Design**: full scope in the meta workspace: `~/git/meta/notes/deploy-caching-fix-scope.md`

## Goal

Stop version bumps from forcing a full ~19.5 MB image re-download on the first
boot after every deploy. Origin: the v110 "perf incident" (2026-07-17) was NOT a
code regression — a genuine-fable A/B (v104 vs v110) showed every metric in
noise, desktop pixel-identical. The user-visible slowness was a **one-time cold
boot**: the system image is served UNCACHED (Cloudflare DYNAMIC / must-revalidate)
and every version bump orphans the OPFS copy (`os/kernel-worker.js:335`, the 0026
precedent), so the whole image re-downloads once (~10.9 s desktop, ~20–60 s
mobile) then self-heals. Rollback would RE-orphan and hurt.

## Plan

Two interdependent parts (do the determinism first — hashing is only stable once
the image bytes are deterministic):

1. **(c-compiler) Deterministic mkimage.** `tools/mkimage.js:~86-89` stamps the
   published blob's in-image mtime from `new Date()` (bake START time, todos/0082),
   so two bakes of an identical tree produce different bytes → different hash.
   Stamp the mtime from the **manifest version** (or a fixed epoch) instead, so an
   unchanged tree bakes byte-identical (hash-stable). Revisit/supersede the
   0082 bake-time-mtime design. Gate: bake still verifies (seal intact + version
   reads back); a test that bakes the same tree twice and asserts byte-identical
   output.
2. **(comguc + c-compiler boot path) Content-hashed image name + immutable cache.**
   Publish the image as `os-system.<contenthash>.img` with
   `Cache-Control: public, max-age=31536000, immutable` (replacing the current
   DYNAMIC/must-revalidate). The boot path currently fetches the FIXED name
   `os-system.img` (`os/kernel-worker.js:335`) — so the manifest must carry the
   hashed image URL and kernel-worker must fetch THAT (keep a fallback for the
   no-prebaked-blob in-worker dev bake path). Net effect: a new deploy re-downloads
   the image only when its bytes actually changed; a no-change redeploy reuses the
   cached blob.

Optional longer-term (separate items if pursued): (3) block-level delta fetch —
fetch only changed blocks between old/new image; (4) boot-screen download-% so a
one-time cold boot after a deploy doesn't LOOK hung (the mobile 20–60 s case).

## Acceptance

- Two bakes of an identical source tree produce a byte-identical (same-hash)
  `os-system.img` (determinism test green).
- A deploy of an UNCHANGED tree does not change the published image hash → no
  client re-download.
- A deploy that DOES change the image serves it under a new content-hashed URL
  with `immutable` long-max-age headers; the boot path fetches the hashed URL
  from the manifest; a version bump no longer forces a full uncached re-download
  of an unchanged image.
- `pnpm verify` (comguc) still 12/12; boot path still materializes/upgrades the
  image correctly (kernel-worker version-swap leg green).
