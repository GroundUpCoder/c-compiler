# gcode: no way to actually SEE a screenshot — pixel-stat self-verification passed mirrored, unreadable text as "confirmed"

**Class: feature-gap. Found by #508 Pass B round 2, observed at commit e704f078.**

## What happened (the concrete failure)

gcode built a complete Asteroids game and "verified" its HUD/title text with `wmctl shot` + self-written libpng analyzers (pixel counts, cluster centroids, ASCII dumps). It declared "HUD confirmed: SCORE 0000 top-left" and shipped. **Every glyph was mirrored** — the game's FONT table stored bit 0 as the rightmost column while `draw_text` emitted bit 0 leftmost, so the title read "ƧƆOᴚƎ"-style garbage. A human saw it instantly on the first eyeball of a screenshot; the agent's verification could not, because:

1. Pixel statistics (counts, centroids, bboxes) are mirror-invariant.
2. Its ASCII-dump "reading" was confirmation-biased (it reported the expected string).
3. Its later ground-truth comparator initially **shared the same bit-convention bug** as the renderer, so it scored the mirrored output as matching (verification-shares-the-bug).

When told by the human, gcode did find and fix the one-line bug and built an offset-scoring comparator that proved readability (title_final.png) — the loop works once a human supplies eyes.

## The gap

`wmctl shot` produces real PNGs (#657), but gcode has no path to put an image in front of the model (no image content blocks in tool results, and no in-OS visual-diff/OCR utility to substitute). So every visual claim an agent-built game makes is verified only by statistics that cannot catch orientation, layering, color-channel, or "looks wrong" defects. For the epic's gcode-authored arm, the human must eyeball every frame — that is the enjoyability tax this ticket names.

## Fix shapes (discussable — filing the gap, not prescribing)

- gcode: support image attachments in tool results (the Anthropic-shape API gcode already speaks supports image blocks; DeepSeek vision support needs checking — if absent, gate on model capability).
- And/or an in-OS `wmctl`-adjacent text probe: ksvc already rasterizes labels; a `wmctl ocr SID` against the known baked fonts would catch app-rendered text — but app-custom fonts (this exact bug) still need real vision.

## Gamedev justification

Games are visual; an agent that cannot see pixels cannot close its own verify loop, which is the raised bar's core requirement for the gcode arm.

Evidence: `s3://groundupcoder/gucos/508-passb-r2/2026-08-13/` — evidence/asteroids/shots/title_verify.png (mirrored, "verified"), title_final.png (fixed), s4-patience.log (the false "HUD confirmed"), s6b/s7-finish.log (diagnosis + fix after human report).
