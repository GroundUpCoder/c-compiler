# #419 — Default packages: eager install on first boot

The mechanism that lets an app (or a font — anything) live OUT of the baked
blob and still feel built-in. Design fork was closed by jku 2026-08-03:
**eager install on first boot** (lazy-on-first-launch is dead — a font default
is pulled in by a glyph-cache miss, not a click, so there is nothing to hang a
lazy trigger on).

## Where the pieces live, and why

- **Declaration — `defaultPackages` in `os/image.json`, ONE place.** The
  alternatives lose: a `default: true` flag spread across `packages/*.json`
  makes "what is the default set" an N-file read and makes defaultness a
  package property when it is a *distribution* decision; a key in the repo
  `index.json` would force every boot to fetch the network just to learn
  there is nothing to do, and would make offline boots noisy forever.
- **Derivation — `bakeSystemImage` bakes `/usr/share/gucman/defaults`** (one
  name per line) from the manifest key. That is the ONE bake choke point both
  hosts share, so browser and headless agree by construction. An empty set
  bakes NO file. A newly added default therefore reaches cached/PWA installs
  through the normal blob-upgrade wire (version bump → re-fetch → next boot
  installs it) — the "second boot is the first boot for a new default" case.
- **Validation — `foldPackages`** (every Node bake path: mkimage, boot.js,
  image-fixture, serve.js): unknown / duplicate / gated / non-array names
  refuse loudly before a ~minute-long bake. The browser in-worker bake has no
  `packages/` to check against; the Node gates are where the typo is
  catchable.
- **Override — `/etc/gucman/defaults` wins wholesale** (the existing
  `repos`-file rule). Also the e2e's runtime seam.
- **Trigger — `gucman sync-defaults` as a `kernel.service()`** right after
  the `/bin/wm` autostart, in both `os/boot.js` and `os/kernel-worker.js`,
  gated on the defaults file existing at all. The shipped manifest declares
  `[]`, so no file bakes and no service spawns: every existing boot in the
  estate is byte-identical until #420 populates the set. Service fd 1/2
  route to the boot console in both hosts — the progress/failure UI costs
  nothing. NOT `/etc/profile`: that file seeds ONCE onto a fresh root volume
  and is never touched by upgrades, so existing users would never get the
  trigger.
- **Durability — the one real decision.** "The default set means: install
  once, unless the user has ever said no." `gucman remove` writes a tombstone
  `/var/lib/gucman/removed/<name>` BEFORE unlinking the DB record (a crash
  between the two leaves it installed — safe; the reverse order is the
  resurrection bug). Any successful install clears it. `sync-defaults` skips
  installed ∪ baked ∪ tombstoned; a FAILED install is deliberately NOT
  tombstoned, so the next boot retries.
- **Outcome record — `/run/gucman-sync.status`** (atomic tmp+rename; line 1
  `ok`/`failed`, then `installed <name>` / `failed <name>` lines). The
  machine-readable completion marker for tests and future front-ends
  (software.c can read it later); the console text stays the human surface.

## Non-app packages (the #437 shape)

The acceptance question "can this mechanism deliver a font?" is answered YES
by construction and by test: the e2e's default set includes `font-unifont`
(no executable, no launcher, no menu entry) and asserts its
`/etc/fonts/fallback` line lands after a boot with zero UI interaction —
exactly the path a glyph-cache miss benefits from.

## Numbers

- Built minimal `.img` (`tools/mkimage.js`): 16,721,304 → 16,724,656 B,
  **delta +3,352 B** (the sync-defaults code in the baked gucman binary;
  the empty default set bakes no file). Headroom against the 26,214,400 B
  cap: **9,489,744 B**.
- Tests: `tests/host/test_default_packages.js` (8 checks) +
  `tests/kernel/test_defaults_sync_e2e.js` (39 checks, 5 boots) — both
  landed RED first (red control `4a4973eb`: host 6/8 FAIL, e2e dies at
  WAIT-TIMEOUT-STATUS) and are green at this commit.

## Answer to "why was this labelled heavy?"

jku was right about the diff: the product change is small (~150 lines of C,
~40 of JS). What earns the label is (a) the GATE — five new boot scenarios
(clean-first-boot-with-network, remove-then-reboot, later-added default,
dead repo, retry) that nothing else exercises, riding a kernel+sweep-selecting
diff; and (b) the removal-durability corner, which needed real persistent
state and an ordering argument, not a `gucman install` call. The mechanism
itself was indeed "run gucman install at setup" — as he said.
