# #578 step 2 — gcode ships as a gucman package (lane-578gcodepkg)

gcode moves out of the baked image into `packages/gcode.json`, the #420 doom
pattern. Four edits:

1. **`packages/gcode.json`** (new, the `git.json` shape): `files.gcode ->
   os/gcode/bin.json`; `bin: { gcode, code }` both naming the one file. The
   `/usr/bin/code` back-compat name CANNOT stay a `link` entry — package
   `link` entries throw (`os-common.js` "link entries are not supported in
   packages") — so it is a second `bin` claim. Verified end-to-end: the fold
   plants `/usr/bin/gcode` AND `/usr/bin/code` as `{link:
   "/usr/opt/gcode/gcode"}`.
2. **`os/image.json`**: the `/usr/bin/gcode` project entry and `/usr/bin/code`
   link removed; `defaultPackages` -> `["doom", "gcode"]` (jku-ruled:
   status-quo preservation — a binary that was baked and gets pulled out goes
   into the default set; the nine pre-existing optional apps are NOT
   promoted). Version untouched at 244 — bumps at ship, not per lane (the
   6bd1f3f9 precedent, stated in its commit message).
3. **`tests/host/test_source_packages.js`**: `gcode-sources` flips to the
   package derivation ("the package derivation wins") at the package version
   — kept as an assertion pinning the flip itself. The image-derivation
   exemplar re-points to `gucman-sources`: the package manager can never move
   out of the image, so this exemplar never needs re-pointing again.
4. **`tests/kernel/test_gucman_sources_e2e.js`**: comments only. It reads
   versions dynamically off the built index and asserts payload contents
   (`os/gcode/gcode.c`, `os/gcode/bin.json`) that the package-derived closure
   still carries. The install path is derivation-agnostic; image-kind
   synthesis + a real image-kind mkpkg build (cc-sources) stay covered
   host-side in test_source_packages.js.

The previously-unproven step is now proven: a real `mkpkg` build of the gcode
package succeeded (deps closure `os/curl/lib.json` + busybox lineedit built
inside the payload, 1.8s, 71 KiB payload), and the extracted payload carries
`control.json` with both bin names plus a 179 KB `\0asm` wasm binary at
`opt/gcode/gcode`.

Gate (`node tests/run.js --diff main` = host + kernel + sweep, gated ALONE —
this change edits test instruments): all three suites pass. kernel
169/169/169 done:true, sweep 58/58/58 done:true, host exit 0; run-level
record `tier: diff`, `filter: null`, every result literal `pass`. The 6
kernel gcode tests + `test_gcode_native.js` + `test_gucman_sources_e2e.js` +
`test_defaults_sync_e2e.js` + `test_gucman_doom_e2e.js` all pass UNEDITED —
the fat fixture folds every package, so `/usr/bin/gcode`/`/usr/bin/code`
stay at today's paths in test images. The expected one-time cold fixture
rebake happened (folded.names changed); kernel leg 22.9 min total.

Non-obvious survivals checked at source: `gucman sync-defaults` writes one
`failed <name>` status line per package, so `grep -x "failed doom"` in
test_defaults_sync_e2e survives gcode joining the set; the baked
`/usr/share/gucman/defaults` lists one name per line, so `grep -x doom`
survives too.
