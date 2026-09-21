# 0398 — host↔gucOS file transfer seam — DESIGN (companion to `0398-host-file-transfer-seam.md`)

- **Status**: design for the open ticket `todos/0398`; this file is the `-design.md`
  companion (`todos/README.md` §"design docs"), not a second ticket.
- **Written**: 2026-07-28, Fable design pass, off `main` @ `3df5d28f`.
- **Ground truth**: inherited from the ticket (probed at `3bc880da`, re-spot-checked at
  `3df5d28f`) — `0092` fileops clipboard, `0067` drop ingress, ticket-#79 text bridge,
  `0091` icon menu. Everything below that contradicts nothing in the ticket was verified
  against the tree at `3df5d28f`; file:line cites are to that sha.

## The one-paragraph shape

**One egress mechanism, one ingress mechanism, one clipboard-slot bridge rule.**
Egress: processes name **paths** to the kernel (a new `EGRESS` RPC whose payload is the
same textual list shape as `FO_CLIP_FMT=2`); the kernel — which owns the fs —
**materializes bytes exactly once**, kernel-side (lone file → its bytes; directory or
multi-selection → ONE stored zip, symlinks preserved as symlink entries), and hands **one
finished artifact** `{name, bytes}` to an embedder hook. The browser embedder posts it to
the page, which acts inside the still-live transient activation of the gesture that
started the chain (anchor download, or `showSaveFilePicker` for the `saveas`
disposition). The headless embedder (`boot.js`) writes it into a host directory — which
is what makes the seam testable in the kernel suite without a browser. Ingress: the DOM
`paste` event is the only web carrier of host file bytes, so the page carves the host
paste chord out of its swallow-everything keydown handler, stages the pasted files into a
hidden staging dir via the `0067` write path, publishes them on the kernel clipboard slot
as an ordinary `fmt=2 "copy\n"` list, and only THEN forwards the chord — FIFO ordering
makes stage-before-consume structural, and every existing in-OS paste consumer
(`desk_paste`, fileman `IDM_PASTE`, `fo_copy` and its uniquifier) works unchanged.
Clipboard-file-copy **to** the host is platform-impossible and is stated as such below —
the host-bound verb for files is Download.

## D1 — paths vs bytes: the seam speaks PATHS process→kernel, BYTES kernel→page

**Decision: the process→kernel wire carries absolute paths (the `FO_CLIP_FMT=2` textual
shape); materialization to bytes happens exactly once, kernel-side, synchronously inside
the RPC dispatch; bytes exist only on the kernel→embedder→page leg, transferred, never
chunked through the kernel page.**

Why:

- **The kernel owns the fs.** `Kernel({fs: kfs})` holds the MountFS; `kernel.js` already
  reads files for its own purposes (`loadImage`, spawn) and has the full JS-side dir API
  (`fs.opendir`/`readdir`/`lstat`/`readlink` — the `OP.FS_OPENDIR` dispatch at
  kernel.js:3500 uses exactly these). A bytes-carrying RPC would have the *process* read
  the file through brokered `FS_READ` in `KP_FS_CHUNK` slices, then re-chunk the same
  bytes back through the 64KB kernel page a second time — two copies through the choke
  for zero benefit.
- **Directories require a walk with `0092` semantics** (recursion, symlink-as-link).
  Only the fs owner can do that walk atomically-enough and reuse one implementation for
  every caller. A process shipping a directory would need its own tar-shaped framing —
  a second archive format on the wire for no reason.
- **Precedent and shared parsing.** `FO_CLIP_FMT=2` (os/fileops.h:52) already established
  "header word + one absolute path per line" as the file-list lingua franca; the egress
  payload reuses the shape (and the `FO_CLIP_MAX`-class size cap), so the C side is a
  ~20-line helper next to `fo_clip_set`, not a new serializer.
- **Trust is unchanged.** This is a single-user OS; any process can already read
  anything readable via the fs RPCs. Path-egress adds no capability a process didn't
  have — it only adds the boundary crossing, which the kernel mediates.

Materialization policy, decided:

- **When**: at RPC time, synchronously, in the kernel worker (OPFS `SyncAccessHandle`
  reads are sync there; ~256MB worst case is sub-second-to-a-second of blocked kernel
  worker on a user-initiated one-shot — accepted, recorded simplification below).
