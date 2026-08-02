# #417 + #418 — NetSurf, the demos, gameboy and sameboy leave the base image

One batch lane for both tickets (jku promoted the batch explicitly: the
edits are trivial, the gate is the cost — batched, it is paid once).

## What moved

- **#417 netsurf** → `packages/netsurf.json`: the binary plus its full
  resource closure as a `res/` tree (Messages, the four css files,
  welcome.html, mime.types, netsurf.png, favicon.png), the html/htm
  openwith claims, the Accessories menu entry, desktop eligibility.
- **#418 demos** → ONE `packages/demos.json` bundle: winbox, gpubox,
  gdidemo, ctldemo (+ its `.res` sidecar), fontramp, gdiplusdemo,
  k32demo. Menu entries for the five that had them.
- **#418 emulators** → `packages/gameboy.json` (Peanut-GB, 80 KB of wasm)
  and `packages/sameboy.json` (keeps the gb/gbc openwith claim).
- **doom stays baked** — jku's explicit instruction, pending the
  default-package mechanism.

## Decisions

- **Resource path, not a launcher.** NetSurf's respath is compile-time
  (`GUCOS_RESPATH` in `vendor/netsurf/gucos/bin.json` — our frontend, not
  upstream, so no patch-table entry): `/opt/netsurf/res/` (installed)
  then `/usr/opt/netsurf/res/` (fat fold) then `/usr/local/share/netsurf/`
  (admin override). The dead `/usr/share/netsurf/` entry is dropped
  outright — a search-path entry that can never exist again is a zombie.
  `${HOME}/.netsurf/` and `${NETSURFRES}` stay ahead of it all in main.c.
- **One demos bundle, not seven packages.** The demos are only meaningful
  as a set (acceptance apps; nobody installs just ctldemo), one card
  keeps the storefront readable, and one install restores the whole
  Demos menu. The counter-argument (per-app byte accounting) buys little
  at ~0.2 MiB gz per app. Surfaced in the lane report for jku to veto.
- **The rom-launcher Desktop scripts (pokemon/mario/drmario) and the
  optional rom seeds stay image.json user entries.** They are personal
  content tied to gitignored ROMs — not part of the sameboy closure —
  and the ROMs never shipped in a deploy, so prod behavior is unchanged.
  On a minimal boot with local ROMs they need `gucman install sameboy`.
- **Fat-image Desktop icons for netsurf/gameboy are gone** (the winmine
  precedent): a baked package's icon channel is install-time /
  desktop-defaults phase 2, never phase 3 (deskdefaults.c is explicit
  that icons are not phase 3's business).

## Measured (like-for-like plain-mkimage minimal bakes)

- baseline v221 (origin/main @23b937d0): **26,489,016 B**
- after (v222): **15,615,480 B**
- recovered: **10,873,536 B (−41.0%)**; Cloudflare headroom goes from
  **−274,616 B (OVER the 26,214,400 B cap)** to **+10,598,920 B**.
- 🔴 The baseline being over the cap means a v221 deploy would already
  be blocked — this batch is what unblocks it. (The ticket's cited
  deployed size was 25,372,288 B at v219; local v221 bakes 1.1 MB
  bigger. Growth since the v219 trim, not a measurement artifact of
  this lane — but worth a deploy-side confirmation.)
- Blob grep: zero matches for any moved app in the new minimal image;
  the only `sameboy` bytes are the three kept rom-launcher scripts
  riding the desktop-defaults rendering.

## Tests

- NEW `test_gucman_apps_e2e.js` (registered in the kernel member list):
  minimal-image absence sweep, all four installs, netsurf's welcome page
  (the respath acceptance — Messages/css/welcome.html/about:logo all out
  of `/opt/netsurf/res`) plus a real file:// page, winbox + ctldemo
  (`.res` sidecar through the /usr/local/bin symlink — a stale sidecar
  is a blank app, `wait label Greet` catches it), and both emulators
  loading a real minimal ROM (the build_test_rom cartridge — SameBoy's
  boot ROM verifies logo + checksum). Passed first run.
- `test_netsurf_content_e2e`: the Desktop-seed leg became a
  folded-package leg (readlink /usr/bin/netsurf + control.json desktop
  eligibility). `test_desktop_defaults_e2e`: the squat fixture moved
  from the departed gameboy icon to notepad. `os-shell.mjs`: the marquee
  sweeps drmario+fileman instead of fileman+gameboy.
- NB the netsurf suites still drive file:// only (#369) — nothing here
  adds fetcher coverage; test_netsurf_http_e2e's fat-image run is the
  http coverage, and the installed binary is byte-identical (one compile
  pipeline).
