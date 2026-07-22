# 0275 design — ksvc: the kernel-C service blob (text rendering first)

- **Status**: design COMMITTED (this doc; branch ksvc-design, 2026-07-22).
  Direction settled by the user in `todos/0275-kernel-text-service.md` — this
  doc nails the ABI / caching / build / integration details against the real
  code and records the feasibility spike result. The implementation is a
  follow-on thread that executes §12 top to bottom.
- **Feasibility spike**: **GO** — see §2. Spike code committed at
  `os/ksvc/` (`ksvc.c`, `bin.json`, `spike/`).

## 1. Shape summary

One growable kernel-side wasm blob, `/usr/lib/ksvc.wasm`, built at bake time
from `os/ksvc/` by OUR compiler (the same `buildProject` pipeline every
manifest `project` entry uses), instantiated synchronously IN the kernel's
thread (kernel-worker.js in the browser, boot.js under Node) over a minimal
read-only import env that calls `kfs` directly — no process, no pcb, no RPC,
no host.js/runModule. Its first capability is label text: FreeType +
`fontchain.h`, replacing compositor.js `labelFor()`'s Canvas2D path (which is
DELETED) and adding title text to the headless composite
(`wmScreenshotScreen`) in the same change.

```
             bake time                         boot time
 os/ksvc/ksvc.c ──buildProject──▶ /usr/lib/ksvc.wasm ──kfs.read──▶
   + vendor/freetype                (in the sealed                 OS_KSVC.load(kfs)
   + os/fontchain.h                  system image)                   │ (sync instantiate,
                                                                     │  env over kfs)
                                                     ┌───────────────┴───────────────┐
                                              Kernel({textService})           compositor.js
                                              wmScreenshotScreen text         labelFor → render
                                              (headless composite)            → writeTexture
```

## 2. Feasibility spike — RESULT: GO

The make-or-break question was whether our compiler can build FreeType into a
blob that instantiates standalone and rasterizes. Answer: **yes, proven end
to end**, and cheaper than feared because FreeType 2.14.1 is ALREADY vendored
and compiled by this compiler for term/wm/gdi32 — the new ground was
standalone instantiation with a minimal env, and it holds:

- `os/ksvc/bin.json` (deps `vendor/freetype/lib.json`, the exact term.c/
  menucore.json include pattern) builds via `OS_COMMON.buildProject` to a
  **269 KB** wasm module. No compiler bugs hit.
- The module instantiates with `new WebAssembly.Instance(mod, {c: env})`
  where env is a **~40-line hand-rolled object** (§5) — no host.js, no
  runModule, no heap-init handshake (`malloc` self-initializes from
  `__heap_base`).
- `ksvc_init` + `FT_New_Face` + `FT_Load_Glyph` + `FT_Render_Glyph` produce a
  correct antialiased 12×14 'A' at 20 px from NotoSansMono-Regular.ttf.
- The live import set on the whole path is just `__open_impl`/`read`/
  `lseek`/`close` — every other import stub never fired…
- …except one, deliberately provoked: `fontchain.h`'s `fc_load` works
  verbatim inside the blob, and its `snprintf("%s", …)` lowers onto the
  **`vsnprintf` host import** (libc's printf family is host-implemented in
  this compiler). A ~15-line `%s`-only formatter in the env satisfies it
  (§5.3). Confirmed live: `fc_load` returned the fallback line planted in
  the spike's fakeroot.
- `FT_GlyphSlot_Embolden` works (`ftsynth.c` is already in
  `vendor/freetype/lib.json`); the emboldened 'B' is visibly heavier than
  the regular 'R'. Default strength at 20 px is on the heavy side — tune at
  look-confirm (§10).

Repro: `cd os/ksvc/spike && node build.js && node run.cjs` (Node-fs stands in
for kfs; `fakeroot/` maps `/etc`+`/usr`). The spike `ksvc.c` is the seed the
implementer grows into the real blob.

## 3. Blob shape & build

**Layout** (`os/ksvc/`):

