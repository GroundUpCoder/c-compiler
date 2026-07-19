# vendor/fonts — the OS font estate (gucOS Unicode Phase D)

All fonts are TrueType-flavored (`glyf` outlines): the vendored freetype
build registers ONLY the TrueType driver (`vendor/freetype/demo/myftmodule.h`
— no CFF module), so CFF-flavored `.otf` files do not load. That constraint
picked every file below.

| File | What | Version / source | License |
|------|------|------------------|---------|
| `NotoSansMono-Regular.ttf` | **The one baked face** (`/usr/share/fonts/mono.ttf`, D2 ruling): Latin/Latin-Ext/Greek/Cyrillic + box drawing U+2500-257F (128/128) + block elements U+2580-259F (32/32) + symbols. Replaces Roboto Mono (retired Phase D). | Noto fonts project, hinted build — `github.com/notofonts/notofonts.github.io` `fonts/NotoSansMono/hinted/ttf/`, fetched 2026-07-19. 3920 glyphs, upem 1000, 0.6em mono advance (same as Roboto — the ppem-10 chrome pitch carries over). | SIL OFL 1.1 (`OFL-NotoSansMono.txt`) |
| `unifont-15.0.06.ttf` | `font-unifont` package payload: GNU Unifont, full-BMP bitmap-traced coverage (57087 code points incl. all CJK) — the recommended "everything renders" install. | `ftp.gnu.org/gnu/unifont/unifont-15.0.06/`, fetched 2026-07-19. 15.0.06 is the LAST TrueType build — 15.1+ ships only CFF `.otf`. | Dual SIL OFL 1.1 / GPLv2+ with font-embedding exception (`COPYING-unifont.txt`) |
| `NotoSansMonoCJKjp-VF.ttf` | `font-noto-cjk-mono` package payload: real CJK quality, family-consistent with the Noto base. Variable font; the default instance (Regular) is what freetype renders. | `github.com/notofonts/noto-cjk` `Sans/Variable/TTF/Mono/`, fetched 2026-07-19. The variable TTF is the ONLY TrueType-flavored official build (static OTF/OTC are CFF) — hence 35 MB instead of the ~16 MB static file. | SIL OFL 1.1 (`LICENSE-NotoCJK.txt`) |

sha256 (fetched artifacts, for provenance):

    65b5e2b2c4a1fba9ae8be1f026cb35b03dcb8886d9b2a4147054fde12f7e767d  NotoSansMono-Regular.ttf
    9a91b2f42ad958fd4295586809f85366f0afa020b85ac70b39916c25bc5cda15  NotoSansMonoCJKjp-VF.ttf
    9282b6eff54eeca2e7f58c9a40a91049bd219f3e6a45fbee8eba013379b9af3a  unifont-15.0.06.ttf

Only the Noto Sans Mono face is baked into the system image; the CJK fonts
ship exclusively as gucman packages (`packages/font-*.json`) that append
their face to the `/etc/fonts/fallback` chain on install.