- **How large is too large**: `EGRESS_MAX = 256 MB` total, summed from `lstat` sizes
  **before any byte is read**, refused as `EFBIG` in the RPC reply (the `DROP_MAX`
  ingress precedent, kernel-worker.js:215, is 128 MB; egress gets 2× because a zip of a
  seeded game dir plausibly exceeds 128 MB). Named constant; if mobile memory pressure
  ever bites, the constant moves — no wire change.
- **Errors are RPC-reply errnos**, found before the reply is sent: `ENOENT` (path or
  dangling lone symlink), `EACCES`, `EFBIG`, `E2BIG` (path list over cap), `EINVAL`
  (bad header / relative path), `ENOSYS` (no embedder hook — standalone host.js pages
  and hookless boots fail LOUD, per the no-zombie-fallbacks rule). Nothing fails after
  acceptance except the page-side act itself (blocked download), which the page logs.

## D2 — the egress RPC and wire format

**Decision: one new RPC, `EGRESS = 0x0304`, in the 0x03xx system block right after
`CLIP_SET`/`CLIP_GET` (0x0302/0x0303) — same block because it is the same kind of thing:
a process↔embedder boundary service, not an fs op.** The strace decode table is the OP
map itself, so `strace` coverage is automatic.

**Request** (RAW, single message — the list is small; cap `EG_MAX = 8192` bytes like
`FO_CLIP_MAX`, `E2BIG` over):

```
"download\n" | "saveas\n"        ← disposition header word
/abs/path\n                      ← one absolute path per line, ≥1
/abs/path2\n
```

Header words are the extension axis: a future disposition is a new word, no format
change. (`"clipboard\n"` is RESERVED for the day the web platform grows a file-flavored
clipboard write — see D4; it is deliberately not implemented now.)

**Reply**: `{errno}` — 0 means the kernel accepted, materialized, and handed the artifact
to the embedder hook.

**Layering** (each layer names its file):

| layer | change |
|---|---|
| C apps (`wm.c`, `os/win32/fileman.c`) | `os/egress.h` — header-only, fileops.h style: `eg_send(int dispo, const char *const *paths, int n)` builds the list (same builder discipline as `fo_clip_set`, os/fileops.h:65) and calls `__egress` |
| libc/env (`host.js`) | new import `__egress(dispo, ptr, len)` beside `createClipboard` (host.js:5872) — kernel present → RPC 0x0304; absent → `ENOSYS` (no process-local fallback: egress without a host is meaningless, and a silent success would be a zombie) |
| kernel (`kernel.js`) | `OP.EGRESS` dispatch: parse, validate, stat-sum, walk + read + (dir/multi) zip via the fs it owns, then `opts.onEgress(dispo, name, bytes)` — **exactly one artifact per call**, always |
| browser embedder (`os/kernel-worker.js`) | `onEgress` posts `{type:'egress', dispo, name, bytes}` with the buffer **transferred** |
| page (`os/os.html`) | `egress` handler: Blob → `dispo==='saveas' && window.showSaveFilePicker` → picker+write, else anchor `<a download>` click + `URL.revokeObjectURL` after the tick |
| headless embedder (`os/boot.js`) | `--egress-dir=PATH` implements `onEgress` by writing `PATH/<name>` (collision-suffixed like `dropFile`); flag absent → no hook → `ENOSYS`. **This is the headless twin that lets `tests/kernel/test_egress_e2e.js` prove the whole seam — RPC, walk, zip, symlink encoding — without a browser.** |

**Artifact naming**: one path that is a file → its basename. One path that is a dir →
`<basename>.zip`. N>1 paths → `gucOS-selection.zip`. Names sanitized with the `dropFile`
basename/control-strip rule (kernel-worker.js:220) inverted for the host direction.

**Entry points now** (the UI): icon context-menu **Download** in `wm.c` (below Copy, acts
on the whole selection set like `CM_CUT`/`CM_COPY`, skips the Recycle Bin icon like they
do) and fileman row-menu **Download** (same rows as Copy). Both are one `eg_send(EG_DOWNLOAD,
paths, n)` call. **Save As / app export**: no new UI this ticket, but the `saveas`
disposition ships in the wire and the page from day one, so wiring an app's export later
is one `eg_send` call — the seam is general now, the entry point arrives with its
first app (that is building the general case, not deferring it: the *capability* is
complete; only additional buttons remain).

