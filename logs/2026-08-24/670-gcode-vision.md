# #670 — gcode read_image: real pixels in front of the model

**Lane:** `lane/670-gcode-vision`. **Class:** feature-gap (the ticket's own
classification), the honest-shape failure one level up: a self-verify that
reports success on wrong output. Found by #508 Pass B r2 — gcode "verified"
an Asteroids HUD with pixel statistics and shipped every glyph mirrored.
Sole remaining open blocker of #678 (Pass B round 3).

## The design call

The fix is **eyes, not a better statistic**. `read_image {path}` returns the
file's exact bytes as an image content block in the `tool_result`, so the
model's own vision looks at the same PNG a human reviewer would.

Two properties are the whole ticket, and both are structural:

1. **It would have caught the mirrored glyphs** — proven live, not assumed
   (see the discriminator control below).
2. **Verification cannot share the bug.** The tool renders no verdict and
   applies no transform: base64 is a positional transport encoding, there is
   no pixel convention in the tool to get wrong, and there is no
   expected-glyph table anywhere to inherit the renderer's bit convention
   from. A transport bug corrupts the image loudly (the provider rejects
   undecodable data); it cannot plausibly pass a wrong picture. The one
   shared substrate is `wmctl shot`'s framebuffer readback + PNG encode —
   the same substrate the human's verdict rode, upstream of the app under
   test.

Rejected shapes: `wmctl ocr` (blind to app-custom fonts — the exact bug
class — and a fresh comparator that could share platform font conventions);
better statistics (wrong instrument class, not a tuning problem);
overloading `read_file` to return images silently (a text-contract tool
changing shape per content); base64-in-a-text-block (models cannot perceive
pixels through base64 text). The in-OS OCR arm is explicitly out of scope
per the coordinator's ruling — separate ticket if ever wanted.

## The DeepSeek measurement (a finding, not a footnote)

Measured 2026-08-24 against `https://api.deepseek.com/anthropic`
(deepseek-v4-flash AND deepseek-v4-pro; image blocks both in a plain user
message and in a real tool_use/tool_result round-trip):

**HTTP 200 every time — the image is silently replaced server-side with a
literal `[Unsupported Image]` placeholder.** The model's own output confirms
it ("The tool returned an unsupported image result. I can't actually see
the color."). No error ever comes back.

Consequences:
- The `deepseek → no vision` capability-table entry is CORRECT, and the
  failure mode is worse than assumed: **silent**, so no server-side signal
  can ever catch a wrongly-open gate on that route. The client-side gate is
  the only defense.
- **The standing DeepSeek dogfood route cannot see.** Visual
  self-verification there needs a vision-capable model (the Anthropic key)
  or a future DeepSeek vision model. gcode now says this loudly at startup
  on that route instead of letting the model half-believe it might see.
- Side observation (out of scope, noted for whoever next touches
  gcode-on-DeepSeek): a NON-streaming request that passes back an assistant
  message without its `thinking` block gets a 400 ("The `content[].thinking`
  in the thinking mode must be passed back to the API"). gcode's streaming
  sessions demonstrably work (235 rounds in #508 r2), so this bites probes
  and replays, not the live path. Not filed; re-derive before acting on it.

Evidence: `s3://groundupcoder/gucos/670-vision/2026-08-24/deepseek-probe{1,2}.txt`.

## What landed

- `read_image` tool: magic-byte sniff (PNG/JPEG/GIF/WebP — content decides,
  never the file name) with header dimension parse for all four formats;
  3.75 MB byte cap and 8000 px pre-checks mirroring the API's own limits;
  refusals name the `wmctl shot X Y W H` region-crop fix.
- `tool_result` content becomes a block array (image + one-line caption).
  `execute_tool` grew a `blocks_out` seam; compaction folds an image round
  to its caption (base64 never survives a fold); the #387 UTF-8 guard
  checks nested text blocks; #463 repair is id-based and unaffected.
- Capability gate: table (`claude` on, `deepseek` measured off) +
  `GCODE_VISION=1/0` override; known-off and unknown models get a loud
  startup note; a gated-off call is refused as a string; `read_file` on
  image magic redirects (vision on) or says honestly that the model cannot
  see (vision off).
- The belt for providers that DO reject: a permanent 400 naming images
  strips image blocks to loud markers and retries once on the shared
  #463/#467 per-turn budget, double-gated (wording AND an image actually
  present).
- Docs: GCODE.md (model-facing) teaches shot → read_image → LOOK and the
  mirror-invariance warning; os/doc/gcode.md documents the tool and the
  DeepSeek limitation. image.json 276 → **277**; gcode package 0.3 → 0.4.

## The live discriminator control (the ticket's acceptance question)

Fixtures: "SCORE 0000" in a 5×7 bitmap font, correct and per-glyph
mirrored (`rev5` of each row — the exact #508 bug: FONT bit order reversed).
Both files have byte-identical pixel statistics (156 lit cells).

Through native gcode against the real Anthropic API (claude-opus-4-8), same
question both times ("does the text render correctly? Start with YES or NO"):

- **correct.png → "YES. The text renders clearly as 'SCORE 0000' … reads
  exactly as intended."**
- **mirrored.png → "NO. The text is horizontally mirrored (flipped
  left-to-right) … making the HUD unreadable."**

First look, no hints, no statistics — the human's #508 verdict, now inside
the loop. Evidence (fixtures, transcripts, generator):
`s3://groundupcoder/gucos/670-vision/2026-08-24/`.

## Mutation evidence (every mechanism shown RED)

Each mutation applied to gcode.c, suite run, reverted:

| Mutation | RED legs |
|---|---|
| base64 second-sextet corrupted | 3 byte-identity legs |
| JPEG sniffed as image/png | media-type leg |
| deepseek gate opened | 4 gate legs |
| read_file redirect disabled | 2 redirect legs |
| history_strip_images neutered | 4 recovery legs |
| compaction caption branch dropped | caption leg |
| px-cap check disabled | dimension leg |

The compaction-caption mutation initially went GREEN and exposed a vacuous
assert: the summary's `tool: read_image PATH` line contains the substring
`image PATH`, so a path-only check passed without the caption mechanism.
The assert now pins the caption's `: image/png 16x8` tail. That is the
mutation discipline doing exactly what it exists to do — on a ticket about
a verifier that could not fail.

## Test surface

`os/gcode/test/smoke.mjs` test 15: 32 legs (transport byte-identity, sniff
authority, four refusals, five gate configurations, redirect, resume
byte-identity, compaction fold, strip-retry + negative control). C-level
self-tests (`--self-test`): RFC 4648 base64 vectors, all four sniff header
layouts, strip idempotence — these also run IN-IMAGE via
`test_gcode_step2_e2e.js`'s self-test leg at the kernel gate. In-OS compile
verified via `mkpkg` (gcode 0.4 builds under the in-OS compiler).

Gate: `os/gcode/**` maps to kernel + sweep; run embargoed pending the
coordinator's scheduling against the heavy lock.
