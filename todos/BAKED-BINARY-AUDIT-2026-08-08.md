# Baked-binary audit — which base-image binaries can become gucman packages? (#581)

2026-08-08, lane-581audit. Answers jku's question: *"gcode is the most obvious one to me
right now, but could other binaries also be cut out?"* No code changes; this document is
the ticket's whole deliverable. The classification test, per the ticket: **is it on the
boot path, or required by the desktop before a network is available?** — not "is it an
app".

## 1. Method and the derived count

**The manifest seam is `os/image.json` → `system.files`** (the kickoff's note that
`system`/`user` expose only `dirs` was wrong — each also has a `files` map; 171 system
entries). `os-common.js seedEntries` (`os-common.js:320`) materializes them at bake time;
`tools/mkimage.js` never enumerates binaries itself, it drives seedEntries. Kinds
observed: `project` (19), `c` (10), `bin` (40), `content` (14), `link` (88).

Derived baked set, from the manifest at `d59d4449` (post-#578, gcode already out):

- **`/usr/bin` has 112 entries**: 18 `project` builds + 10 `c` units + 82 links
  (81 → `/usr/bin/coreutils`, 1 `python` → `/usr/bin/cmdalt`) + 2 `.res` data sidecars
  (`calc.res`, `notepad.res`).
- Plus **`/usr/lib/ksvc.wasm`** (`project`), the kernel text service.
- ⇒ **29 distinct baked wasm modules** (19 project + 10 c). **The "~113" figure checks
  out as the `/usr/bin` entry count (112, or 113 with ksvc)** — but 84 of those entries
  are links/sidecars carrying ~0 bytes; the unit of unbaking is the 29 modules.

**Sizes** were read from the prebaked `os/os-system.img` in the main clone, mounted
read-only via `host.js BLOCK_FS.createV4({readonly:true})` (a pure file read — no bake, no
boot, no kernel, no heavy lock). ⚠️ Provenance caveat: that image is a **v241 FAT bake**
(`/usr/share/os-release` VERSION_ID=241, PACKAGES=25 folded, mtime Aug 6) while the
manifest is at 244, so per-binary sizes are indicative, not v244-exact (base binaries
drift slowly; gcode still appears baked in it at 179,325 B).

Image totals from that mount: **132.2 MB fat = 115.6 MB `/opt` (folded packages) +
~16.6 MB base**. The base decomposes as ≈ 9.10 MB `/bin` executables (+ ksvc 0.37 MB) +
6.10 MB fonts + 0.22 MB sounds + 0.21 MB `/usr/include` (#439) + ~0.09 MB share data
(mgp masters 53 KB, deck data 38 KB). **Binaries are ~57% of the base image; the six
biggest unbake-candidates below are ~28% of it.**

## 2. Per-binary table

Class: **boot** = boot-path · **desk** = desktop-required · **dev** = developer-tool ·
**opt** = optional-app. Verdict: **keep** / **unbake** / **needs-investigation** (n-i).
Sizes in bytes from the v241 image.

### Boot-path — immovable

| binary | size | class | verdict | evidence |
|---|---|---|---|---|
| sh (busybox hush) | 250,933 | boot | keep | pid 1 (`boot.js:587`, `kernel-worker.js:909`); `gcode.c:523 posix_spawn("/bin/sh")`; wm Run… dialog (`wm.c:1777`); every menu seed is `#!/bin/sh` |
| wm | 504,519 | boot | keep | kernel service autostart (`boot.js:594`, `kernel-worker.js:915`) |
| gucman | 153,998 | boot | keep | boot service `gucman sync-defaults` (`boot.js:604`, `kernel-worker.js:922`); spawned by software (`software.c:593`). The installer cannot be install-on-demand |
| coreutils | 492,394 | boot | keep | 81 `/usr/bin` links; hush's whole userland; `vi` (= applet link) is the baked `default.term` openwith handler |
| ksvc.wasm | 367,381 | boot | keep | kernel-thread text service, loaded sync at boot; load-fail is a loud boot-error (todos/0275, no fallback) |

### Desktop-required — spawned by absolute path or the default handler

| binary | size | class | verdict | evidence |
|---|---|---|---|---|
| fileman | 619,244 | desk | keep | `wm.c:1441 spawn_path("/bin/fileman")` — every folder open + Recycle Bin (`activate()` dir policy, todos/0185) |
| ctlpanel | 631,955 | desk | keep | `wm.c:2069 activate("/bin/ctlpanel")` (Settings), `wm.c:3325` (Display), `wm.c:3383` |
| software | 607,248 | desk | keep | the package storefront (#81) — unbaking the install-on-demand UI defeats install-on-demand; spawns `/bin/gucman` (`software.c:593`) |
| desktop-defaults | 43,751 | desk | keep | `wm.c:3331 spawn_path("/usr/bin/desktop-defaults")` (icon-menu row); re-applies package `desktop` control entries (`os-common.js:1531`) — part of the package machinery itself |
| term | 464,366 | desk | keep | the only GUI terminal: Accessories menu + Desktop link; the `term <ttyapp>` wrap convention (openwith seed comment); `Games/snake` seed is `term snake`; self-spawn `term.c:1134`; spawns `/bin/sh` (`term.c:2249`). Ticket flagged it "plausibly load-bearing" — confirmed |
| notepad (+.res) | 669,472 + 3,315 | desk | keep (next wave) | **baked `default.gui` openwith handler** (`/usr/share/openwith` seed) — the GUI open/edit fallback for every unknown file type and wm's icon-menu Edit (`ow_editor`). Unbake works mechanically (winmine precedent covers `.res`) but an offline first boot loses the default GUI editor — jku call, not a lane call |
| cmdalt | 29,594 | desk | keep | `/usr/bin/python` dispatch link target (todos/0338); a fresh boot's `python` must exit 127 naming `gucman install cpython-clang` — that behavior IS this binary |

### Developer tools + plumbing — all tiny; keep

| binary | size | class | verdict | evidence |
|---|---|---|---|---|
| cc | 12,405 | dev | keep | THE PKGDEV-epic tool (in-OS development); `/root/hello.c` user seed presumes it on a fresh boot; 12 KB |
| wmctl | 42,993 | dev | keep | the agent-driving surface for users and the whole test estate (CLAUDE.md); 43 KB |
| strace | 14,829 | dev | keep | kernel tracing UX (todos/0046); 15 KB |
| curl | 26,238 | dev | keep | net debugging CLI (todos/0182); 26 KB |
| open | 21,485 | desk | keep | openwith CLI incl. `open --set` (the association-editing verb); 21 KB |
| clip / pbcopy / pbpaste | 21,149 / 20,631 / 19,809 | desk | keep | shell clipboard bridge (todos/0090) + host-clipboard bridge (#79/#96); test probes; ~20 KB each |
| file-gucos-ticket | 24,334 | dev | keep | ticket-bridge client (#451) — in-OS ticket filing is epic-adjacent; only consumers are its e2e + the run.js registry; 24 KB |
| psh | 22,165 | dev | keep, **flag** | **zero consumers**: the only reference anywhere in os/, tests/, tools/ is its own `image.json` entry (grep positive-controlled against `/bin/snake`). Candidate for deletion rather than packaging; 22 KB either way |

### Optional apps — the actual candidates

| binary | size | class | verdict | evidence |
|---|---|---|---|---|
| **calc (+.res)** | 654,214 + 9,632 | opt | **unbake** | only references: Accessories menu link + Desktop link (both `image.json`); **no absolute-path consumer in os/ or tests** (grep over `bin/calc`); winmine package precedent covers `.res`-in-payload + `bin`/`desktop`/`menu` keys |
| **paint** | 602,864 | opt | **unbake** | references: Accessories menu link, Desktop link, openwith `bmp` seed. Package `openwith` claims are proven (netsurf claims html/htm). Tests that spawn it (`os-paint.mjs`, `os-touch.mjs`, `test_openwith_e2e.js`) ride the fat-image fold per the #578 precedent; `test_openwith_e2e` additionally asserts the baked seed line and is the one test the unbake lane must update |
| snake | 16,917 | opt | n-i | the menu seed is the two-word script `term snake`, but gucman menu entries are **symlinks to the package's own bin claim only** (`gucman.c:1183-1212` — `cmd` must be a `bin` key, entry = symlink). Needs a wrapper-script-as-bin-claim pattern (unproven in any package). 17 KB — not worth pioneering a pattern for |
| filepick | 583,481 | desk (netsurf-only) | n-i | sole consumer is the netsurf **package** (`vendor/netsurf/gucos/gui.c:316 #define FILEPICK_BIN "/bin/filepick"` — absolute). gucman HAS depth-first `deps[]` installs (gucman.c header), so `netsurf deps:["filepick"]` is expressible — but a runtime install lands `/usr/local/bin/filepick`, so the absolute `/bin` spawn dangles; needs a netsurf patch (PATH spawn or `/usr/local` path) + package rebuild first |
| mgp | 839,778 | opt | keep **by ruling** | **ticket #80 (done): jku explicitly moved mgp from a package back into the base image.** Recommending re-unbake would re-litigate a user decision. Data coupling: `/usr/share/mgp` masters (53 KB) + Desktop Presentations user seeds + openwith `mgp` seed |
| mgpp | 840,015 | opt | keep **by ruling** | MagicPointPlus, a `-DMGPP` fork sharing every source with mgp (`vendor/magicpoint/mgpp.json`); rides the #80 ruling. mgp+mgpp together are the single largest reclaim (1.68 MB) if jku ever re-rules |
| deck | 675,907 | opt | **excluded — FLAG** | see §5. The ticket's standing rule says deck must never enter the published image; **it is baked and published today** (project entry, `/usr/share/deck` data, Demos menu, Desktop seed; comguc `build.mjs:208-212` ships the demo assets deliberately, citing todos/0284) |
| gcode | (179,325 in v241) | — | already done | #578 (`d59d4449`): package + defaultPackages member |

Source companions: every unbaked source-bearing unit gets its `<name>-sources` companion
automatically (`os-common.js sourcePackageDefs`, #407) — synthesized in memory, never a
baked byte. Accounted for; no work to file.

## 3. Ranking — (bytes reclaimed from the base image) × (confidence it is safe)

| rank | unit | reclaim | confidence | note |
|---|---|---|---|---|
| 1 | **calc + calc.res** | 663,846 | **high** | zero couplings beyond menu/Desktop links; winmine is the exact precedent |
| 2 | **paint** | 602,864 | **high** | one openwith claim + one test-seed assert to move |
| 3 | filepick | 583,481 | medium | needs the netsurf `FILEPICK_BIN` patch + `deps` wiring first |
| 4 | notepad + .res | 672,787 | medium-low | mechanically fine; policy question (offline default.gui) |
| 5 | mgp + mgpp (+ share data) | 1,732,391 | blocked | jku ruling #80 — largest prize, needs a re-rule, not a lane |
| 6 | deck (+ share data) | 713,689 | blocked | standing-rule conflict (§5) — a jku ruling either way |
| 7 | snake | 16,917 | low value | pattern gap; trivial bytes |

## 4. Recommended unbake batch — deliberately conservative

**Batch: `calc` and `paint`.** Two new package defs (the `packages/gcode.json` shape:
`files` → `vendor/calc/bin.json` + `calc.res` / `os/win32/paint.json`; `bin`, `desktop`,
`menu` keys; paint adds `openwith: {bmp: paint}`), the `image.json` project + menu-link +
user-Desktop-link entries removed, and — per the #578/#420 status-quo precedent — both
added to `defaultPackages`. Reclaim ≈ **1.27 MB of the ~16.6 MB base (~7.6%, ~14% of the
binary payload)**. Per batching rule 3a they carry distinct instruments (different package
defs, different tests: os-user32-adjacent legs vs os-paint.mjs/test_openwith_e2e).

Left out, and why:

- **notepad** — it is the baked `default.gui` handler; removing it changes offline
  first-boot behavior (no GUI editor until install). That is a product call for jku, not
  an audit call. If jku accepts "default packages cover it", notepad is the next unbake.
- **filepick** — safe only after a netsurf source patch (absolute `/bin/filepick` spawn)
  and a `deps:["filepick"]` edge; sequencing it into this batch couples the batch to a
  vendored-code change.
- **snake** — needs a wrapper-script menu pattern gucman can't express today; 17 KB.
- **mgp/mgpp** — blocked by jku's own #80 ruling; surface, don't recommend.
- **deck** — excluded by the standing rule; flagged below instead.
- **Everything else** — boot-path, desktop-required, or ≤43 KB plumbing where the
  packaging overhead exceeds the reclaim.

Note the honest trade-off of the defaultPackages pattern: the **base image** shrinks
(every gate rebake and every user download of the blob), and the units gain their own
release cadence (the PKGDEV goal, jku's "base image update should not necessarily trigger
package updates and vice versa") — but a networked first boot still downloads the bytes
as packages. The reclaim is in image weight and release coupling, not in total first-boot
traffic. (For reference, winmine's payload is 243 KB compressed for a ~654 KB-class
binary; calc/paint payloads should land similar.)

## 5. 🔴 FLAG: deck is baked and published, against the standing rule as written

Ticket #581 states: *"`deck` must NEVER enter the published image (standing rule, see
`deck-013-never-seeded`)"*. Measured reality: `/usr/bin/deck` is a system `project` entry,
`/usr/share/deck/{gucos.deck,deck-title.png}` are baked, `Demos/deck` is a baked menu
entry, the user section seeds `/root/Desktop/Presentations/gucOS/`, and the comguc deploy
**deliberately ships the deck demo assets** (`~/git/comguc/scripts/build.mjs:208-212`,
citing todos/0284 as the design; the 0284 lane-2 record confirms this was built and gated
on purpose, image v153).

Most plausible reconciliation: the rule is about the **013 talk deck** (jku's talk
content — "Lane 3: author the 013 deck in-OS" — which indeed does not exist anywhere in
the repo; `os/deck/demo/` holds only `gucos.deck`) **never being seeded/committed**, not
about `/bin/deck` itself. But comguc's glob comment says new demo decks "(e.g. the 013
talk) ship automatically" — if the 013 deck were ever dropped into `os/deck/demo/`, the
deploy would publish it silently. Either reading needs an @master/jku ruling: (a) if the
rule really bans the deck *binary*, the image has violated it since v153 — P0-shaped;
(b) if it bans the 013 *content*, the comguc auto-glob is a standing trap worth a guard.
Per instruction, deck is excluded from the batch regardless.

## 6. Open questions (things I could not settle without running something, or without jku)

1. **Exact v244 sizes.** The only on-disk image is a v241 fat bake; deriving v244 sizes
   needs `mkimage` (banned here). Sizes above are v241-indicative; the batch conclusion
   does not turn on the delta.
2. **Minimal-image size.** ~16.6 MB is derived as fat − `/opt`; the comguc deploy's
   actual minimal blob size was not measurable without a bake.
3. **The deck ruling** (§5): which reading of `deck-013-never-seeded` is correct?
4. **notepad policy**: is losing the offline-first-boot GUI editor acceptable under the
   defaultPackages pattern? (Mechanics are proven; this is product policy.)
5. **mgp/mgpp re-rule**: #80 was decided when packages were young (pre-#419
   defaultPackages, pre-#578). Does jku want to revisit for the 1.68 MB? Surface only.
6. **snake wrapper pattern**: is a `bin` claim pointing at a `#!/bin/sh` script in the
   payload acceptable to mkpkg/gucman/activate()? (activate() handles `#!`; unproven in
   any shipped package — needs a build to prove, banned here.)
7. **filepick sequencing**: does the netsurf patch (PATH-relative spawn) break any
   netsurf test that pins the absolute path? (Needs a run to be sure.)
8. **psh deletion**: zero consumers found — delete outright rather than package? (jku
   call; it predates the desktop era as `/bin/psh` protoshell.)
9. **defaultPackages growth**: #578's "status-quo preservation" pattern adds every
   unbaked ex-baked app to `defaultPackages`. At some point jku may prefer genuinely
   on-demand (calc/paint feel closer to that line than doom/gcode did) — the batch above
   follows precedent but the question deserves an explicit answer.
