# #548 — the published doom-clang "SEGV" is a LinkError: platform ABI drift, not a payload bug

## Repro (headless, this tree @52a27e1f + #549 commit)

```
echo 'doom-clang > /root/dc.log 2>&1; echo DC-EXIT=$?; cat /root/dc.log' \
  | node os/boot.js --overlay=clang-apps
```

```
[kernel] pid 4 crashed: LinkError: WebAssembly.Instance(): Import #16 "c"
"__sdl_audio_callback_unsupported": function import requires a callable
SEGV
DC-EXIT=139
```

Exit 139 matches the ticket's recorded signature exactly — but it is **not a
segfault**. The wasm module fails **instantiation**: it imports a host symbol
the current env no longer provides. The crash path reports the dead process
as SEGV/139; the real cause is printed only on the KERNEL console (boot
stderr / browser devtools console), and `/root/dc.log` is empty — from
inside the OS a LinkError is indistinguishable from a real SEGV (diagnostic
gap, reported below, not absorbed).

## Bisect — the payload did not regress and was not never-green; the ABI moved

No binary search needed; provenance + git history close the timeline:

- The artifact (`~/git/clang-simplified/out-image/`, repo clean @a1a2a6b)
  vendors libc from c-compiler **c683322 (2026-07-28)**. At that commit the
  SDL veneer's audio path referenced a host import
  `__sdl_audio_callback_unsupported`, and host.js provided it.
- **af9fa850 (#491, 2026-08-04, shipped v237) retired the import**: the
  pull-mode-callback rejection moved C-side into __SDL.c (NULL +
  SDL_SetError per SDL3's contract), and the host stopped supplying the
  symbol. host.js:7023's comment records the retirement.
- Any wasm built against the older libc that still imports the symbol now
  fails instantiation. Built Jul 28 → ABI moved Aug 4 → first observed
  broken Aug 6. The artifact ran green when published.

Affected binaries, checked across all 11 wasm files in the artifact:
**doom-clang.wasm and gameboy-clang.wasm** (the two audio apps) import the
retired symbol; the other nine do not — which is exactly why sdldemo still
renders green in os-clang.mjs while doom-clang dies.

Artifact identity recorded before any of this (nothing was rebuilt):
- `doom-clang/doom-clang.wasm` — 439070 bytes, mtime Jul 28 08:41, sha256
  `82e264583d80c0534faad9d5ec3d29bfa404373c48aec5d0cb78380382092486`
- `doom-clang/DOOM1.WAD` — 4196020 bytes, mtime Jul 30 15:41
- overlay.json builtAtUtc 2026-07-30T06:49:46Z, repo a1a2a6b (clean),
  libc vendoredFromCommit c683322

## Why this lane did NOT rebuild the artifact

The fix requires re-vendoring `clang-simplified/wasm/libc/` from current
c-compiler (`extract-libc.js`; the vendoring invariant is committed ==
regen, enforced by `check-libc-vendor.sh`) and then re-running
`mk-overlay.mjs`. `wasm/libc/` is COMMITTED in clang-simplified, so a
correct rebuild is inseparable from a commit in the second repo — a
decision the kickoff explicitly reserves for the coordinator. Rebuilding
"dirty" (working-tree-only re-vendor) would publish an artifact whose
provenance lies about its libc and leave a shared repo dirty for every
sibling worktree. Reported back instead.

Consequently, per the ticket's own ordering: the os-clang.mjs doom-clang
leg is NOT promoted to a render assert (promoting against a broken artifact
would turn the gate permanently red). The info line stays; the header
comment now states the measured cause instead of speculating. The
skip-at-exit-0 path (os-clang.mjs:41-47, fake-green class) also stays — it
is part of the promotion work and rides the same rebuild.

## Reported gaps for the coordinator (surfaced, not absorbed)

1. **The rebuild itself** (second repo): re-vendor wasm/libc from current
   c-compiler, rebuild the overlay, verify doom-clang + gameboy-clang run,
   republish. Until then the shipped-flagship clang twin stays broken, and
   any OTHER pre-#491 audio-app wasm out there breaks identically.
2. **LinkError masquerades as SEGV inside the OS**: a wasm that fails
   instantiation exits 139 with nothing in the app's own stderr; the
   LinkError text reaches only the kernel console. An exec-shaped failure
   (closer to ENOEXEC/126 than to a signal, or at minimum the LinkError text
   routed to the process's stderr) would have named this bug on day one.
   Kernel-side change with test surface — needs its own ticket.
3. **os-clang.mjs promotion** (blocked on 1): assert DC-EXIT=0 plus a
   render signal reusing the existing `region()` sampler, and convert the
   artifact-absent SKIP into something the record distinguishes from a pass.
