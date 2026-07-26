# NetSurf (vendored constellation) — the gucOS browser engine

The complete NetSurf browser — core plus its seven support libraries —
vendored for the gucOS toolchain (`compiler.js`).  This is the foundation
for `/bin/netsurf` (file-only, no networking; see `todos/OS.md` and the
netsurf lanes).  The whole constellation (~850 TUs) builds with compiler.js
in ~57 s into a ~5.0 MB wasm and runs end-to-end:
`node vendor/netsurf/smoke.mjs` builds the upstream **monkey** headless
frontend and drives a real `file://` page through
fetch → hubbub parse → libdom → libcss style → layout → plot, asserting
the plotted geometry and a clean exit.

**JavaScript is in, and on** (duktape 2.7.0 + the nsgenbind WebIDL
bindings; `todos/NETSURF-JS.md` Lane A).  `node vendor/netsurf/smoke-js.mjs`
is its gate: script execution, console, parse-time `document.write`, click
dispatch to real DOM listeners, canvas `getImageData`/`putImageData`,
`setInterval`, the 10 s execution watchdog and the `Choices` off-switch, all
driven over the monkey protocol against `demos/`.  The gucOS frontend
defaults `enable_javascript` ON; `tests/kernel/test_netsurf_js_e2e.js` is
the in-OS proof.  JS costs +2.32 MB of wasm and +30 s of build over the
JS-off configuration — see the design doc for the accepted trade.

Pinned upstream revisions: `UPSTREAM.json` (2026-02 master, NetSurf 3.12
Dev).  Licences: MIT (libs), GPLv2 (netsurf core) — each tree keeps its
`COPYING`.

## Layout