## D3 — user activation: the CLIP_GET pattern GENERALIZES; egress needs the principle, not the deferral

The deferred-`CLIP_GET` seam (kernel.js:3044 `onClipRead` → kernel-worker.js:534 →
os.html `clipFromHost`) proved one specific thing: **a real gesture routed through the
canvas keeps its transient activation live across a page↔kernel-worker round trip, so the
privileged page-side act can run at the END of the chain, inside it.** The parked-consumer
*deferral* exists there because the consumer (a paste) needs data that only the page can
fetch — the data dependency points page-ward.

**Decision: the pattern generalizes; nothing replaces it. Egress uses the same
gesture-carries-activation principle but needs NO parking**, because the data dependency
points the other way: the gesture (menu click on the canvas) *initiates*, the kernel
already has everything it needs, and the page act (download / save picker) happens on
arrival of the `egress` message — milliseconds later, far inside the ~5s transient
activation window that the click's trusted DOM event opened. Concretely:

- **`download`**: a synthesized `<a download href="blob:...">` click. Chromium permits
  the first download per interaction even without strict activation; the one-artifact
  rule (zip for multi) means there is never a second programmatic download per gesture,
  so the "multiple automatic downloads" permission prompt is structurally avoided.
- **`saveas`**: `showSaveFilePicker` **strictly requires** transient activation — the
  same chain satisfies it. Where the API is absent (Safari/Firefox), degrade to the
  anchor download **with a console note** — a degradation to the sibling disposition of
  the same seam, not a zombie path.
- **Ingress paste needs no permission at all**: the DOM `paste` event *is* the user's
  activation and carries `clipboardData.files` synchronously. The async-clipboard
  permission machinery is not in this path.
- Test note: headless `wmctl`-driven clicks carry no page activation. The browser-sweep
  leg must drive the Download click via real injected input (`page.mouse`, which grants
  activation in Chromium) and assert via Playwright's `download` event; the kernel-suite
  e2e uses the `boot.js --egress-dir` twin and needs no activation at all.

## D4 — one mechanism? Yes for download/Save-As/export; clipboard-file-copy-to-host is platform-impossible and stated out loud

**Decision: `download`, `Save As`, and any future app export are ONE mechanism with N
entry points** — one RPC, one materializer, one page actor; the disposition word is the
only difference. The ticket's prior holds.

**The third leg — copying a file in gucOS and pasting it in Finder — cannot exist on the
web platform, and this design says so rather than shipping a counterfeit.** This is the
narrow escape hatch, used out loud: the async Clipboard API's `ClipboardItem` write set
is text/plain, text/html, image/png plus `"web "`-prefixed custom formats; **no browser
API can place a FILE flavor on the host clipboard such that a native file manager pastes
a file.** Web-custom formats round-trip only between web apps that opt in — Finder never
will. This is not high-complexity-in-scope work being cut; it is capability the sandbox
does not expose. Consequences, decided:

- `onClipboard` (kernel-worker.js:522) **keeps its `fmt !== 1` filter** — fmt-2 lists
  carry OS-absolute paths that are meaningless outside, and mirroring the *names* as
  host text would be a gimmick that clobbers real host clipboard content.
- The host-bound verb for a file is **Download** (D2). If the platform ever grows a file
  clipboard write, it slots in as the reserved `"clipboard\n"` disposition — the seam is
  already shaped for it, which is the honest version of "designed generally".
- The **reverse** clipboard direction DOES exist (paste events expose files) and is in
  scope — D6.

## D5 — directories: ZIP, one artifact, symlinks preserved as symlink entries

**Decision: a directory (or any multi-path selection) egresses as ONE zip, built
kernel-side, STORE-only (no compression), with symlinks encoded as real symlink entries
(Unix external attrs `S_IFLNK`, target as entry data — the Info-ZIP convention macOS and
Linux unzip both restore).**

Why zip and not the alternatives the ticket names:

- **Refusing directories** would make right-click→Download on a folder a dead menu item —
  a "the easy path only" cut with no platform excuse (unlike D4, nothing prevents it).
- **Multi-file download** (N anchor clicks) hits the multiple-downloads permission
  prompt, loses the directory *structure*, and has no answer for nested dirs at all.
- **Zip** is the single format every host desktop opens natively, carries paths, carries
  symlinks, and needs no process-side help.

Details, decided:

- **Store-only, not deflate**: the writer is ~100 lines of kernel-side JS (CRC32 table +
  local headers + central directory), fully deterministic, no dependency. zlib in this
  tree is process-side C — wrong side of the seam. If payload size ever matters,
  deflate is an *internal* upgrade to the same writer; the wire and hook don't change.
- **Entry paths** are rooted at each root's basename (`zip -r` shape), directories
  emitted as explicit entries so empty dirs survive.
- **Symlink rules preserve the `0092` spirit across the boundary**: *inside* a zip,
  symlinks are symlinks (exactly `fo_copy`'s copy-as-link, os/fileops.h). A **lone**
  symlink egressed by itself follows to its target (downloading a Desktop launcher means
  "give me the thing", and a bare `.symlink` file on the host is meaningless); dangling
  → `ENOENT`.
- **Ingress of directories**: drag-drop grows recursive traversal via
  `webkitGetAsEntry` (the drop path is the one place the platform exposes directory
  trees); staged/pasted relative paths ride the existing `postHostFiles` loop with a
  relative-path field. The paste event **cannot** carry a folder (platform: Finder
  folder-copy exposes no entries to `clipboardData.files`) — stated, not silent: a
  files-empty paste with text falls back to the text path as today.

## D6 — host→gucOS file paste: the chord carve-out, the staging dir, and the clobber guard

The only web carrier of host file **bytes** into a page is the DOM `paste` event
(`clipboardData.files`); `navigator.clipboard.readText` — the existing seam's read — can
only ever see the *text* flavor. Two hard consequences were found by probe:

1. **VT2 swallows the chord.** `screen`'s keydown handler preventDefaults every key
   (os.html:964), which cancels the browser paste command — today a `paste` event can
   never fire on VT2. **Decision**: the page carves the host paste chord (⌘V on the mac
   scheme, ^V otherwise — the page already computes `hostkeys`) out of the swallow: don't
   preventDefault it, don't forward it yet, arm a one-shot. The `paste` event follows in
   the same input sequence:
   - **files present** → for each file, write it through the `0067` ingress machinery
     into a hidden **staging dir `/root/.hoststage`** (wiped and repopulated per host
     paste; `dropFile`'s sanitize/cap policy, no collision suffixes needed since wiped),
     then `kernel.clipSet(2, "copy\n" + staged paths)` (embedder-side clipSet
     deliberately does not fire `onClipboard` — no host echo loop, kernel.js:2314), then
     forward the swallowed chord synthetically.
   - **text only** → forward the chord; the existing deferred-`CLIP_GET` refresh path
     serves it exactly as today.
   - **belt**: if no `paste` event follows the armed chord within one short timeout
     (~50ms), forward the chord anyway — an in-OS-only paste (gucOS fmt-2 copy, empty
     host clipboard) must not die in the carve-out.

   Because page→worker messages are FIFO, the staging writes and the `clipSet` land
   **before** the chord reaches the focused app — the same FIFO-ordering idiom
   `clip-read-done` already relies on ("any slot update arrived just before this on the
   same FIFO channel", kernel-worker.js:183). The focused app then pastes via the
   **unchanged** `0092` machinery: fileman's `^V` accelerator → `IDM_PASTE`, or the
   desktop — which today has NO paste chord (probed: `desk_key`, os/wm.c:2690, handles
   only F2/Esc/Enter/select-all/Del/arrows) — gains `KA_PASTE` (and `KA_COPY`/`KA_CUT`
   for symmetry) rows for `KCTX_LIST` in the os/keys.h scheme table, dispatched in
   `desk_key` exactly like the existing `KA_SELECT_ALL` case. Paste-twice re-pastes
   (copy semantics; staging persists until the next host paste). All `0092` semantics —
   recursive `fo_copy`, the `"Copy of X"` uniquifier on clash, cut-pastes-once for in-OS
   cuts — apply untouched because the staged list IS an ordinary fmt-2 copy list.

2. **The Finder text shadow would clobber the staged list.** Copying a file in Finder
   also places the file *name* as the text flavor. After a file paste, the focused app's
   `CLIP_GET` parks on `onClipRead` → the page `readText`s → gets the filename text →
   would `clipSet(fmt 1)` **over the staged fmt-2 list** before `_clipServe` runs.
   **Decision — the shadow-text memo**: at file-paste time the page records
   `clipboardData.getData('text/plain')` as `clipShadow`; `clipFromHost` suppresses a
   read result equal to `clipShadow` (exactly the existing `clipSynced` dedup rule, one
   more memo). Belt: the worker's host-files handler stamps `clipFreshAt` so the
   immediately-following refresh short-circuits in the fresh window. The memo is the
   load-bearing guard (timing-free); the stamp is the cheap fast path.

Menu-driven Paste (fileman Edit▸Paste, ctx Paste) has **no** paste event and therefore
can never see host files — platform, same class as D4, stated: those paths paste
whatever the gucOS slot holds, exactly as today. Host-file ingress requires the paste
*keystroke*, a drop, or the upload button.

## What does NOT change (the 0092 non-regression list)

- `os/fileops.h` — untouched. Egress is read-only; ingress publishes an ordinary fmt-2
  copy list. `fo_copy`/`fo_move`/uniquifier/cut-once/symlink-as-link all exercise their
  existing code paths.
- The kernel clipboard slot, `CLIP_SET`/`CLIP_GET`, the fmt-2 format — untouched.
- The text bridge (#79) — untouched except the page-side `clipShadow` memo (a filter
  added beside `clipSynced`, same shape) and the chord carve-out (which forwards the
  same events it forwarded before, minus double-delivery of the paste chord).
- `0067` drop/upload ingress — extended (directory traversal, shared staging writer),
  not replaced; `/root/Desktop` remains the drop destination.

## Implementation sequence (agreeing with the ticket: egress first)

1. **Egress substrate + headless proof** — `OP.EGRESS` + materializer + zip writer in
   kernel.js; `__egress` in host.js; `os/egress.h`; `boot.js --egress-dir`;
   `tests/kernel/test_egress_e2e.js` (C caller; asserts file bytes, zip structure,
   symlink entries, EFBIG/E2BIG/ENOENT/ENOSYS). No page code yet — the seam is proven
   end-to-end headless. *(Egress first is right: no staging, no chord gymnastics, and
   the headless twin makes it the cheapest full-depth proof of the seam.)*
2. **UI + page actor** — wm.c icon-menu Download + fileman Download; os.html `egress`
   handler (anchor + saveas picker); browser leg (new `os-egress.mjs` or a leg in
   `os-fileman.mjs`) driving via `page.mouse`, asserting the Playwright download event.
3. **Ingress paste** — chord carve-out + staging + shadow memo + `KCTX_LIST`
   paste/copy/cut rows + `desk_key` dispatch; extend `os-clipboard.mjs` with a
   file-paste leg (CDP `Input.dispatchKeyEvent` + a synthesized paste with files, or
   drive via the `__osClipSync`-style probe pattern); drop-directory traversal.
4. **Flake gate** (`node tests/flake.js`) after the new e2es, per the estate rule.

Steps 1–2 are independently landable; 3 is separable behind them. jku pre-authorized
Fable for implementation where the seam is subtle — the subtle parts are step 1's
materializer/zip and step 3's carve-out+memo; step 2 is routine.

## Image bump

**Owed at implementation time, not by this design pass** (which changes only `todos/`).
`wm.c` and `fileman.c` are baked binaries → `os/image.json` version bump owed when they
land (steps 2–3). `os.html`/`kernel-worker.js`/`kernel.js`/`host.js` are static assets —
no bump for those alone, but step 2 touches wm.c anyway, so the bump lands with step 2
and again with step 3 if separately committed.

## Recorded simplifications (deliberate, not hidden)

- Materialization is synchronous in the kernel worker; `EGRESS_MAX = 256 MB` is the
  guard. Streaming egress would change the hook shape and is not owed until a real
  consumer exceeds the cap.
- Store-only zip; deflate is an internal upgrade.
- Host-side Finder *cut* (paste-moves) semantics are not detectable from a paste event;
  host paste is always a copy.
- iOS/Safari: `showSaveFilePicker` absent → anchor download; paste events on iOS carry
  files from the share-sheet/Files flows where Safari provides them — untested tier,
  the upload button remains the guaranteed mobile ingress.

## Left undecided, with the measurement that settles it

- **None of the five ticket questions.** One tuning constant: whether `EGRESS_MAX`
  should be lower on mobile — settled by measuring peak kernel-worker memory during a
  256 MB egress on an iPhone (the `0385` Safari-throttle rig); until then the desktop
  constant stands.
