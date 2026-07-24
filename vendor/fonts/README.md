# vendor/fonts — the OS font estate (gucOS Unicode Phase D)

All fonts are TrueType-flavored (`glyf` outlines): the vendored freetype
build registers ONLY the TrueType driver (`vendor/freetype/demo/myftmodule.h`
— no CFF module), so CFF-flavored `.otf` files do not load. That constraint
picked every file below.

| File | What | Version / source | License |
|------|------|------------------|---------|
| `NotoSansMono-Regular.ttf` | **The baked mono face** (`/usr/share/fonts/mono.ttf`, D2 ruling): Latin/Latin-Ext/Greek/Cyrillic + box drawing U+2500-257F (128/128) + block elements U+2580-259F (32/32) + symbols. Replaces Roboto Mono (retired Phase D). | Noto fonts project, hinted build — `github.com/notofonts/notofonts.github.io` `fonts/NotoSansMono/hinted/ttf/`, fetched 2026-07-19. 3920 glyphs, upem 1000, 0.6em mono advance (same as Roboto — the ppem-10 chrome pitch carries over). | SIL OFL 1.1 (`OFL-NotoSansMono.txt`) |
| `NotoSans-{Regular,Bold,Italic,BoldItalic}.ttf` | **The baked proportional sans family** (`/usr/share/fonts/sans.ttf` / `sans_bold.ttf` / `sans_italic.ttf` / `sans_italic_bold.ttf`, NetSurf Lane 3): the browser's default faces — every generic CSS family without its own baked face (cursive, fantasy) falls back to sans in netsurf's font frontend, so this one family upgrades them all from the previous mono-only fallback. | Noto fonts project, hinted builds — `github.com/notofonts/notofonts.github.io` `fonts/NotoSans/hinted/ttf/`, fetched 2026-07-24. | SIL OFL 1.1 (`OFL-NotoSans.txt` — same upstream repo/license text as the mono face) |
| `NotoSerif-{Regular,Bold}.ttf` | **The baked serif pair** (`/usr/share/fonts/serif.ttf` / `serif_bold.ttf`, NetSurf Lane 4): fills the two serif slots netsurf's font frontend actually has (`FB_FACE_SERIF`/`FB_FACE_SERIF_BOLD` — there are no serif-italic slots), so `font-family: serif` pages stop falling back to sans. | Noto fonts project, hinted builds — `github.com/notofonts/notofonts.github.io` `fonts/NotoSerif/hinted/ttf/`, fetched 2026-07-24. | SIL OFL 1.1 (`OFL-NotoSerif.txt` — byte-identical to the sans/mono text) |
| `NotoSansMono-Bold.ttf` | **The baked bold mono face** (`/usr/share/fonts/mono_bold.ttf`, NetSurf Lane 4): fills netsurf's `FB_FACE_MONOSPACE_BOLD` slot (bold `<code>`/`<pre>` text); term/wm keep rendering the regular face. | Noto fonts project, hinted build — `github.com/notofonts/notofonts.github.io` `fonts/NotoSansMono/hinted/ttf/`, fetched 2026-07-24. | SIL OFL 1.1 (`OFL-NotoSansMono.txt`) |
| `unifont-15.0.06.ttf` | `font-unifont` package payload: GNU Unifont, full-BMP bitmap-traced coverage (57087 code points incl. all CJK) — the recommended "everything renders" install. | `ftp.gnu.org/gnu/unifont/unifont-15.0.06/`, fetched 2026-07-19. 15.0.06 is the LAST TrueType build — 15.1+ ships only CFF `.otf`. | Dual SIL OFL 1.1 / GPLv2+ with font-embedding exception (`COPYING-unifont.txt`) |
| `NotoSansMonoCJKjp-VF.ttf` | `font-noto-cjk-mono` package payload: real CJK quality, family-consistent with the Noto base. Variable font; the default instance (Regular) is what freetype renders. | `github.com/notofonts/noto-cjk` `Sans/Variable/TTF/Mono/`, fetched 2026-07-19. The variable TTF is the ONLY TrueType-flavored official build (static OTF/OTC are CFF) — hence 35 MB instead of the ~16 MB static file. | SIL OFL 1.1 (`LICENSE-NotoCJK.txt`) |

sha256 (fetched artifacts, for provenance):

    19e72cd8d595fae5bd74a5206f5d938512e1183d4fed7abb1ec1be1d7efa5f88  NotoSerif-Regular.ttf
    96656aa5cec8f1d6fd0e804c1fad397e1a1cfa082e6642124e0bda68cd8363ce  NotoSerif-Bold.ttf
    a21ea0ba6ea49fda7b34ca39a504b487f1130885d36e1a4f9f4255b3ba6994bc  NotoSansMono-Bold.ttf
    65b5e2b2c4a1fba9ae8be1f026cb35b03dcb8886d9b2a4147054fde12f7e767d  NotoSansMono-Regular.ttf
    478c558ea716033cd60c03438f628dfa75694dcf6b5f6d505a2f05fd2b4f3823  NotoSans-Regular.ttf
    1df075a380fc7cb898acf64c1f7b3b4dd780de3caa860178bf929de35817a913  NotoSans-Bold.ttf
    467e3f89eeca4108bb8710a2b9e0cf2281ac56d5b0609211a83776d0505eecb5  NotoSans-Italic.ttf
    1b602a9d6353be42c91df097a4857b69fa2696f26703d7a33b54a15d87c2622c  NotoSans-BoldItalic.ttf
    9a91b2f42ad958fd4295586809f85366f0afa020b85ac70b39916c25bc5cda15  NotoSansMonoCJKjp-VF.ttf
    9282b6eff54eeca2e7f58c9a40a91049bd219f3e6a45fbee8eba013379b9af3a  unifont-15.0.06.ttf

The mono/sans/serif Noto faces above are baked into the system image; the
CJK fonts ship exclusively as gucman packages (`packages/font-*.json`)
that append their face to the `/etc/fonts/fallback` chain on install.