```
os/ksvc/
  ksvc.c        the service blob: init + text capability (grows by adding
                capabilities as new TUs or sections here)
  bin.json      { deps: ["../../vendor/freetype/lib.json"],
                  includes: ["../../vendor/freetype/demo",
                             "../../vendor/freetype/include"],
                  sources: ["ksvc.c"] }
  spike/        the committed feasibility spike (build.js, run.cjs, fakeroot/)
```

- `includes` pulls `vendor/freetype/demo` for `ft2build.h` +
  `myftoption.h`/`myftmodule.h` — the SAME stripped module set term/gdi32
  use (TT-only, smooth renderer, no hinter). Coverage/rendering therefore
  cannot diverge from the rest of the estate by construction.
- `ksvc.c` includes `../fontchain.h` verbatim (one mechanism, one place).
- The compiler requires a `main`; the blob carries `int main(void){return 0;}`
  (never called — kernel JS calls the `__export`ed entries directly).
  Exports are declared with the compiler's `__export name = name;` directive.

**Bake + seed**: one `image.json` change —

```json
"dirs":  [..., "/usr/lib"],
"files": { "/usr/bin/…": …,
           "/usr/lib/ksvc.wasm": { "project": "os/ksvc/bin.json" }, ... }
```

plus `version` bump (138 → 139 as of this writing — take current+1 at land
time). That's the ENTIRE build story: browser bake, boot.js bake, mkimage,
serve.js, and the test image fixture all flow through `seedEntries`'
`project` handling; `newestBakeInput`'s os/-tree + project-closure scan makes
`os/ksvc/*` and the freetype dep staleness-tracked with zero changes. Bake
cost: one more freetype compile (~the term/wm precedent), boot-bake only.

## 4. ABI (wasm exports)

All functions `__export`ed from `ksvc.c`. Pointers are u32 offsets into the
blob's exported `memory`. Everything is synchronous, single-threaded,
kernel-thread-only — no locks, no reentrancy (a ksvc call never calls back
out except through the env imports).

| export | signature | semantics |
| --- | --- | --- |
| `ksvc_abi` | `(void) -> int` | ABI version, starts at **1**. The JS wrapper asserts equality and throws on mismatch — the growable-blob discipline: capability additions that keep old signatures keep the number; breaking changes bump it in blob and wrapper together (same repo, same commit — the assert exists to catch a stale cached image pairing with newer JS, which the image version gate should already prevent; belt + braces). |
| `ksvc_init` | `(void) -> int` | `FT_Init_FreeType` + `fc_load()` (fontchain.h) + EAGER face-0 open: `/etc/fonts/mono.ttf` else `/usr/share/fonts/mono.ttf`. Returns 0, or a negative code (−1 FT init, −2 no face 0) — callers treat nonzero as fatal (§11). Eager face 0 is deliberate: a boot that can't render chrome text must fail AT BOOT, not at first title. Chain faces stay lazy (the gdi32/term discipline). Config is read here, once — font-package installs reach the chrome at next boot (per the settled item; a re-init export is a cheap follow-up if that grates). |
| `ksvc_buf` | `(int len) -> ptr` | Blob-owned input staging buffer, grown (realloc) to ≥ len, never freed. The wrapper copies UTF-8 text here before measure/render. Why not `alloca`: the exported alloca bumps the wasm stack and never pops outside `main` — per-frame use would leak the stack. Why not export malloc/free: one persistent scratch is simpler and matches the call pattern (one text at a time, synchronous). |
| `ksvc_text_measure` | `(ptr utf8, int len, int px, int flags) -> int` | Advance-sum width in px of the WHOLE string at pixel size `px` (no maxW, no ellipsis). Uses the same glyph pipeline as render — embolden (flags bit 0) affects advances, so measure and render agree by construction. Unknown codepoints measure at tofu width (cell × wcwidth, the gdi32 rule). |
| `ksvc_text_render` | `(ptr utf8, int len, int px, int maxW, unsigned rgba_fg, int flags) -> ptr` | Rasterize into a blob-owned pixel buffer; returns a pointer to a 16-byte header `{ i32 w; i32 h; i32 stride; i32 reserved }` immediately followed by `h` rows of `stride` (= w·4) bytes RGBA. Returns 0 only on internal failure (OOM) — empty text returns a header with w=0. **Ownership**: the buffer belongs to the blob and is valid until the NEXT `ksvc_text_render` call; callers consume (writeTexture / blit) immediately. **Alpha**: STRAIGHT (non-premultiplied) — `rgb = fg.rgb` at every pixel, `a = coverage · fg.a / 255`. That is exactly what both consumers want: the WebGPU pipeline blends `src-alpha / one-minus-src-alpha` (compositor.js:113), and the headless composite reuses kernel.js's 0063 integer src-over formula. `rgba_fg` is packed 0xRRGGBBAA. **Height**: `h` = face-0 ascent+descent at `px` (≈28 at 20 px — the v133 `tmHeight 28` rhythm), baseline at ascent; constant per px so labels of different strings align. **Ellipsis**: if the measured width exceeds `maxW`, the string is truncated to the longest prefix such that prefix + `…` (U+2026, chain-probed; "..." from face 0 if some exotic config lacks it) fits, replacing fillText's maxWidth squish. If even `…` alone exceeds `maxW`, glyphs hard-clip at `maxW`. `w` in the header is the ACTUAL rendered width ≤ maxW — the caller sizes its quad from the header, never from its own arithmetic. |

