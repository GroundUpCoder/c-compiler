# 0398 implementation — the host↔gucOS file transfer seam

Implemented from `todos/0398-host-file-transfer-seam-design.md` (all five
ticket questions pre-decided there — nothing re-opened). Three steps, each
independently landed:

## Step 1 — egress substrate + headless proof

`OP.EGRESS 0x0304`: the wire carries PATHS (the fmt-2 textual list shape,
disposition header word first); the kernel — the fs owner — materializes
bytes exactly once, synchronously in the dispatch. Lone file → its bytes;
lone symlink follows (`realpathPhysical` for a symlink to a dir, so the
artifact keeps the LINK's name while the walk archives the target tree);
directory/multi → ONE store-only zip. `EFBIG` is decided from summed
`lstat` sizes BEFORE any byte is read — the e2e proves that with a SPARSE
300 MB file in an 8 MB memory store (BlockFS holes made the pre-read
refusal testable for free). The zip writer is ~100 lines kernel-side
(CRC-32 + local headers + central directory, Unix external attrs,
`S_IFLNK` entries carrying the target as data); real macOS `unzip`
restores files, empty dirs and symlinks from it (spot-checked, and the
committed test parses the structure with an independent reader).

`boot.js --egress-dir` is the headless twin the design centered on: the
whole seam — RPC, walk, zip, symlink encoding, every errno — is proven in
the kernel suite with no browser. `host.js` maps the disposition int to
the header word (one place per language owns the vocabulary); no kernel →
`ENOSYS`, deliberately no process-local fallback.

## Step 2 — UI + page actor (image v188)

`wm.c` icon-menu Download + `fileman` row-menu Download, both one
`eg_send` over the existing selection walks. The new 30 px row shifted
four pinned menu geometries (ctxmenu `ICON_MENU_H` 164→194, recycle
Delete y 146→176 + h 194→224, wm_service Rename y 176→206) — re-pinned in
the same commit. The page actor acts on artifact ARRIVAL inside the
initiating click's still-live transient activation (the deferred-CLIP_GET
principle, but with NO parking — the data dependency points kernel-ward).
One artifact per gesture means the multiple-downloads permission prompt is
structurally unreachable.

The browser leg (`os-egress.mjs`) drives the icon menu with REAL
`page.mouse` clicks — a `wmctl`-driven click carries no page activation
and would prove nothing — and asserts Playwright's `download` EVENT plus
the saved bytes. Gotcha found: `deskEntries` extras must be
`{name, dir: true}` for directories (dirs sort first in `entcmp`); a bare
string models a file and shifts every derived cell by one — the misplaced
right-click then lands on a launcher's menu where y+146 is DELETE.

## Step 3 — ingress paste (image v189)

The D6 chain, exactly as designed:

- **Chord carve-out** (`os.html`): the paste chord is NOT preventDefaulted
  (that would cancel the browser paste command — the reason a paste event
  could never fire on VT2) and NOT forwarded yet; its keydown (and a
  captured keyup) are held. Files on the paste event → stage → publish →
  forward; text-only → forward at once; no event within ~50 ms → the belt
  forwards anyway (an in-OS-only paste must not die in the carve-out).
- **Staging** (`kernel-worker.js`): `/root/.hoststage`, wiped per host
  paste, published as an ordinary fmt-2 `"copy"` list — so `desk_paste`,
  fileman `IDM_PASTE`, `fo_copy` and the uniquifier all work unchanged,
  and paste-twice re-pastes (copy semantics). Page→worker FIFO makes
  stage-before-consume structural.
- **Shadow-text memo**: Finder puts the pasted file's NAME on the text
  flavor; `clipFromHost` suppresses a read equal to the memo (the
  `clipSynced` rule, one more memo) so the parked consumer's refresh
  can't clobber the staged list. The worker's `clipFreshAt` stamp is the
  belt.
- **Desktop paste chord**: `keys.h` copy/cut/paste rows widened to
  `KCTX_LIST` (both schemes + the named-action registry — the registry
  probe's ctx pin updated with it); `desk_key` dispatches them beside the
  existing select-all case.
- **Directory drops**: `webkitGetAsEntry` walk (readEntries drained in
  batches), per-file `rel` + drop `episode`; the worker uniquifies the
  dropped ROOT once per episode so a folder never merges into an existing
  one.

Test gotcha worth recording: the synthetic file-paste leg first sent only
a `ctrlKey:true` V keydown — and the desktop ignored it. wm.c tracks
modifiers from KEY EVENTS (pointer records carry no mod word, 0077), so
the leg must send the Ctrl keydown first, exactly like the real chord
does (only the V is carved out). The real-browser flow was never broken —
only the synthetic sequence was incomplete.

Automation limits, stated: a real FILE on the host clipboard and a real
OS directory drag are not synthesizable from Playwright — the
os-clipboard leg synthesizes the exact events the browser would deliver
(everything downstream is the product path), and the os-drop tree leg
posts the exact messages the walk produces. gucOS-copy → paste-in-Finder
is PLATFORM-IMPOSSIBLE (no web API writes a file flavor to the host
clipboard); the `"clipboard\n"` disposition stays reserved, per D4.
