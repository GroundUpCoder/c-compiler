# #659 — parsePng() validates chunk CRCs

The ticket carried a standing instruction to ARGUE the check before implementing
(the #657 author's counter pass carried over). Verdict: implement — with the
honest caveat that the marginal protection is narrower than the ticket's framing.

## The argument, both sides

**Against (the rebuttal candidate):** most corruption was already caught without
CRCs. zlib's `inflateSync` verifies an Adler-32 over the decompressed IDAT
payload, and the decoder enforces exact raw length (`h*(1+stride)`) and
filter-byte validity. So corruption *inside IDAT data* almost always threw
pre-fix. The Codex repro corrupted the CRC *field* itself — which by definition
changes no decoded byte. The marginal detection surface: IHDR/framing damage
that keeps the length identity intact, and CRC-field damage as a proxy signal
that the transport mangled the file.

**For (why it landed):**

1. `png.js`'s own header contract — "a malformed or truncated shot must fail
   the test, not decode to a quiet zero" — was violated. A stored-CRC mismatch
   is malformed per PNG spec §5.3, and `readShots()` builds on the throw
   contract.
2. Cost ≈ zero: `crc32()` was already in-file, exercised on every encode.
   The fix is one comparison in the chunk walk.
3. The kernel e2es move shots over a base64 tty cat-back (`parseB64Png`).
   A CRC mismatch means the transport damaged the evidence; accepting it makes
   the assertion outcome a function of *where* the damage landed, not *whether*
   it occurred — the gate-that-lies mode.
4. No legitimate producer is harmed. Verified: every other chunk-builder in the
   estate (`test_netsurf_content_e2e.js`, `tools/mkwebfixtures.js`) writes real
   CRCs (their consumer is in-OS libpng, which validates). The ONLY zero-CRC
   producer was `test_png_helper.js`'s own `mk()` fixture — a circular
   justification ("the reader skips CRCs"), fixed in the same commit.
   `test_deck_e2e.js`'s private `decodePng` walk is a consumer, unaffected.

## Details

- The mutated-IHDR fixture in control 4c (colour type → palette) now re-seals
  its CRC after the mutation — validation runs *before* the format check, and
  the guard under test must stay the format guard. The old line-165 comment
  ("fix the IHDR CRC so the guard under test is the format check") anticipated
  exactly this; pre-fix no fix-up was needed because CRCs were skipped.
- The spec-independent CRC/chunk helpers hoisted from section 2's block to file
  scope, shared by 4c — still re-derived from the spec, independent of png.js's
  own table, so the fixtures don't certify the decoder with its own arithmetic.
- Legs: 17 + 2 = 19 (`corrupted IHDR CRC throws`, `corrupted IDAT CRC throws`).
  Red-controlled: with the png.js hunk reverted, exactly those two fail
  "did not throw" (reproducing the Codex acceptance) and the other 17 stay
  green.
- No image bump — tests/ only.
- Worktree note: `tools/mkpkg.js --defs=…` alone now refuses without a baseline
  decision; the cold-worktree pre-warm form is `--defs=… --no-baseline`.
