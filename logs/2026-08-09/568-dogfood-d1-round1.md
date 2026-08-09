# #568 — PKGDEV dogfood D1, round 1: how it felt

**The headline: gcode rebuilt gcode inside gucOS, and it took 3 minutes 23
seconds.** One `gcode -p` turn (deepseek-v4-pro, 34 rounds) installed nothing,
asked nothing, and did the whole assigned loop: edited its own 2833-line
source at `/usr/local/src/gcode/os/gcode/gcode.c` to add a `--version` flag
(clean, idiomatic, help text updated), read `bin.json` → `os/curl/lib.json` +
`vendor/busybox/lineedit.json` → `libbb-core.json`, composed one 47-file /
5-include-dir / 3-define `cc` command by hand, hit a real packaging bug,
diagnosed it, worked around it, and produced `/root/gcode-new` — which prints
`2 rebuilt in gucOS` and, verified in a separate session, still works as a
full streaming agent with tools against the live endpoint. Clean rebuild of
the 47 files: **3 seconds**. Boot ~1 s, `gucman install gcode-sources`
~instant on localhost. The loop is not just viable; it is *fast*.

**The bug it found is the epic's own core promise breaking.** The `-sources`
payload omits `xatonum_template.c` — busybox's `#include "a-.c-file"` template
idiom is invisible to `closureOf` (sources + headers-under-includes + deps
only), so the shipped sources cannot rebuild the shipped binary (#617, P0).
The agent's workaround was to *reimplement the missing file from the header's
declarations* — a faithful reconstruction, impressive and quietly alarming:
a less careful model would have produced subtly-wrong numeric parsing and the
binary would still have linked. Notably, `test_gucman_sources_e2e` cats
`bin.json` but never runs `cc`, which is exactly why this survived: the epic
doc's "edit + cc rebuild works today" cites a test that stops one step short.

**Where gcode alone could not do it:** nowhere, this round — but only because
my kickoff prompt did the documentation's job (pointed it at bin.json/lib.json
semantics and told it compiles are slow-ish). There is no `/usr/doc`
(#566 evidence commented), no `cc --project` (#618), no `time`, no `strings`
(#619). The driver-side papercut: boot.js pointed at a vanished image dir dies
with an ENOENT stack blaming the *lockfile* (#620). The #504 windowed leg was
deliberately not exercised (tty target); round 2 (#621) carries it, plus
payload-only-rebuild and docs-only-discovery legs.

**Subjectively:** the surprise was how little friction there was. I budgeted
ten minutes per session and the whole live loop — boot, install, live model
round-trip — fit in seconds. The tool set (read/write/edit/bash) sufficed; the
model never fought the OS, only the packaging gap. The measurement worry going
forward is the inverse of what I expected: the platform is ready for harder
dogfoods than "add a flag" — round 2 should raise the bar before the rounds
start flattering the platform.

Evidence: `s3://groundupcoder/gucos/dogfood-d1/2026-08-09/` (full transcripts,
driver, session scripts; the sessionC log embeds the complete session-B
agent JSONL including the exact 47-file cc command). Findings: #617 #618 #619
#620 (+#566 comment). Round 2: #621, hard-blocked on all five, edges re-read,
`derived.ready=false` verified.