`flags`: bit 0 = bold (FT_GlyphSlot_Embolden, strength tuned in-blob, §10).
Other bits reserved, must be 0.

**Font discipline inside the blob** — the exact `font_glyph`/`cp_glyph`
discipline, restated as requirements (implementation is self-contained in
ksvc.c, see §14 for the tri-plication note):

- Face 0 = `/etc/fonts/mono.ttf` > `/usr/share/fonts/mono.ttf`; fallbacks =
  `fc_load()` order; faces 1..n opened LAZILY at first codepoint miss, at the
  needed pixel size; a face that fails to open is marked dead and skipped.
- Codepoint → face: `FT_Get_Char_Index` on face 0 first (ASCII ≤126 always
  renders from face 0, glyph 0 included — the pre-chain contract), then the
  chain in order, first nonzero wins.
- Total miss → the synthesized tofu box (outlined rect, cell × wcwidth(cp)
  wide — port `glyph_tofu`; `os/wcwidth.h` already exists), never '?'.
- Per-(px,flags) size slot with the gdi32 cache shape: flat `[95]` ASCII
  array + linear-scan side cache of rendered A8 glyphs + advances. In
  practice only (20, bold) is ever hot today, but `px`/`flags` stay in the
  ABI — the cache is keyed to match.
- UTF-8 decode: the `__u8_next` loop (same one gdi32/term use).

## 5. Instantiation & the import env

### 5.1 Who loads, and when

- **Browser** (`os/kernel-worker.js`): after `kfs` is constructed
  (kernel-worker.js:401) and BEFORE the `Kernel` ctor —
  `var textService = OS_KSVC.load(kfs);` inside the boot() try-chain; any
  throw becomes the existing `boot-error` path (§11). `ksvc.js` joins the
  `importScripts` list.
- **Node** (`os/boot.js`): same position — after the MountFS (boot.js:265),
  before `new K.Kernel` (boot.js:282). A throw fails the boot loudly.
- Both pass it to the kernel: `new Kernel({ ..., textService })`; the kernel
  stores it as `this.textService` (public — the compositor reads it there,
  one source of truth).