| Path | What |
|---|---|
| `netsurf/` | Browser core subset: `utils/ content/ desktop/ include/ frontends/monkey/ resources/` incl. `content/handlers/javascript/{duktape,WebIDL}/` (no other frontends; `ca-bundle` + non-en locales dropped) |
| `genjs/duktape/` | **Committed** nsgenbind output — 223 `.c` + 3 headers + the two xxd'd JS blobs + nsgenbind's own source-list `Makefile`.  Regenerated only by `regen-js-bindings.sh` (needs bison ≥ 3); see "Committed generated sources" |
| `demos/` | The JavaScript acceptance pages (`hello-js.html`, `counter.html`, `sketch.html`) driven by `smoke-js.mjs` |
| `libwapcaplet/ libparserutils/ libhubbub/ libdom/ libcss/` | The parse/style stack (`include/ src/`, libdom also `bindings/hubbub/`) |
| `libnsgif/ libnsbmp/ libnsutils/` | GIF/BMP-ICO decode, small utils |
| `libnsfb/` | Framebuffer surface + 32bpp software plotters (portable subset; the gucOS frontend's raster layer — not linked by nsmonkey) |
| `gucos/` | **The gucOS frontend** (Lane 2): renders into a real gucOS window — libnsfb XBGR8888 RAM surface blitted to the SDL3-veneer window surface (same byte layout, alpha forced opaque), freetype text via a frontend-owned glyph cache (the upstream fb frontend's `font_freetype.c` minus FTC, which the vendored freetype doesn't carry), the fb frontend's scheduler, SDL input map (mouse click/drag/wheel, keys), drag-resize → synchronous reformat, SDL clipboard, per-`<title>` window titles.  `gucos/bin.json` is the app build graph (dep order rule applies; also compile-checked as `projects/netsurf-gucos`) |
| `shim/` | gucOS glue: productized `iconv` over libparserutils' charset codecs, `inet_aton/inet_pton` (address parsing only), `testament.h`, install-tree alias headers (`dom/bindings/hubbub/*`), `arpa/ netinet/` headers |
| `*/lib.json`, `netsurf-core.json`, `bin.json` | The build graph (below) |
| `patches/` | Curated content patches (table below) |
| `update.sh`, `relativize.mjs`, `UPSTREAM.json` | Re-runnable vendor pipeline |
| `regen-js-bindings.sh`, `genjs-sources.mjs` | Re-runnable **binding** pipeline (maintainer-only; no build runs it) |
| `smoke.mjs`, `test/hello.html` | Build + end-to-end smoke recipe (`test/squares.html` + `test/two.html` drive the in-window e2e, `tests/kernel/test_netsurf_e2e.js`) |
| `smoke-js.mjs`, `demos/` | The JavaScript gate (5 legs; `--reuse` to skip a fresh link, `--leg N` for one) |

## Build graph & the include-order rule

Each lib has a standalone `lib.json`.  `netsurf-core.json` is the browser
core WITHOUT a frontend — deliberately a *partial* component: its TUs
compile against the constellation headers, so **an app json must dep the
libs too, and must list `netsurf-core.json` FIRST** so the core's include
dirs (`netsurf`, `netsurf/include`, …) precede the lib dirs
(`buildProject` flattens `-I`s in dep order).  The lib trees themselves
are include-order independent (relativize.mjs rewrites every
cross-component-ambiguous quote-include to an includer-relative path);
only the core keeps its upstream `"utils/…"` spellings, which is why it
must come first.  `bin.json` (the monkey smoke binary — Lane 3 may repoint this at the real /bin/netsurf app) is the reference consumer, and the run.py `projects` suite compile-checks it.

Runtime resources: the engine needs `default.css`/`quirks.css`/
`internal.css` and a `Messages` file to finish a page load (a missing
`resource:` stylesheet sends loads into the `about:fetcherror` path).
They live in `netsurf/resources/` (`Messages.en` is the committed
en split of `FatMessages`); monkey finds them via the `NETSURFRES` env
var (smoke.mjs assembles `build/netsurf-smoke/res/`), and the OS image
will seed them at `/usr/share/netsurf/` (Lane 3).  The gucOS frontend
searches `${HOME}/.netsurf/`, `${NETSURFRES}`, `/usr/local/share/netsurf/`
then `/usr/share/netsurf/`.

Fonts (gucOS frontend): generic families resolve via the `fb_face_*`
options (upstream fb names, `gucos/options.h`), then `/etc/fonts/` >
`/usr/share/fonts/` by generic filename (`sans.ttf`, `serif.ttf`,
`mono.ttf`, …); the sans default falls back to the always-baked
`mono.ttf`, so a stock image renders real freetype AA text everywhere —
seeding a proportional face (Lane 3 candidate) upgrades every family
that isn't explicitly configured.

## Patch table (all in `patches/`, applied by update.sh)

netsurf core:
- `utils/config.h` — appended `__wasm__` platform section (the `_WIN32`
  lines are the precedent): libc's `strcasestr`/`strchrnul`; upstream's
  own fallbacks for scandir/dirfd/unlinkat/fstatat/regex/utsname/mmap;
  `isascii`; `<strings.h>`.
- `content/fetch.c` — `#ifdef WITH_CURL` around the one unconditional
  curl include (file-only build).
- `content/handlers/image/png.c` — `switch(setjmp(…))` →
  `if ((v = setjmp(…))) {} switch (v)`: compiler.js recognises setjmp
  only in if-condition form.
- `desktop/frames.c` — the only VLA in the tree → heap grids with a
  `GRID()` accessor (compiler.js has no VLAs).
- `utils/talloc.c` — `|| defined(__wasm__)` on the `__GNUC__ > 2`
  va_copy probe.
- `utils/nsoption.h` + `utils/nsoption.c` — an `nsgucos` branch in the
  per-frontend options include chain (the same 3 sites every upstream
  frontend hooks), pulling `gucos/options.h`.
- `frontends/monkey/filetype.c` — **upstream gap**: `js` is missing from
  the pre-seeded essentials mime table, and the fallback is `text/plain`,
  which `javascript_content` does not register
  (`content/handlers/javascript/content.c:115`). So an external
  `<script src="x.js">` off a `file://` page *fetched fine*, arrived as
  `CONTENT_TEXTPLAIN`, and `html/script.c`'s `select_script_handler`
  (`:49`) returned NULL — the bytes were silently discarded and the
  script never ran. Two lines seed `js`/`mjs` as `text/javascript`. Both
  frontends here share this resolver (`gucos/fetch.c:55`), so the fix is
  frontend-wide, and it holds with or without a `mime.types` file.
  Upstreamable. Regression guard: `smoke-js.mjs` leg 0 plus the
  per-demo subresource checks in legs 1-3/5-7, and
  `tests/kernel/test_netsurf_demos_e2e.js` in-window.

netsurf core — **the Lane B live re-conversion bridge** (JS DOM mutation →
re-box → reflow → repaint; design in `todos/NETSURF-JS.md`, rationale in
`logs/2026-07-26/netsurf-lane-b.md`).  Upstream converts a document to
boxes exactly ONCE, so all of this is "make box construction re-runnable
on a live content":

- `content/handlers/html/html.c` + `private.h` — `html_schedule_reconvert`
  (the one choke point, coalesced through `schedule(0, …)`), the teardown
  that clears everything pointing into the dying box tree, build-then-swap
  re-conversion, and the focus/caret re-bind across the swap.  Carries the
  build-time kill switch `-DNETSURF_NO_LIVE_RECONVERT`, which restores
  upstream behaviour — `smoke-js.mjs` leg 8 builds that variant as its A/B
  baseline.
- `content/handlers/html/dom_event.c` — schedules a re-conversion from the
  GENERIC insert/subtree-modified default actions.  libdom fires
  `DOMSubtreeModified` at the parent for insertion, removal, character
  data AND attribute changes, so one hook covers every structural class;
  STYLE keeps the stylesheet path and INPUT/TEXTAREA keep the gadget-sync
  path (a whole-document re-box per keystroke would be absurd).
- `content/handlers/css/select.{c,h}` — `nscss_node_data_clear`, a proper
  `CSS_NODE_DELETED` free of a node's cached style.  `set_libcss_node_data`
  ASSERTS it never replaces live data, so re-styling a document needs the
  cache cleared first.
- `content/handlers/html/imagemap.c` — **upstream bug**:
  `imagemap_addtolist` ran `strtok` directly on `dom_string_data(coords)`,
  writing NULs into the interned DOM attribute.  Harmless when extraction
  happens once per document; the moment it can re-run, every area collapses
  to 0,0,0,0.  Now tokenises a copy.  Upstreamable.
- `content/handlers/html/forms.c` + `private.h` — a control outside any
  `<form>` is adopted onto the content (`formless_controls`) instead of
  being owned by nobody, so it can be re-found by DOM node like any other
  gadget.  Also fixes an upstream leak: nothing freed those at destroy.
- `content/handlers/html/form.c` + `form_internal.h` —
  `form_select_clear_options` (factored out of `form_free_control`) so a
  re-boxed `<select>` refills its option list instead of appending a
  duplicate set; plus the formless-list unlink.
- `content/handlers/html/box_special.c` — call the above at select reuse.
- `content/handlers/html/box_textarea.c` — release the previous
  `textarea`/`dom_string` before rebuilding a text gadget's widget
  (upstream overwrote the pointers: one leaked widget per re-box).
- `desktop/textarea.{c,h}` — `textarea_get_caret_char`, the public inverse
  of the existing `textarea_set_caret`, so a caret can be carried from a
  destroyed widget to its replacement.  Purely additive; upstreamable.

libdom:
- `src/events/event_target.c` — a non-capture listener registered on the
  event TARGET fired twice per event.  `_dom_node_dispatch_event`
  (`src/core/node.c`) walks the target itself as part of both the capture
  and the bubble chains, and `_dom_event_target_dispatch`'s bubble clause
  did not exclude `evt->current == evt->target`, so the listener ran once
  at-target and again as the bubble walk passed back over the target — one
  click counted 2.  Now gated on `at_target`, which also puts a
  capture-flag listener on the target in the AT_TARGET phase where DOM L3
  wants it.  Upstreamable; also halves the duplicate work in libdom's own
  tokenlist (`classList`) and the canvas2d `DOMSubtreeModified` handlers,
  which are non-capture listeners on their own target too.  Regression
  guard: `smoke-js.mjs` leg 2 ("one click = exactly ONE increment").

libnsfb:
- `src/surface.h` + `src/surface/surface.c` — `NSFB_SURFACE_DEF`'s
  `__attribute__((constructor))` registration (unsupported by
  compiler.js) becomes, under `__wasm__`, an explicit registration
  entry called lazily from the surface lookup paths (the vendored
  subset ships only the ram surface).

libs:
- `libparserutils src/charset/codec.c` — const-correct codec handler
  table (compiler.js's strict whole-program link caught non-const extern
  decls of const definitions; upstreamable).
- `libcss src/parse/mq.c` — missing `#include <strings.h>`
  (strcasecmp; upstreamable).
- `libhubbub src/treebuilder/treebuilder.c` — the mode-trace printf is
  gated on opt-in `HUBBUB_TRACE_MODES` instead of `!NDEBUG` (gucOS keeps
  asserts live everywhere; the trace would spam stdout every parse).

The probe's compiler-bug workarounds (scrollbar.c switch→ifs, monkey
initializer→assignments, urldb.c forward decl) are **absent**: the three
compiler.js P0s they dodged are fixed (see
`tests/unit/conformance/{cg_extern_ptr_agg_init,link_static_fn_def_no_keyword,cg_switch_intmin_intmax}`),
and this build compiles the clean upstream forms — it is the integration
test for those fixes.

