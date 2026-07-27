# 0352 — `/bin/mgpp` reads `.mgpp` — a zip bundle of the deck plus its assets

- **Status**: open
- **Provenance**: jku by email, 2026-07-28 — *"why can't `*.mgpp` be a format
  that the mgpp binary can read?"* He is right, and it dissolves what had been
  wrongly called a name collision: **mgpp (the binary) reads .mgpp (the
  bundle)**. No new name is needed. Full context:
  `~/git/meta/meta/notes/queue-zip-mgpp-2026-07-28.md`.
- **Priority**: P2.
- **Blocked by**: `0350` (needs the zip reader).
- **Design precedent**: `0272` MagicPointPlus (shipped in gucOS v144).

## Goal

`/bin/mgpp` opens BOTH `.mgp` (plain deck, exactly as today) and `.mgpp` (a zip
containing the deck `.mgp` plus its images/assets).

## What `0272` already established — reuse it, do not re-litigate

`0272` shipped ONE source: `mgpp.json` builds `/bin/mgpp` from the same file
list as `bin.json` with only `-DMGPP` added, and the entire behavioural delta is
three small `#ifdef MGPP` blocks in `handle_xevent` in `mgp.c` (left-half click
→ back, right-half → forward, `XK_Left` → back). **With `MGPP` undefined, `mgp`
is byte-identical.** That guard is the natural home for this work, and that
byte-identity property is a hard requirement here too — `0272` proved it with
`present_e2e` plus browser legs; keep the property and keep the proof.

## Plan

1. Sniff the `PK\x03\x04` magic. The plain `.mgp` path stays exactly as today —
   no change on that branch.
2. Put ALL of it inside the existing `#ifdef MGPP` guard so plain `/bin/mgp`
   stays byte-identical.
3. **Asset path resolution is the crux.** Check how `mgp` resolves `%newimage`
   paths relative to the deck dir, then choose:
   - extract to a temp dir and open the inner deck — simple, no parser change;
     or
   - an in-memory VFS — no temp files, but wants an in-memory reader from the
     `0350` library.
   The lane decides and **states why**. If `0350` landed libarchive (streaming
   first), the temp-dir option is the natural one; say so rather than forcing
   the in-memory path.
4. `openwith` association: `mgpp` → `/bin/mgpp`, plus the desktop/registry entry
   as `0272` did.

## Acceptance

- A RED→GREEN e2e that opens a bundled multi-page deck **containing an image**,
  plus a look-confirm screenshot. Keep to TARGETED browser legs — `os-mgpp.mjs`
  already exists.
- `/bin/mgp` is byte-identical to before this change, demonstrated.
- Zip-slip refused: a `.mgpp` whose members carry absolute paths or `".."`
  must refuse, under test.
- `node tests/run.js --diff` green. Image version bump is **master's to
  assign** — ask.

## Companion, deliberately NOT in this ticket

`netguc/magic` (the MagicPoint PWA) should export/import `.mgpp`. That is a
separate lane in a different repo and this repo's queue does not own it — master
carries it. Two facts recorded so they are not re-derived:

- The **"Zip export of deck+assets skipped (needs a dep)" line in
  `magic/CLAUDE.md` is STALE** and should be corrected whether or not that lane
  runs: `DecompressionStream('deflate-raw')` is native in current browsers, so a
  reader is ~100 lines dep-free, and a STORE-mode writer needs only CRC32 —
  which is the correct choice anyway for already-compressed png/jpg.
- The data model is already shipped: `PUT /api/active` sends flattened
  `{ source, assets:[{name,mime,base64}] }` with a 20 MB cap, and deck sync
  carries a sha256-keyed asset manifest (bodies only for hashes the server
  lacks; 422 `{missing}`). So the PWA half is serialization over a settled
  model.
