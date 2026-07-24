# NetSurf (vendored constellation) — the gucOS browser engine

The complete NetSurf browser — core plus its seven support libraries —
vendored for the gucOS toolchain (`compiler.js`).  This is the foundation
for `/bin/netsurf` (file-only, no networking, no JS in v1; see
`todos/OS.md` and the netsurf lanes).  The whole constellation (~590 TUs)
builds with compiler.js in ~26 s into a ~2.7 MB wasm and runs end-to-end:
`node vendor/netsurf/smoke.mjs` builds the upstream **monkey** headless
frontend and drives a real `file://` page through
fetch → hubbub parse → libdom → libcss style → layout → plot, asserting
the plotted geometry and a clean exit.

Pinned upstream revisions: `UPSTREAM.json` (2026-02 master, NetSurf 3.12
Dev).  Licences: MIT (libs), GPLv2 (netsurf core) — each tree keeps its
`COPYING`.

## Layout

| Path | What |
|---|---|
| `netsurf/` | Browser core subset: `utils/ content/ desktop/ include/ frontends/monkey/ resources/` (no other frontends; `duktape/`+`WebIDL/` dropped — JS is off; `ca-bundle` + non-en locales dropped) |
| `libwapcaplet/ libparserutils/ libhubbub/ libdom/ libcss/` | The parse/style stack (`include/ src/`, libdom also `bindings/hubbub/`) |
| `libnsgif/ libnsbmp/ libnsutils/` | GIF/BMP-ICO decode, small utils |
| `libnsfb/` | Framebuffer surface + 32bpp software plotters (portable subset; the gucOS frontend's raster layer — not linked by nsmonkey) |
| `gucos/` | **The gucOS frontend** (Lane 2): renders into a real gucOS window — libnsfb XBGR8888 RAM surface blitted to the SDL3-veneer window surface (same byte layout, alpha forced opaque), freetype text via a frontend-owned glyph cache (the upstream fb frontend's `font_freetype.c` minus FTC, which the vendored freetype doesn't carry), the fb frontend's scheduler, SDL input map (mouse click/drag/wheel, keys), drag-resize → synchronous reformat, SDL clipboard, per-`<title>` window titles.  `gucos/bin.json` is the app build graph (dep order rule applies; also compile-checked as `projects/netsurf-gucos`) |
| `shim/` | gucOS glue: productized `iconv` over libparserutils' charset codecs, `inet_aton/inet_pton` (address parsing only), `testament.h`, install-tree alias headers (`dom/bindings/hubbub/*`), `arpa/ netinet/` headers |
| `*/lib.json`, `netsurf-core.json`, `bin.json` | The build graph (below) |
| `patches/` | Curated content patches (table below) |
| `update.sh`, `relativize.mjs`, `UPSTREAM.json` | Re-runnable vendor pipeline |
| `smoke.mjs`, `test/hello.html` | Build + end-to-end smoke recipe (`test/squares.html` + `test/two.html` drive the in-window e2e, `tests/kernel/test_netsurf_e2e.js`) |

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
- **Duktape / JS** — `NETSURF_USE_DUKTAPE := NO` config;
  `javascript/none/none.c` links.  Later JS = revendor
  `content/handlers/javascript/duktape/` + commit nsgenbind output.
- **libnslog** (flex/bison; `NETSURF_USE_NSLOG := AUTO` off is a
  supported config), **libnspsl** (cookie/networking), **libutf8proc**
  (IDN), **nsgenbind** (JS bindings).
- **libnsfb non-portable backends** (X11/SDL1.2/wayland/VNC/able
  surfaces, 1/24bpp depths) — gucOS renders through its own SDL3-shm
  frontend (Lane 2).
- `frontends/monkey/res/` symlink farm (upstream make furniture;
  `NETSURFRES` + `resources/` serve the same purpose here).