Also NOT patches, but gucOS-side additions made for this port:
`pread`/`pwrite` and `EILSEQ` in the compiler's libc (used by
`libnsutils/src/unistd.c` and `utils/utf8.c` + `shim/iconv.c`).

## Committed generated sources

Upstream gitignores these; the vendor tree commits them (the libcss
`autogenerated_*` naming is upstream's own convention) and `update.sh`
regenerates them from the pinned sources:
- `libparserutils/src/charset/aliases.inc` (perl `make-aliases.pl`)
- `libhubbub/src/tokeniser/entities.inc` (perl `make-entities.pl`)
- `libhubbub/src/treebuilder/autogenerated-element-type.c` (gperf)
- `libcss/src/parse/properties/autogenerated_*.c` — 119 property
  parsers emitted by `gen_parser` (a C89 host tool in the libcss tree,
  built with `cc` at vendor time)
- `netsurf/resources/Messages.en` (perl `split-messages.pl` over
  `FatMessages`)
- `shim/testament.h` (hand-written, pinned to the vendored revision)

Perl generators run under `PERL_HASH_SEED=0 PERL_PERTURB_KEYS=0` —
hash-iteration order leaks into the tables, and the pin makes
regeneration at an unchanged revision byte-identical to the commit.

### The JS bindings — `genjs/duktape/` (why they are committed)

`genjs/duktape/` is nsgenbind's output over
`netsurf/content/handlers/javascript/duktape/*.bnd` +
`.../WebIDL/*.idl`: 223 `.c` (~108 KLOC), `binding.h`/`private.h`/
`prototype.h`, the two `xxd -i`'d script blobs (`generics.js.inc`,
`polyfill.js.inc`) and nsgenbind's own `Makefile` fragment, whose
`NSGENBIND_SOURCES` is the authoritative source list.

