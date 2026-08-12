#!/usr/bin/env node
// The image/compositing source-library stack as standalone packages (#661):
// zlib, pixman, cairo and giflib. Each library's own header carries its
// __require_source block (source-lib §4.2, the ft2build.h pattern), so the
// in-OS `cc` links it from a bare #include — no -I, no TU list.
//
//   - FAT image: three programs compile AND run end to end:
//       pxonly.c   — <pixman.h> ONLY: a solid-fill composite, exact pixel
//       caonly.c   — <cairo.h> ONLY: draw + read back, exact pixel. This
//                    TRANSITIVELY proves pixman (every cairo TU includes
//                    cairoint.h -> <pixman.h>), libpng/zlib (cairo-png.c)
//                    and freetype (cairo-ft-font.c): cairo.h requires only
//                    cairo's own 121 TUs.
//       gifdec.c   — <gif_lib.h> ONLY: a REAL DECODE of an embedded 2x2
//                    GIF87a — palette and per-pixel indices asserted, not a
//                    header-only compile
//     plus the hatches: -D<LIB>_NO_REQUIRE_SOURCES must make each of those
//     SAME programs fail AT LINK naming a library symbol, which is what
//     proves the header block is the link metadata
//   - MINIMAL image (no packages baked) + the served index: absence is
//     honest, then gucman installs each package for real and the same
//     programs work through /usr/local/{include,src}. The install order is
//     the ownership regression guard for the libpng->zlib split:
//
//       zlib THEN libpng must BOTH succeed.
//
//     Until #661 libpng shipped include/{zlib,zconf}.h + src/z itself, and
//     gucman refuses to overwrite an existing plant — so a standalone zlib
//     and libpng could never have coexisted. cairo then pulls pixman and
//     freetype through its deps[], and `gucman remove zlib` must REFUSE
//     while libpng/cairo depend on it (#624 revdep), which is what proves
//     the dependency edges are recorded rather than merely declared.
//
// Run: node tests/kernel/test_cc_imagelibs_e2e.js
'use strict';
const fs = require('fs');
const { driveBoot, freshImage, section } = require('./lib/drive.js');
const { ensureMinimalImage, ensurePackages, startServer } = require('./lib/gucman.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const writeApp = (path, lines) => [`cat > ${path} << 'EOF'`, ...lines, 'EOF'];

// <pixman.h> ONLY — solid red SRC-composited over a 4x4 a8r8g8b8 image.
const PXONLY_C = [
  '#include <pixman.h>',
  '#include <stdio.h>',
  'int main(void) {',
  '    pixman_image_t *dst = pixman_image_create_bits(PIXMAN_a8r8g8b8, 4, 4, NULL, 0);',
  '    pixman_color_t red = { 0xffff, 0, 0, 0xffff };',
  '    pixman_image_t *src = pixman_image_create_solid_fill(&red);',
  '    if (!dst || !src) { printf("PXONLY-CREATE-FAIL\\n"); return 1; }',
  '    pixman_image_composite32(PIXMAN_OP_SRC, src, NULL, dst, 0,0, 0,0, 0,0, 4,4);',
  '    uint32_t *p = pixman_image_get_data(dst);',
  '    printf("PXONLY ver=%s px=%08x last=%08x\\n", pixman_version_string(), p[0], p[15]);',
  '    pixman_image_unref(src); pixman_image_unref(dst);',
  '    printf("PXONLY-DONE\\n");',
  '    return 0;',
  '}',
];

// <cairo.h> ONLY — fill a rectangle, read the pixel back out of the image
// surface. Pulls pixman/libpng/zlib/freetype transitively.
const CAONLY_C = [
  '#include <cairo.h>',
  '#include <stdio.h>',
  'int main(void) {',
  '    cairo_surface_t *s = cairo_image_surface_create(CAIRO_FORMAT_ARGB32, 16, 16);',
  '    cairo_t *cr = cairo_create(s);',
  '    cairo_set_source_rgba(cr, 1, 0, 0, 1);',
  '    cairo_rectangle(cr, 0, 0, 8, 8);',
  '    cairo_fill(cr);',
  '    cairo_surface_flush(s);',
  '    if (cairo_status(cr) != CAIRO_STATUS_SUCCESS) {',
  '        printf("CAONLY-STATUS-FAIL %s\\n", cairo_status_to_string(cairo_status(cr))); return 1; }',
  '    unsigned char *d = cairo_image_surface_get_data(s);',
  '    int stride = cairo_image_surface_get_stride(s);',
  '    unsigned char *out = d + 10 * stride + 10 * 4;',   // outside the filled box
  '    printf("CAONLY ver=%s in=%02x%02x%02x%02x out=%02x%02x%02x%02x\\n",',
  '           cairo_version_string(), d[3], d[2], d[1], d[0],',
  '           out[3], out[2], out[1], out[0]);',
  '    cairo_destroy(cr); cairo_surface_destroy(s);',
  '    printf("CAONLY-DONE\\n");',
  '    return 0;',
  '}',
];

// <gif_lib.h> ONLY — decode an embedded 2x2 GIF87a with a 2-entry global
// colour table (red, blue) and pixel indices 0,1,1,0. Hand-built LZW: a
// CLEAR before every literal keeps the code size at 3 bits.
const GIFDEC_C = [
  '#include <gif_lib.h>',
  '#include <stdio.h>',
  'static const unsigned char GIF[] = {',
  ' 0x47,0x49,0x46,0x38,0x37,0x61,0x02,0x00,0x02,0x00,0xf0,0x00,0x00,0xff,0x00,0x00,',
  ' 0x00,0x00,0xff,0x2c,0x00,0x00,0x00,0x00,0x02,0x00,0x02,0x00,0x00,0x02,0x04,0x04,',
  ' 0xc3,0x10,0x05,0x00,0x3b };',
  'int main(void) {',
  '    FILE *f = fopen("/root/t.gif", "wb");',
  '    if (!f || fwrite(GIF, 1, sizeof GIF, f) != sizeof GIF) { printf("GIF-WRITE-FAIL\\n"); return 1; }',
  '    fclose(f);',
  '    int err = 0;',
  '    GifFileType *g = DGifOpenFileName("/root/t.gif", &err);',
  '    if (!g) { printf("GIF-OPEN-FAIL %d\\n", err); return 1; }',
  '    if (DGifSlurp(g) != GIF_OK) { printf("GIF-SLURP-FAIL %d\\n", g->Error); return 1; }',
  '    SavedImage *im = &g->SavedImages[0];',
  '    ColorMapObject *cm = im->ImageDesc.ColorMap ? im->ImageDesc.ColorMap : g->SColorMap;',
  '    unsigned char *px = im->RasterBits;',
  '    GifColorType c0 = cm->Colors[px[0]], c1 = cm->Colors[px[1]];',
  '    printf("GIFDEC w=%d h=%d n=%d idx=%d%d%d%d c0=%02x%02x%02x c1=%02x%02x%02x\\n",',
  '           g->SWidth, g->SHeight, g->ImageCount, px[0], px[1], px[2], px[3],',
  '           c0.Red, c0.Green, c0.Blue, c1.Red, c1.Green, c1.Blue);',
  '    DGifCloseFile(g, &err);',
  '    printf("GIFDEC-DONE\\n");',
  '    return 0;',
  '}',
];

// <zlib.h> ONLY — the standalone zlib package's own consumer.
const ZONLY_C = [
  '#include <zlib.h>',
  '#include <stdio.h>',
  '#include <string.h>',
  'int main(void) {',
  '    const char *msg = "gucos standalone zlib package #661";',
  '    unsigned char comp[256]; uLongf clen = sizeof comp;',
  '    if (compress(comp, &clen, (const Bytef *)msg, (uLong)strlen(msg) + 1) != Z_OK) {',
  '        printf("ZONLY-COMPRESS-FAIL\\n"); return 1; }',
  '    char back[256]; uLongf blen = sizeof back;',
  '    if (uncompress((Bytef *)back, &blen, comp, clen) != Z_OK) {',
  '        printf("ZONLY-UNCOMPRESS-FAIL\\n"); return 1; }',
  '    printf("ZONLY match=%d ver=%s\\n", strcmp(back, msg) == 0, zlibVersion());',
  '    printf("ZONLY-DONE\\n");',
  '    return 0;',
  '}',
];

// <png.h> ONLY — proves libpng still reaches zlib after the split.
const PONLY_C = [
  '#include <png.h>',
  '#include <stdio.h>',
  '#include <stdlib.h>',
  '#include <string.h>',
  'int main(void) {',
  '    int W = 6, H = 4;',
  '    unsigned char *buf = malloc((size_t)W * H * 4);',
  '    for (int i = 0; i < W * H; i++) {',
  '        buf[i*4+0] = (unsigned char)(i * 10); buf[i*4+1] = (unsigned char)(i * 6);',
  '        buf[i*4+2] = (unsigned char)(i * 3);  buf[i*4+3] = 255;',
  '    }',
  '    png_image wi; memset(&wi, 0, sizeof wi); wi.version = PNG_IMAGE_VERSION;',
  '    wi.width = (png_uint_32)W; wi.height = (png_uint_32)H; wi.format = PNG_FORMAT_RGBA;',
  '    if (!png_image_write_to_file(&wi, "/root/p.png", 0, buf, 0, NULL)) {',
  '        printf("PONLY-WRITE-FAIL %s\\n", wi.message); return 1; }',
  '    png_image ri; memset(&ri, 0, sizeof ri); ri.version = PNG_IMAGE_VERSION;',
  '    if (!png_image_begin_read_from_file(&ri, "/root/p.png")) {',
  '        printf("PONLY-READ-FAIL %s\\n", ri.message); return 1; }',
  '    ri.format = PNG_FORMAT_RGBA;',
  '    unsigned char *out = malloc(PNG_IMAGE_SIZE(ri));',
  '    if (!png_image_finish_read(&ri, NULL, out, 0, NULL)) {',
  '        printf("PONLY-FINISH-FAIL %s\\n", ri.message); return 1; }',
  '    printf("PONLY w=%u h=%u px5=%d,%d,%d\\n", ri.width, ri.height,',
  '           out[5*4+0], out[5*4+1], out[5*4+2]);',
  '    printf("PONLY-DONE\\n");',
  '    free(out); free(buf);',
  '    return 0;',
  '}',
];

async function main() {
  /* ---- session A: the fat image (baked /usr/{include,src} tiers) ---- */
  const { dir: tmpA, image } = freshImage('os-imagelibs-');
  const scriptA = [
    ...writeApp('/root/pxonly.c', PXONLY_C),
    ...writeApp('/root/caonly.c', CAONLY_C),
    ...writeApp('/root/gifdec.c', GIFDEC_C),
    'cd /root',
    'echo ==pixman',
    'cc pxonly.c -o pxonly && ./pxonly',
    'echo xrc=$?',
    'echo ==cairo',
    'cc caonly.c -o caonly && ./caonly',
    'echo crc=$?',
    'echo ==gif',
    'cc gifdec.c -o gifdec && ./gifdec',
    'echo grc=$?',
    // the hatches: with a block suppressed nothing links that library
    'echo ==xhatch',
    'cc -DPIXMAN_NO_REQUIRE_SOURCES pxonly.c -o xhatch.out 2>&1',
    'echo xhrc=$?',
    'echo ==chatch',
    'cc -DCAIRO_NO_REQUIRE_SOURCES caonly.c -o chatch.out 2>&1',
    'echo chrc=$?',
    'echo ==ghatch',
    'cc -DGIF_NO_REQUIRE_SOURCES gifdec.c -o ghatch.out 2>&1',
    'echo ghrc=$?',
    'echo ==pkgs',
    'grep -o "PACKAGES=[^ ]*" /usr/share/os-release || echo NO-PACKAGES-LINE',
    'echo ==done',
    'exit',
  ].join('\n');
  const a = driveBoot(scriptA, { image, timeout: 900000 });
  const aout = String(a.stdout || '');
  check('fat session exits clean', a.status === 0,
    String(a.status) + ' ' + String(a.stderr || '').slice(-300));

  const px = section(aout, 'pixman');
  check('fat: <pixman.h> STANDALONE links + composites (opaque red)',
    /PXONLY ver=0\.42\.2 px=ffff0000 last=ffff0000/.test(px) &&
    px.includes('PXONLY-DONE') && px.includes('xrc=0'), px);
  const ca = section(aout, 'cairo');
  check('fat: <cairo.h> STANDALONE links + draws (pixman proven transitively)',
    /CAONLY ver=1\.18\.4 in=ffff0000 out=00000000/.test(ca) &&
    ca.includes('CAONLY-DONE') && ca.includes('crc=0'), ca);
  const gf = section(aout, 'gif');
  check('fat: <gif_lib.h> STANDALONE links + really DECODES a GIF',
    /GIFDEC w=2 h=2 n=1 idx=0110 c0=ff0000 c1=0000ff/.test(gf) &&
    gf.includes('GIFDEC-DONE') && gf.includes('grc=0'), gf);
  const xh = section(aout, 'xhatch');
  check('fat: PIXMAN_NO_REQUIRE_SOURCES suppresses the block (loud link error)',
    /Undefined symbol.*pixman_/i.test(xh) && /xhrc=[^0]/.test(xh), xh);
  const ch = section(aout, 'chatch');
  check('fat: CAIRO_NO_REQUIRE_SOURCES suppresses the block (loud link error)',
    /Undefined symbol.*cairo_/i.test(ch) && /chrc=[^0]/.test(ch), ch);
  const gh = section(aout, 'ghatch');
  check('fat: GIF_NO_REQUIRE_SOURCES suppresses the block (loud link error)',
    /Undefined symbol.*(DGif|GifError)/i.test(gh) && /ghrc=[^0]/.test(gh), gh);
  const pkgs = section(aout, 'pkgs');
  check('fat: all four folded as Built-in packages (os-release PACKAGES=)',
    ['zlib', 'pixman', 'cairo', 'giflib'].every(
      (n) => new RegExp('^PACKAGES=(.*,)?' + n + '(,|$)', 'm').test(aout)), pkgs);

  /* ---- session B: minimal image + the served index ---- */
  const repo = ensurePackages(['zlib', 'pixman', 'cairo', 'giflib', 'libpng']);
  const MIN = ensureMinimalImage();
  const { dir: tmpB, image: minImage } = freshImage('os-imagelibs-min-');
  fs.copyFileSync(MIN, minImage);   // copy mtime = now -> input-fresh at boot
  const port = await startServer(repo.dir);

  const scriptB = [
    ...writeApp('/root/zonly.c', ZONLY_C),
    ...writeApp('/root/ponly.c', PONLY_C),
    ...writeApp('/root/pxonly.c', PXONLY_C),
    ...writeApp('/root/caonly.c', CAONLY_C),
    ...writeApp('/root/gifdec.c', GIFDEC_C),
    'cd /root',
    'mkdir -p /etc/gucman',
    `echo http://127.0.0.1:${port} > /etc/gucman/repos`,
    // absence is honest before anything is installed
    // NB no pipeline here: `cc ... | head` would make $? head's status, so
    // the leg could never fail. Redirect instead (the libpng e2e's form).
    'echo ==absent',
    'cc caonly.c 2>&1',
    'echo arc=$?',
    'cc gifdec.c 2>&1',
    'echo garc=$?',
    // 1. zlib STANDALONE — no PNG decoder required to get a compressor
    'echo ==zinstall',
    'gucman install zlib; echo ZRC=$?',
    'test -f /usr/local/include/zlib.h && echo ZLIB-INC-OK',
    'test -f /usr/local/src/z/adler32.c && echo Z-SRC-OK',
    'cc zonly.c -o zonly && ./zonly',
    'echo zrc=$?',
    // 2. libpng ON TOP of an already-installed zlib: the ownership guard.
    //    Pre-#661 this refused — libpng planted the same zlib.h and src/z.
    'echo ==pinstall',
    'gucman install libpng; echo PRC=$?',
    'test -f /usr/local/include/png.h && echo PNG-INC-OK',
    'test -f /usr/local/src/png/png.c && echo PNG-SRC-OK',
    'cc ponly.c -o ponly && ./ponly',
    'echo prc=$?',
    // 3. cairo pulls pixman + freetype through deps[]
    'echo ==cinstall',
    'gucman install cairo; echo CRC=$?',
    'test -f /usr/local/include/cairo.h && echo CAIRO-INC-OK',
    'test -f /usr/local/include/pixman.h && echo PIXMAN-INC-OK',
    'test -f /usr/local/src/cairo/config.h && echo CAIRO-CONFIG-OK',
    'test -f /usr/local/src/pixman/pixman.c && echo PIXMAN-SRC-OK',
    'cc pxonly.c -o pxonly && ./pxonly',
    'echo xrc=$?',
    'cc caonly.c -o caonly && ./caonly',
    'echo crc2=$?',
    // 4. giflib
    'echo ==ginstall',
    'gucman install giflib; echo GRC=$?',
    'cc gifdec.c -o gifdec && ./gifdec',
    'echo grc=$?',
    // 5. the dependency edges are RECORDED, not just declared
    // 2>&1: the refusal is written to stderr, which driveBoot reports
    // separately — without this the wording never reaches the assertion.
    'echo ==revdep',
    'gucman remove zlib 2>&1; echo RMRC=$?',
    'echo ==done',
    'exit',
  ].join('\n');
  const b = driveBoot(scriptB, { image: minImage, args: ['--packages=none'], timeout: 900000 });
  const bout = String(b.stdout || '');
  check('minimal session exits clean', b.status === 0,
    String(b.status) + ' ' + String(b.stderr || '').slice(-300));

  const absent = section(bout, 'absent');
  check('minimal: <cairo.h>/<gif_lib.h> fail CLEAN with nothing installed',
    /Could not find include file: cairo\.h/.test(absent) &&
    /Could not find include file: gif_lib\.h/.test(absent) &&
    /arc=[^0]/.test(absent) && /garc=[^0]/.test(absent), absent);
  const zi = section(bout, 'zinstall');
  check('minimal: gucman install zlib succeeds STANDALONE (no libpng needed)',
    zi.includes('ZRC=0') && zi.includes('ZLIB-INC-OK') && zi.includes('Z-SRC-OK'), zi);
  check('minimal: <zlib.h> compiles + runs through the installed tiers',
    /ZONLY match=1 ver=1\.3\.2/.test(zi) && zi.includes('zrc=0'), zi);
  const pi = section(bout, 'pinstall');
  check('minimal: libpng installs OVER an existing zlib (the #661 ownership split)',
    pi.includes('PRC=0') && pi.includes('PNG-INC-OK') && pi.includes('PNG-SRC-OK'), pi);
  check('minimal: <png.h> still reaches zlib after the split',
    /PONLY w=6 h=4 px5=50,30,15/.test(pi) && pi.includes('prc=0'), pi);
  const ci = section(bout, 'cinstall');
  check('minimal: gucman install cairo pulls pixman + freetype via deps[]',
    ci.includes('CRC=0') && ci.includes('CAIRO-INC-OK') && ci.includes('PIXMAN-INC-OK') &&
    ci.includes('PIXMAN-SRC-OK'), ci);
  check('minimal: cairo ships config.h INSIDE its src namespace',
    ci.includes('CAIRO-CONFIG-OK'), ci);
  check('minimal: <pixman.h> compiles + composites through the installed tiers',
    /PXONLY ver=0\.42\.2 px=ffff0000/.test(ci) && ci.includes('xrc=0'), ci);
  check('minimal: <cairo.h> compiles + draws through the installed tiers',
    /CAONLY ver=1\.18\.4 in=ffff0000 out=00000000/.test(ci) && ci.includes('crc2=0'), ci);
  const gi = section(bout, 'ginstall');
  check('minimal: giflib installs and really decodes through the tiers',
    gi.includes('GRC=0') && /GIFDEC w=2 h=2 n=1 idx=0110/.test(gi) && gi.includes('grc=0'), gi);
  const rd = section(bout, 'revdep');
  check('minimal: `gucman remove zlib` REFUSES while libpng/cairo depend on it',
    /RMRC=[^0]/.test(rd) && /cannot remove 'zlib': installed package\(s\) depend on it/.test(rd) &&
    /libpng/.test(rd) && /cairo/.test(rd), rd);

  fs.rmSync(tmpA, { recursive: true, force: true });
  fs.rmSync(tmpB, { recursive: true, force: true });
  console.log(failures ? `\ncc-imagelibs e2e: ${failures} FAILED` : '\ncc-imagelibs e2e: PASS');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e && e.stack || e);
  process.exit(1);
});
