# sdl-gucos.md: document the headless audio sink absence (and the software-tier caveats)

**Class: quality-gap (documentation). Found by #508 Pass B round 2, observed at commit e704f078.**

## The gap

`/usr/share/doc/sdl-gucos.md` (os/doc/sdl-gucos.md, 88 lines) documents the main-loop/GPU-frames rule well — the dogfood agent read it first and wrote a correct callback app on try one. But three platform facts a game author needs are absent, and the agent had to discover each empirically (burning rounds):

1. **Headless boots have no audio sink**: under `os/boot.js` the output ring never drains — `SDL_GetAudioStreamQueued` grows monotonically (measured: queued=88200 constant across seconds while pushing). An app that paces audio production on "queued < threshold" stalls its sound forever headless; the agent probed this with a test app, concluded "no audio sink", and capped its backlog. This is deliberate design (boot.js has no audioInit) — document it and the recommended pattern (bounded backlog, never block on drain).
2. **Software-tier rendering caveats**: diagonal RenderLine/RenderGeometry degradation (P0 filed separately — if that ships, this bullet dies; until then the doc is the only warning a `SDL_RENDER_DRIVER=software` user gets).
3. **No TTF / what to do for text** (feature-gap filed separately; until it ships, say so and point at the 5×7-font pattern instead of letting every author rediscover the absence by grepping).

## Fix shape

Three short paragraphs in os/doc/sdl-gucos.md; per the doc's own style, state the rule + the sanctioned pattern. Cross-link from GCODE.md's SDL bullet so the agent context carries the audio fact too.

## Gamedev justification

Documentation is the in-OS dev loop's context surface for both human and agent arms; every empirical rediscovery is rounds/minutes per game.

Evidence: `s3://groundupcoder/gucos/508-passb-r2/2026-08-13/s5-frontier.log` (the audio-sink probe: "push=1 queued=88200 … Confirmed: this sandbox has no audio sink").