- Every kernel e2e boots through `os/boot.js` (tests/kernel/lib/drive.js),
  so the whole e2e estate gets text with these two edits. Bare-`Kernel`
  unit tests (test_wm.js's fake-worker kernels, no fs) pass no
  `textService` and keep the pre-0275 textless composite — that is
  capability ABSENCE in a non-OS embedder (nothing to read a font from),
  not a fallback renderer; the OS boot path can never reach that state
  because both loaders hard-fail first.

### 5.2 The env — explicit, minimal, loud

`WebAssembly.Module.imports()` of the spike blob is the authoritative list;
all imports live in module `"c"`. The env is written out EXPLICITLY in
`os/ksvc.js` (not generated, not borrowed from runModule) because the kernel
service boundary is deliberately narrower than a process: read-only fs, no
write path, no processes, no signals, no timers.

Live implementations (over `kfs` — `BLOCK_FS.MountFS` verified to carry this
exact method surface):

| import | impl |
| --- | --- |
| `__open_impl(p,f,m)` | `kfs.open(readCStr(p), flags, mode)`; **write-intent flags (O_WRONLY/O_RDWR/O_CREAT/O_TRUNC/O_APPEND) are refused with EROFS** before reaching kfs — the service is read-only by construction, on every volume. null → −1 + errno. |
| `read(fd,buf,n)` | `kfs.read(fd, new Uint8Array(mem.buffer, buf, n), n)` — fresh view per call (memory.grow detaches). |
| `close(fd)` | `kfs.close(fd)` |
| `lseek(fd,off,wh)` | `kfs.lseek(fd, Number(off), wh)`, returns BigInt (i64 boundary; −1n + errno on null). |
| `access(p,m)` | `kfs.access(path, mode)` (fontchain probes are fopen-based today, but access is in the import set — implement it real, it's one line). |
| `write(fd,buf,n)` | fd 1/2 ONLY: decode and forward to the kernel `log` hook, prefixed `[ksvc]` (FreeType/libc error chatter becomes boot-log lines). Any other fd: loud throw. |
| `vsnprintf(buf,size,fmt,ap)` | mini-formatter, §5.3. |
| `getpid` | `() => 0` |
| `__time_now/__clock/__clock_ns_hi/__clock_ns_lo/__timezone_offset` | trivial real impls (Date/performance — nothing on the text path reads them, but time is harmless and honest). |
| `__errno_set` (export, not import) | fs failures map kfs's error name through a small local table (ENOENT 2, EIO 5, EBADF 9, EACCES 13, EINVAL 22, EROFS 30 — verify numbers against the compiler's errno.h at impl time) and call `instance.exports.__errno_set`. |

Loud traps — `() => { throw new Error('ksvc env: <name> is not part of the
kernel service surface'); }` for: `remove, mkdir, pipe, __spawn,
__spawn_wait, __spawn_kill, __exit, __vsscanf_impl, __strtod_impl,
__strtof_impl, __on_sigdisp, __on_sigmask, __sig_pause, __setitimer,
__getitimer`. The spike proved none fire on the live path; if a future
capability pulls one for real, the trap names it and the implementer
promotes it CONSCIOUSLY.

**New-import failure mode**: if a blob change adds an import the env lacks,
`new WebAssembly.Instance` itself throws naming the import — a loud
boot-error, never silent. Do NOT "complete" the env speculatively; grow it
import-by-import with the blob.

### 5.3 The vsnprintf import

This compiler implements the printf family HOST-SIDE; `snprintf` in C lowers
onto the `vsnprintf` import (spike-confirmed: adding `fc_load` added no new
import but made `vsnprintf` live). runModule's `formatString` is closure-
bound inside host.js and NOT worth extracting for this. The ksvc env carries
a mini-formatter: `%s` (the only conversion on the live path — fc_load's
bounded copy), plus `%d/%u/%x/%c/%%` for margin, **loud throw on anything
else** (`ksvc env: vsnprintf fmt "%…" unsupported`). va_list ABI
(spike-verified): `ap` is a pointer to a u32 slot holding the varargs base;
args are consecutive 4-byte slots from there.

## 6. The JS wrapper — `os/ksvc.js`

Dual-environment like os-common.js (`self.OS_KSVC` under importScripts,
`module.exports` under Node). Surface:

```js
OS_KSVC.load(kfs, { log }) -> service   // THROWS on any failure:
  // read /usr/lib/ksvc.wasm via kfs (readFileBytes), new WebAssembly.Module,
  // new WebAssembly.Instance with the §5 env, assert ksvc_abi() === 1,
  // assert ksvc_init() === 0.

service.measure(text, px, flags) -> int          // encode UTF-8 → ksvc_buf → ksvc_text_measure
service.render(text, px, maxW, rgba, flags) ->   // → ksvc_text_render
  { w, h, bytes }   // bytes: Uint8Array VIEW into blob memory (fresh per
                    // call — memory.grow detaches old views), w·h·4 RGBA,
                    // straight alpha, VALID UNTIL THE NEXT render() —
                    // consume immediately (writeTexture / blit), never store.
```

One TextEncoder instance; texts are titles (≤ ~hundreds of bytes). No JS-side
caching here — callers own their caches (§7, §8): the wrapper is a dumb
boundary.

## 7. Browser compositor integration (compositor.js)

`startCompositor(kernel, canvas, device)` — first lines gain:

```js
var svc = kernel.textService;
if (!svc) throw new Error('compositor: kernel has no text service (ksvc)');
```

(unreachable in a real boot — kernel-worker already hard-failed — but the
compositor states its requirement; no quiet textless desktop can exist.)

`labelFor` is REWRITTEN (the whole `LABEL_FONT`/`labelCanvas`/`labelCtx`
block deleted):

```js
var LABEL_PX = K.WM_LABEL_PX;            // 20 — shared-chrome rule, §8
var labels = new Map();                   // rgba|w|text -> { tex, bind, w, h }
function labelFor(text, maxW, rgba) {
  var w = Math.max(1, Math.min(svc.measure(text, LABEL_PX, 1), Math.ceil(maxW)));
  var key = rgba + '|' + w + '|' + text;
  var c = labels.get(key);
  if (c) return c;
  if (labels.size >= 96) { labels.forEach(function (v) { v.tex.destroy(); }); labels.clear(); }
  var r = svc.render(text, LABEL_PX, Math.ceil(maxW), rgba, 1 /* bold */);
  var tex = device.createTexture({
    size: { width: Math.max(1, r.w), height: r.h }, format: 'rgba8unorm',
    usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
  });
  if (r.w) device.queue.writeTexture({ texture: tex }, r.bytes,
    { bytesPerRow: r.w * 4 }, { width: r.w, height: r.h });
  c = { tex: tex, bind: bindFor(tex), w: r.w, h: r.h };
  labels.set(key, c);
  return c;
}
```

Notes, all deliberate:
- The measure-first cache key (`min(measure, maxW)`) preserves today's
  behavior where a short title doesn't churn the cache as maxW slides
  during a resize drag; measure is a sub-ms warm-cache wasm call, replacing
  the per-call `measureText` 1:1.
- `RENDER_ATTACHMENT` usage drops (writeTexture only — the
  copyExternalImageToTexture requirement dies with the canvas).
- Straight-alpha bytes + the existing `src-alpha` blend = correct output;
  the premultiply ambiguity of the canvas upload path is gone.

Call sites:
- `:685` close box → `labelFor('x', 32, 0x000000FF)`; quad y uses `xg.h`:
  `by + K.WM_CLOSE_W/2 + 1 - xg.h/2`, quad height `xg.h`.
- `:687` title → `labelFor(title, maxW, 0xFFFFFFFF)`; quad at
  `(s.x + 6, s.y - K.WM_TITLE_H/2 - tl.h/2, tl.w, tl.h)`.
- `:437` Exposé caption → `labelFor(cap, Math.max(8, c.w), 0xFFFFFFFF)`;
  quad at `(c.x + (c.w - cap.w)/2, c.y + c.h + 2, cap.w, cap.h)`.
- `LABEL_H` the constant dies; heights come from the render header (≈28 at
  20 px, the same rhythm).

**Acceptance grep** (the 0275 acceptance line): after this,
`grep -n "getContext('2d')\|measureText\|fillText\|OffscreenCanvas" os/compositor.js`
returns NOTHING.

## 8. Headless composite (kernel.js)

- New shared constant `WM_LABEL_PX = 20` beside WM_TITLE_H (exported on
  KERNEL like the other WM_* metrics) — both composites read the ONE
  constant.
- `Kernel` ctor: `this.textService = opts.textService || null;`.
- New private helper (used ONLY by wmScreenshotScreen):

```js
Kernel.prototype._blitLabel = function (out, W, H, x, y, text, maxW, rgba) {
  if (!this.textService) return;                  // non-OS embedder: no text
  var r = this.textService.render(text, WM_LABEL_PX, Math.ceil(maxW), rgba, 1);
  // integer src-over, the exact 0063 hasAlpha formula, clipped to W×H
  ...
};
```

- `wmScreenshotScreen` additions (all inside the existing loops):
  - title text: after the title-strip fill —
    `_blitLabel(out, W, H, s.x + 6, s.y - WM_TITLE_H/2 - h/2, title, maxW…)`
    with the SAME title string expression (`s.title || 'pid '+s.pid`) and
    the SAME maxW arithmetic as compositor.js (lift both into one shared
    helper or mirror them EXACTLY — they are the contract).
    Since `h` comes from the render, `_blitLabel` computes y internally
    from a `centerY` param — cleanest: pass `centerY = s.y - WM_TITLE_H/2`
    and let the helper center. Compositor should mirror (quad y =
    centerY - h/2) so the two composites place text identically.
  - close 'x': `_blitLabel(centerX-ish at bx + 5, centerY = by + WM_CLOSE_W/2 + 1, 'x', 32, 0x000000FF)` — matching :685/:686.
  - overview captions: in the `_wmOverview` branch, after each cell blit —
    same centered-under-cell formula as compositor :438. The comment
    "captions are browser-only" dies with the code; the overview divergence
    left is furniture (shadows/rounded corners), which stays browser-only
    by the 0063 design.
  - The header comment at :5719 ("text is a browser-compositor
    affordance") is REWRITTEN to describe the ksvc rule.
- Determinism: blob bytes are identical everywhere (one seeded file), the
  rasterizer is pure integer/fixed-point over them, and the integer blend
  is the deterministic 0063 formula ⇒ headless composites are bit-exact
  across environments (Node, browser worker, CI) by construction. Browser
  vs headless overall frames still differ (AA chrome, shadows, glass —
  0063 browser-only affordances); the 0275 claim is TEXT parity: same
  strings, same rasterizer, same geometry in both.

## 9. Fonts & coverage parity

- Face 0 + chain + lazy open + tofu = §4; `fc_load` verbatim ⇒ the chrome
  reads THE SAME `/etc/fonts/fallback` overlay as gdi32/term, so a gucman
  font-package install (which plants `/etc` layer lines + `/opt` files)
  reaches titles at next boot with zero ksvc-specific plumbing.
- CJK titles: with `font-noto-cjk-mono` installed, the chain probe finds
  NotoSansMonoCJKjp-VF (the VF face already proven under this freetype
  build by Phase D); without it, honest tofu — matching gdi32/term on the
  same image, which is the acceptance bar.
- Deploy verification step (§12): the LIVE apex package set must include
  `font-noto-cjk-mono` + `font-unifont` (both exist in `packages/`; the
  base image ships 12 packages — verify with `gucman list` on the deployed
  image, install if the set lacks them, per the acceptance "real installs
  render CJK titles").

## 10. Behavior details

- **Ellipsis** replaces the squish — §4 render contract. Titles that fit are
  pixel-for-pixel un-truncated; overlong titles end in `…` inside maxW.
- **Bold**: flags bit 0 on ALL current labels (titles, 'x', captions) —
  parity with `'bold 20px sans-serif'`. Strength: spike shows stock
  `FT_GlyphSlot_Embolden` at 20 px is heavier than browser bold; implement
  via `FT_Outline_EmboldenXY(&slot->outline, xstr, ystr)` with strength a
  `#define KSVC_BOLD_STR` starting at HALF the ftsynth default
  (ftsynth's is `units_per_EM·y_scale/24`; start at `/48`), then tune at
  the look-confirm against the v133 20 px chrome rhythm. Bitmap-only chain
  faces (unifont): embolden doesn't apply to bitmaps — render regular
  (FT_GlyphSlot_Embolden's bitmap branch exists but keep it simple; note
  in code).
- **Metrics**: strip h = ascent+descent of face 0 at px (≈28 @ 20 px — the
  v133 `tmHeight 28`); glyphs from chain faces baseline-align at face-0's
  ascent (the term/gdi32 rule: one baseline, face 0's).

## 11. Failure modes — loud, no zombies

- Blob missing / unreadable / instantiation throw / `ksvc_abi` mismatch /
  `ksvc_init` nonzero:
  - kernel-worker.js: `post({type:'boot-error', msg:'ksvc: …'})`, boot stops
    (the boot-nogpu/boot-error precedent; nothing mounted stays mounted —
    it fails inside boot()'s existing try/catch).
  - boot.js: bootLog + throw ⇒ nonzero exit.
- The Canvas2D path (LABEL_FONT, labelCanvas, labelCtx, fillText,
  measureText, the OffscreenCanvas) is DELETED, not gated. The compositor
  additionally throws at startup if `kernel.textService` is absent (§7).
- Runtime render failure (OOM inside the blob → render returns 0): the
  wrapper THROWS — a broken text service is a broken compositor, surfaced
  on the boot log by the frame loop's error, not painted around.
- Env traps (§5.2) name the import; unexpected fs writes are EROFS'd.

## 12. Implementation plan (for the follow-on Fable thread)

Ordered; each step names its files. Land as ONE reviewed change (series of
commits on one branch is fine) so browser text and headless text never
diverge — the sequencing rule in the item.

1. **Grow `os/ksvc/ksvc.c` into the real blob** (from the spike seed):
   the §4 ABI (`ksvc_abi`, `ksvc_init`, `ksvc_buf`, `ksvc_text_measure`,
   `ksvc_text_render`), fontchain + lazy chain faces + tofu + per-(px,flags)
   glyph caches + UTF-8 walk + ellipsis + embolden. Delete the
   `ksvc_spike_*` exports (keep `spike/` as-is — it pins the feasibility
   record; point spike/run.cjs's asserts at the real exports or freeze it
   with a README line saying it targets the seed commit).
   Files: `os/ksvc/ksvc.c`, `os/ksvc/bin.json` (unchanged deps).
2. **Write `os/ksvc.js`** (§5 env + §6 wrapper, dual-environment).
   Standalone smoke: a Node script over a baked fixture image (mount via
   BLOCK_FS, load, render 'winbox', assert w/h/nonzero alpha).
3. **kernel.js**: `WM_LABEL_PX`, `opts.textService` → `this.textService`,
   `_blitLabel`, the three wmScreenshotScreen call sites, comment rewrite
   (§8). KERNEL.md: kernel-page/opcode sections untouched (no RPC, no page
   change), but ADD the ksvc service seam section (§13).
4. **compositor.js**: §7 rewrite. Run the acceptance grep.
5. **Loaders**: kernel-worker.js (importScripts + load + boot-error +
   ctor opt), boot.js (require + load + ctor opt).
6. **image.json**: `/usr/lib` dir + `/usr/lib/ksvc.wasm` entry + version
   bump (current+1).
7. **Tests** —
   - New `tests/kernel/test_ksvc_e2e.js`: boot the fixture image via
     driveBoot, `winbox &`, `wmctl shot` → assert title-region text pixels
     exist (non-navy pixels in the title strip left of the boxes) AND the
     strong form: render "winbox" via os/ksvc.js directly over the same
     image and bit-compare against the composite's title strip (the
     honest same-bytes assertion). Add an overlong-title leg (ellipsis:
     rightmost text column < maxW edge) and a CJK leg
     (tofu without the package; extend `test_fontpkg_e2e.js` with a
     real-glyph title leg with it — winbox grows an optional
     `winbox title <utf8>` arg if no seeded app can carry a CJK title;
     that's a 5-line winbox.c change, note it in the commit).
   - Register in `tests/kernel/run.js` (explicit registry — the 0264
     lesson) and add a `RULES` entry in `tests/run.js` mapping
     `os/ksvc/**` + `os/ksvc.js` → kernel + sweep suites (UNMAPPED is the
     tripwire otherwise).
8. **Gate**: `node tests/run.js --diff` first, then the full
   `node tests/kernel/run.js` and `node tests/browser/os-sweep.mjs`
   (foreground, separate calls under the 600s ceiling, `--resume` on
   overrun). Triage pixel-sample failures: known candidates are
   tests sampling title strips where text now lands headless —
   tests/kernel/test_wm.js:558 is a bare-Kernel unit test (NO textService
   ⇒ unchanged, do not touch); e2e/browser samples like
   tests/browser/os-wm.mjs:86 (WX+150 — past "winbox"'s ~78 px text end,
   expected to hold). For every assertion that DOES move: dump the
   composite (PPM via wmctl shot / drawImage probe), LOOK at it, confirm
   the new pixels are correct text (the v133 rule: verify visually before
   re-blessing any expected value), then update the assertion.
9. **Flake pass**: `node tests/flake.js` (new e2e landed).
10. **Look-confirm** (the Phase C/D precedent): boot the browser OS, eyeball
    titles/'x'/captions at 20 px vs main — weight (tune `KSVC_BOLD_STR`),
    baseline, ellipsis behavior on a long-titled window, CJK title with the
    font package installed. One combined confirm is fine.
11. **Docs**: dev log `logs/2026-07-XX/ksvc-text.md`; update
    `todos/OS.md`/`WM.md` pointers where they say title text is
    browser-rendered (WM.md deviations + the headless-composite notes);
    close out per queue.js discipline.
12. **Deploy** (after master merges): the comguc worktree-build → verify →
    deploy.mjs recipe; image version bumped ⇒ browser clients re-fetch the
    blob. Verify live: titles render, `gucman list` includes
    font-noto-cjk-mono + font-unifont (install if the live set lacks them),
    CJK title spot-check.

## 13. The service seam, documented (goes into KERNEL.md)

ksvc is the kernel's C half: capabilities the kernel needs that are best
written in C land as new `__export`s on THIS blob (`os/ksvc/ksvc.c`),
loaded once per boot by the embedder via `OS_KSVC.load(kfs)` and reached
synchronously through `kernel.textService`-style handles. Rules:
- No process, no pcb, no RPC — same-thread sync calls only; blob memory is
  the interchange (staging via `ksvc_buf`, results as pointer+header with
  documented lifetime).
- The import env is explicit and minimal (§5); it grows import-by-import
  with capabilities, never speculatively; fs access is read-only.
- `ksvc_abi` gates JS↔blob pairing; breaking ABI changes bump it in the
  same commit as the wrapper.
- Load failure at OS boot is a boot error, never a degraded desktop.

## 14. Risks & follow-ups (sharpest first)

1. **Pixel-assert churn in the gate** (the real cost center): headless
   composites gain text ⇒ any e2e sampling title strips can move. Mitigated
   by the small confirmed surface (§12.8) and the v133 verify-visually
   rule. Budget triage time; do NOT bulk-re-bless.
2. **Visual regression risk at look-confirm**: FreeType mono 20 px bold
   (Noto Sans Mono, embolden) replaces browser `bold 20px sans-serif` —
   letterforms WILL differ (that's the point: our stack, consistent with
   the rest of the OS). The tunables are embolden strength and baseline;
   if the look-confirm wants a wider/prop face later, that's a face choice
   (config), not an architecture change.
3. **vsnprintf mini-formatter drift**: a future blob capability using a
   fancier format string hits the loud throw at runtime, not at build.
   Acceptable (loud, named), but keep the whitelist tight and the throw
   message explicit.
4. **Glyph-pipeline tri-plication**: ksvc.c is the estate's THIRD copy of
   the chain-probe/tofu/cache discipline (gdi32 `font_glyph`, term
   `cp_glyph`). Consolidating into a header-only core (the fontchain.h /
   fileops.h precedent) is a real follow-up — file it as a queue item when
   0275 lands; it refactors two SHIPPED consumers, so it's not smuggled
   into this change.
5. **Blob growth discipline**: 269 KB today; each capability grows the one
   seeded file and every boot pays instantiation. Fine at this scale; if a
   future capability is huge, revisit split-vs-grow THEN (the item says
   growable blob — keep it one until size hurts).
6. **Exposé caption parity choice**: this design draws overview captions
   headless (text parity everywhere, §8). If the golden triage shows an
   overview e2e depending on caption-free cells, the fallback ruling is
   titles-only headless — flag to jku rather than silently choosing.

## Appendix: spike artifacts

- `os/ksvc/ksvc.c` + `os/ksvc/bin.json` — the seed (spike exports to be
  replaced by the real ABI in §12.1).
- `os/ksvc/spike/build.js` — buildProject → `spike/ksvc.wasm` (gitignored
  output), dumps imports/exports.
- `os/ksvc/spike/run.cjs` — minimal-env instantiation + 'A'/'R'/'B'
  rasterization + fc_load proof (`fakeroot/`).
