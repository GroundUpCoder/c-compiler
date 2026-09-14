# #789 Quake FLAGS assertion correction

Test-only follow-up based on e7d18dc2. The immutable corrected mapped gate
reported Quake geometry/scale failures despite the expected geometry because
both regexes still required eight FLAGS characters. wmctl now emits nine;
the last slot is requested-hidden H. Add a literal trailing dash in both
full-field patterns, preserving geometry, DST, focus, relative-mode and all
other existing checks. No shared parser, runtime change or timeout change.

Audit: inspected tracked tests/os/tools JS, MJS, C, H and shell consumers for
wmctl/rec_flags/FLAGS, tab-delimited literal flag patterns and fixed-length
flag access. The two Quake patterns were the remaining stale full-field
matches found. WM-service already asserts f---R----. Other consumers use
column splitting, individual flag positions/membership or variable-width
fields; no further stale fixed width was found by this audit.

Validation executed: node --check tests/browser/os-quake.mjs; git diff --check;
17 nonboot checks extracting both actual regexes from source. Positive rows
pass; eight-character, H-set ninth, ten-character, unfocused and resizable
rows fail. Scaled geometry, position and DST negative rows fail; unscaled
position captures remain72/76. These are synthetic regex checks, not browser
or installed acceptance. No shared parsing introduced.

Independent exact-tip review requested separately. Browser reproduction and
flake remain pending dispatcher49031 completion and explicit slot release.
The unchanged900s boot-timeout diagnosis remains separately blocking. No
old/current candidate edits, bake, boot, browser, heavy tests or deployment.

## Executed acceptance and separate boot diagnosis

Exact source/test tip4b2fcb8ba67b7a1a1220b4f802395b04a1eaa269 independently
approved by external reviewer01a09ecd-a80c-78e3-b4da-c443469da62a (codex/gpt-6-astra,
metadata verified); reviewer independently repeated17 regex controls. After
explicit slot release and free-lock verification:

- Real Quake browser acceptance1/1 PASS (11.4s), including drag geometry and
  fixed-resolution scale assertions, real frames, animation and clean close.
- Quake under10 CPU load workers3/3 PASS (34.0s total). Both selections have
  no resumed/carried rows. Automated browser interaction, not human manual.
- Existing test_os_boot.js run through the kernel runner with --serial and
  --filter=test_os_boot.js:1/1 PASS,772.3s. Outer900000ms row deadline and
  inner300000ms spawn budget unchanged; no CC_OS_BOOT_TIMEOUT_MS override.
  Test/boot/mkimage/spawn-budget source unchanged. All four real bake
  contracts retained, including final stale-fixture bypass and clean exit.

External diagnostic sampler (preserved as sample-boot-v1.py) captured the
runner process tree's CPU time/%CPU/RSS, image size/mtime and child lock
metadata, and timestamped new log text every2s. It did not patch/preload the
test or boot source. The wrapper wall time774.1s includes sampling startup/
final observation; the authoritative suite file result is772.3s. Sampling
bounds are approximate, short children can fall between samples, and RSS
peaks are lower bounds. Buffered child stderr is still unavailable mid-spawn;
the preserved child-progress evidence is process activity plus file writes.

Observed long phases (seconds relative to sampler start; first/last sample):
first --fresh --no-fixture2.0..241.7; vNext mkimage254.0..284.6;
--fresh-system288.7..536.6; final fixture bypass540.7..772.0.
PASS markers observed at243.7/286.7/538.6/774.0 respectively. Thus roughly
242/33/250/233s per bake phase, not four equal-cost bakes (vNext is minimal).
Each long child accumulated CPU time and wrote image data before completing;
sampled total process-tree peak3.924GiB. Some compile intervals have a flat
image size while CPU time advances: file size alone is not a hang detector.

Comparison: callback mapped boot789.1s, original lifecycle753.0s, corrected
mapped timeout900.4s, this serial772.3s. Corrected mapped final child started
~638s into the test, leaving~262s; serial final child was observed~541s into
this run. Corrected mapped initial fixture bake320.2s versus this worktree's
237.2s is a separate slowdown signal, not time charged to the900s test row.
The earlier retained partial image showed writes near the outer kill and no
completed version marker. Together these observations support cumulative
bake slowdown under mapped conditions. They do NOT prove the specific CPU/
I/O/contention cause, resolve the mapped failure, or establish a stuck-child
fix. This isolated pass is diagnostic evidence only; no timeout was raised.

Next evidence-backed step: fresh25-suite mapped acceptance on the accepted
tip, recording the same process/image/log timeline through test_os_boot and
its concurrent siblings. Preserve deadlines. If repeated mapped failure
shows active baking slowed by siblings while serial remains healthy,
consider a separately reviewed scheduler-isolation change for this test,
with a sensitive scheduler exclusion control and real mapped repeat. If the
trace instead identifies a stalled phase, diagnose that phase. No scheduler
or observability source change has been made or asserted necessary from one
serial pass. Outer-kill phase/stderr retention remains an observability gap;
its improvement needs separate sensitive outer/inner kill controls and review.

All raw logs, summary manifests, two-second samples, derived phase summary,
sampler and source/image hashes are committed in789-quake-acceptance-evidence.
No old/current mapped candidate or evidence was edited, no graphics gate,
main integration or deployment ran. Heavy lock absent at author completion.
Fresh mapped acceptance and the wider UI/Swing rollout remain coordinator-owned.
