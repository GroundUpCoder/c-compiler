# cfgstore.h: cfg_set silently destroyed large config files (R3, todos/0254)

Adversarial-review finding R3, filed P0. `cfg_set` (os/cfgstore.h, the CS3
per-key overlay store behind openwith/screensaver/sounds) read the user-layer
file through ONE bounded `fread(text, 1, CFG_STORE_MAX-1, uf)` — 8191 bytes,
no more-data check, no ferror check — then rebuilt the file from that
snapshot and renamed it over the original. A `~/.config/openwith` larger than
8191 bytes lost every override past the prefix the moment ANY single key was
set: silent, persistent data loss, reproduced at 14,000 bytes (291 of 700
lines destroyed, file truncated to 8207 bytes). Sibling defects: `cfg_load3`
silently truncated an over-cap merged store on the READ side and ignored
read errors too, and the overflow `return -1` in cfg_set didn't set errno
(callers printed a stale "Success").

## The fix — no silent truncation anywhere in the store

- **cfg_set streams.** The rewrite is now an fgets chunk loop user → tmp:
  each chunk copies through verbatim, the key match happens only at line
  STARTS (fgets always delivers a line start with a full buffer of context,
  which is all the match needs — longer lines continue chunk-by-chunk with
  `bol` tracking), the matched line is substituted once (duplicates still
  collapse, the old dedupe), and an unseen key appends after a separator
  newline if the file didn't end in one. **No size cap on the write path at
  all** — the general fix, not a bigger buffer (which would just move the
  cliff). Chosen over the EFBIG-fallback alternative because streaming is
  strictly better and costs no new machinery: same tmp+rename discipline,
  one CFG_STORE_MAX chunk buffer on the stack.
- **A bad read never becomes a rewrite.** ferror on the user-file stream,
  or an existing-but-unopenable user file (fopen failing with anything but
  ENOENT/ENOTDIR — e.g. EISDIR), fails -1/errno and leaves the original
  untouched; the tmp is removed. Pre-fix a failed fread was treated as a
  valid empty-ish snapshot and written back.
- **errno on every -1**: ENAMETOOLONG for an over-buffer key, the failing
  fs op's errno everywhere else (an `err` latch keeps the FIRST failure's
  errno across the cleanup fcloses/remove).
- **cfg_load3 keeps its cap but fails LOUD.** The load side stays a fixed
  caller-owned buffer by design — cfg_find wants the concatenated text, and
  the three wrappers declare `char text[CFG_STORE_MAX]` on the stack — so
  the cap can't just vanish; instead overflow is now -1/EFBIG (+ one stderr
  line), a layer read/open error is -1/that-errno, and in both cases `text`
  keeps the line-boundary-clean prefix that DID load. Truthiness-only
  callers (ow_resolve, sv_get, snd_lookup — all event-driven) thus degrade
  to a valid partial overlay instead of losing the whole store, while the
  error is visible to anyone who checks. Wrapper doc comments updated
  (comment-only) in openwith.h/saver.h/sounds.h.

## Proof

`tests/kernel/test_cfgstore_e2e.js` (registered in the kernel suite): a real
C harness including os/openwith.h — so `ow_set` is the genuine consumer path
— run over a kernel-owned BlockFS. Red→green: pre-fix the 14,000-byte user
file came back 8207 bytes with 291 overrides gone and cfg_load3/errno legs
all red; post-fix 700/700 survive (+15 bytes = exactly the appended key),
mid-file replace keeps the tail, over-cap load is -1/EFBIG with a resolvable
prefix, small-store delta semantics byte-exact, directory-as-user-file
writes nothing. Genuine mid-read fault injection isn't possible in BlockFS,
so the read-error leg rides the EISDIR open path — same never-rewrite guard.

Image v113 → v114 (cfgstore.h bakes into wm.c, fileman, ctlpanel, open,
winmm). Kernel suite 78/78, browser sweep 27/27, compiler.js untouched (no
codegen, no SameBoy interlock).
