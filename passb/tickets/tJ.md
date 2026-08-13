# gcode context: ship a compact SDL API index — agents spend ~15 rounds per session re-grepping the header

**Class: quality-gap (agent context). Found by #508 Pass B round 2, observed at commit e704f078.**

## The gap

GCODE.md (correctly, post-#505) tells the model "the headers are the authoritative surface — read the header, don't assume stock SDL3". The measured consequence: in a fresh session the agent spent **~17 of 34 rounds** (game #1) grepping/sed-ing `/usr/include/SDL.h` to reconstruct the API surface, and repeated a shorter version of the same archaeology in later sessions because compaction folds the details away. At ~5-10s a round that is 1.5-3 minutes of every session, plus the context tokens of raw header dumps.

## Fix shape

A generated one-line-per-symbol index (name + signature, grouped video/events/audio/textures, plus the "notably absent" list: TTF, RenderTextureRotated, render targets, gamepad) at `/usr/share/doc/sdl-api-index.md`, referenced from GCODE.md's SDL bullet. Generated from the header block at bake time so it cannot drift (the #505 drift-pin precedent, `tests/host/test_gcode_orientation.js`). The #530 layered-context mechanism already carries doc references into the system prompt — this is one more file, no gcode code change.

## Gamedev justification

Direct multiplier on the gcode-authored arm's iteration speed — the epic's raised bar names agent-driven game building first-class, and API rediscovery is its single largest measured round sink.

Evidence: `s3://groundupcoder/gucos/508-passb-r2/2026-08-13/s1-brief.log` (rounds 1-17: header archaeology before the first line of game code); sessions JSONL round counts.
