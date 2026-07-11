# 0108 — test_openwith_e2e: register + realign with the sameboy default

`tests/kernel/test_openwith_e2e.js` (the 0072 acceptance: resolver order,
`open --set`, the fileman "With" picker, default.gui, persistence) had
silently rotted in exactly the way the 0091 handoff warned tests can: it
was never added to run.js's MANIFEST, so the suite never ran it, and in
the meantime commit `7f6d3c0` flipped the baked `.gb`/`.gbc` association
from `/bin/gameboy` to `/bin/sameboy` — three checks failed on a clean
checkout and nobody could notice. Found by the 0092 closeout audit.

## What landed

- **Realigned the test with the seed** (the item's ruling: `os/image.json`
  is the truth, not `todos/done/0075`'s early "gameboy stays default"
  line): the `.gb` legs now expect a `SameBoy`-titled window (fileman
  Open = 1, desktop dblclick = +1) and `conf1` expects
  `gb\t/bin/sameboy` + `gbc\t/bin/sameboy` carried forward. The minimal
  0x150-byte synthesized cartridge works unchanged under SameBoy: the
  header recipe (logo + header checksum) satisfies the embedded boot ROM,
  and `GB_load_rom_from_buffer` pads the bank with 0xFF, so execution
  NOPs into the pad and RST $38-loops forever — the window stays up,
  which is all the test needs. Also noted in the grid comment that the
  0093 Recycle Bin pins to the TAIL, so the icon-cell math is unshifted.
- **Registered it**: `['test_openwith_e2e.js', IMG]` in the run.js
  manifest (after test_fileman_e2e). Verified it's the ONLY orphan —
  `ls tests/kernel/test_*.js` vs the manifest matches everywhere else.
- **Doc drift fixed at the durable copies**: run.js's test_sameboy_e2e
  comment ("gameboy stays the .gb default" — it contradicted the very
  check that test makes) and CLAUDE.md's two spots (vendored-projects
  list, os/ openwith seed). Historical dev logs left as written.

## Surfaced: win32 cmdline vs absolute POSIX paths (filed 0111)

The baseline run's window list showed an unexplained `ERROR` box next to
"Untitled - Notepad" on the default.gui leg. Root cause, verified in
source: kernel32's `proc_info_init` quotes only args WITH SPACES when it
joins argv into `GetCommandLineW`, so notepad's `lpCmdLine` is a bare
`/root/owtest/readme.md`; ReactOS `HandleCommandLine` treats leading `/`
as an option prefix, consumes `/r`, and tries `oot/owtest/readme.md` →
AlertFileDoesNotExist. Every default.gui open of a real file hits this.
Filed as **0111** (slotted after 0106 with the fileman cluster) with the
preferred fix (quote EVERY cmdline arg, Windows-canonical) and the
test-tightening it unlocks; 0108 deliberately kept the default.gui check
loose (`/Notepad$/` — guards launch, not the still-broken file load) so
the suite stays green until 0111 lands.

## Verification

Baseline reproduced the item's exact 3 failures (and only those). After
the fix: standalone `node tests/kernel/test_openwith_e2e.js` → ALL OK
(15 checks, both boots); `node tests/kernel/run.js --filter=openwith` →
pass in 28.5s (registration proof); full kernel suite re-run green.

Process note: hit the documented `queue.js add --help` trap (it ADDS an
"untitled" item — the 0099 fix is still queued); undid via
`git checkout todos/queue.json` + rm before re-adding 0111 properly.