It is committed because **nsgenbind is a flex+bison tool that needs GNU
bison ≥ 3 and Apple ships 2.3**, with no package manager on the reference
machine.  Committing the output means a normal build — `smoke.mjs`,
`smoke-js.mjs`, an image bake, the run.py projects suite — needs no bison,
no flex and no nsgenbind at all.  Do NOT wire regeneration into a build
graph.  It also makes a binding edit *reviewable*: the generated diff lands
next to the `.bnd` change.

```
BISON=/path/to/bison-3.x/bin/bison vendor/netsurf/regen-js-bindings.sh
BISON=… vendor/netsurf/regen-js-bindings.sh --check   # drift gate
```

The script pins nsgenbind + buildsystem in `UPSTREAM.json`'s `tools`
section, gates on the bison version with build-it-from-source instructions,
prunes nsgenbind's `-D` debug spill (and fails loudly on any output it
cannot classify), and rewrites `netsurf-core.json`'s `genjs/duktape/*.c`
block from `NSGENBIND_SOURCES` so the two can never drift.  Verified: at the
pinned revisions regeneration reproduces every committed file
byte-identically.  Two path spellings are load-bearing, because nsgenbind
bakes the paths it is given straight into its output — outdir `duktape`
(→ the `#include "duktape/binding.h"` self-includes, resolved by `genjs`
being on the core's include list) and a `../netsurf/…` relative `.bnd`
path (→ the `#line` directives).  The script stages that exact geometry.

`netsurf/tools/xxd.c` is kept by `update.sh`'s prune whitelist for the
`.inc` step (the libcss `gen_parser` precedent: a tiny host tool built with
`cc` at vendor time).  `xxd -i` derives the array symbol from the input
path, and upstream's sed rewrites exactly one spelling of it, so that step
runs from the netsurf root with upstream's relative path.

## Updating

```
vendor/netsurf/update.sh                # clone at UPSTREAM.json pins
vendor/netsurf/update.sh --src DIR      # use existing clones
```

fetch pristine → generate → apply `patches/` → prune → `relativize.mjs`
→ install (component `lib.json`s preserved) → `relativize.mjs --check`
drift gate.  At unchanged pins the result is byte-identical to the
committed trees (verified).  To take a new drop: bump `UPSTREAM.json`,
re-run, resolve patch fuzz, update `shim/testament.h`'s `WT_REVID`, then
`node vendor/netsurf/smoke.mjs` must pass.

## Deliberate exclusions

- **curl / networking** — `file:`/`data:`/`resource:`/`about:` fetchers
  only; `fetch.c`'s registration was already properly `#ifdef WITH_CURL`.
- **libnslog** (flex/bison; `NETSURF_USE_NSLOG := AUTO` off is a
  supported config), **libnspsl** (cookie/networking), **libutf8proc**
  (IDN).
- **nsgenbind** — not vendored as a *tree*: its output is (see above), and
  the generator is fetched at its `UPSTREAM.json` `tools` pin only when a
  maintainer regenerates.
- **JS is NOT excluded any more.**  `javascript/none/none.c` is unlinked;
  `duktape/dukky.c` + `duktape/duktape.c` + the 223 `genjs/duktape/*.c`
  take its place, with `-DDUK_OPT_HAVE_CUSTOM_H` (upstream's own
  `CFLAGS` for this, from the duktape `Makefile` fragment the prune
  drops).  duktape 2.7.0 compiles with compiler.js **unpatched** — its two
  `setjmp` sites are both the `if (DUK_SETJMP(jb) == 0)` form the
  setjmp/longjmp lowering recognises.  Upstream's own JS surface is
  immature in ways that bound what pages can do; the audit and the
  follow-on lanes are in `todos/NETSURF-JS.md`.
- **libnsfb non-portable backends** (X11/SDL1.2/wayland/VNC/able
  surfaces, 1/24bpp depths) — gucOS renders through its own SDL3-shm
  frontend (Lane 2).
- `frontends/monkey/res/` symlink farm (upstream make furniture;
  `NETSURFRES` + `resources/` serve the same purpose here).
