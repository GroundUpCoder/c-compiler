#!/usr/bin/env node
// libpng + zlib srclib e2e (Minesweeper lane; STANDALONE link since #498).
// <png.h> and <zlib.h> carry their own guarded __require_source blocks
// (source-lib §4.2, the #464 ft2build.h pattern), so the in-OS `cc` links
// each of them standalone — no -I, no TU list, no __require_source in the
// user program — and the SDL3_image veneer reaches libpng through its own
// #include <png.h> rather than a second copy of the metadata.
//
//   - FAT image: three programs compile AND run end to end:
//       pngrt.c  — libpng write → SDL_image IMG_Load read (the veneer
//                  chain an unmodified SDL3 game uses; pixel + owned-free
//                  asserts as before #498)
//       ponly.c  — <png.h> ONLY: simplified-API write → read round trip
//       zonly.c  — <zlib.h> ONLY: compress → uncompress round trip, a
//                  gz* file round trip + inflateBack linkage (#631)
//   - the hatches: -DPNG_NO_REQUIRE_SOURCES / -DZLIB_NO_REQUIRE_SOURCES
//     suppress the blocks, so the SAME programs must FAIL AT LINK naming a
//     library symbol — proving the header blocks are the link metadata
//   - MINIMAL image: a <SDL3/SDL.h>-only program links and runs with NO
//     libpng anywhere (the compiler.js "SDL stays libpng-free" intent,
//     measured on the one image that can prove absence), <png.h> fails
//     CLEAN (absence is honest), `gucman install libpng` plants both
//     include/src tiers, and the standalone programs work through them
//
// Run: node tests/kernel/test_cc_libpng_e2e.js
'use strict';
const fs = require('fs');
const { driveBoot, freshImage, section } = require('./lib/drive.js');
const { ensureMinimalImage, ensurePackages, startServer } = require('./lib/gucman.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const writeApp = (path, lines) => [
  `cat > ${path} << 'EOF'`, ...lines, 'EOF',
];

// The veneer-chain program (pre-#498 body, unchanged): libpng write,
// SDL_image read, exact pixel + owned-surface asserts.
const PNGRT_C = [
  '#include <SDL3/SDL.h>',
  '#include <SDL3_image/SDL_image.h>',
  '#include <png.h>',
  '#include <stdio.h>',
  '#include <stdlib.h>',
  '#include <string.h>',
  'int main(void) {',
  '    int W = 6, H = 4;',
  '    unsigned char *buf = malloc((size_t)W * H * 4);',
  '    for (int i = 0; i < W * H; i++) {',
  '        buf[i*4+0] = (unsigned char)(i * 10);',
  '        buf[i*4+1] = (unsigned char)(i * 6);',
  '        buf[i*4+2] = (unsigned char)(i * 3);',
  '        buf[i*4+3] = 255;',
  '    }',
  '    png_image wi; memset(&wi, 0, sizeof wi); wi.version = PNG_IMAGE_VERSION;',
  '    wi.width = (png_uint_32)W; wi.height = (png_uint_32)H; wi.format = PNG_FORMAT_RGBA;',
  '    if (!png_image_write_to_file(&wi, "/root/t.png", 0, buf, 0, NULL)) {',
  '        printf("WRITE-FAIL %s\\n", wi.message); return 1;',
  '    }',
  '    SDL_Surface *s = IMG_Load("/root/t.png");',
  '    if (!s) { printf("READ-FAIL %s\\n", IMG_GetError()); return 1; }',
  '    unsigned char *px = (unsigned char *)s->pixels;',
  '    printf("PNGRT w=%d h=%d pitch=%d fmt=%u px5=%d,%d,%d owned=%d\\n",',
  '           s->w, s->h, s->pitch, s->format,',
  '           px[5*4+0], px[5*4+1], px[5*4+2], (int)((s->flags & IMG_SURFACE_OWNED) != 0));',
  '    SDL_DestroySurface(s);',
  '    printf("PNGRT-DONE\\n");',
  '    free(buf);',
  '    return 0;',
  '}',
];

// <png.h> ONLY (the ticket #498 defect row): simplified-API write, then
// read back through libpng itself — no SDL, no SDL_image, no TU list.
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

// <zlib.h> ONLY: compress → uncompress round trip + zlibVersion (the
// ticket's own probe symbols), plus — since #631 promoted the gz* file
// layer and infback into lib.json — a gzopen/gzwrite/gzprintf/gzclose →
// gzopen/gzread file round trip and an inflateBackInit/End linkage check:
// every API this header declares must link.
const ZONLY_C = [
  '#include <zlib.h>',
  '#include <stdio.h>',
  '#include <string.h>',
  'static unsigned char ibwin[32768];',
  'int main(void) {',
  '    const char *msg = "gucos zlib standalone round trip 0123456789";',
  '    unsigned char comp[256]; uLongf clen = sizeof comp;',
  '    if (compress(comp, &clen, (const Bytef *)msg, (uLong)strlen(msg) + 1) != Z_OK) {',
  '        printf("ZONLY-COMPRESS-FAIL\\n"); return 1; }',
  '    char back[256]; uLongf blen = sizeof back;',
  '    if (uncompress((Bytef *)back, &blen, comp, clen) != Z_OK) {',
  '        printf("ZONLY-UNCOMPRESS-FAIL\\n"); return 1; }',
  '    gzFile g = gzopen("/root/zt.gz", "wb");',
  '    if (!g || gzwrite(g, msg, (unsigned)strlen(msg) + 1) <= 0 ||',
  '        gzprintf(g, "line2 %d", 631) <= 0 || gzclose(g) != Z_OK) {',
  '        printf("ZONLY-GZWRITE-FAIL\\n"); return 1; }',
  '    char gback[256]; memset(gback, 0, sizeof gback);',
  '    g = gzopen("/root/zt.gz", "rb");',
  '    int gn = g ? gzread(g, gback, sizeof gback) : -1;',
  '    if (!g || gzclose(g) != Z_OK || gn <= 0) {',
  '        printf("ZONLY-GZREAD-FAIL\\n"); return 1; }',
  '    int gz = strcmp(gback, msg) == 0 &&',
  '        strcmp(gback + strlen(msg) + 1, "line2 631") == 0;',
  '    z_stream ib; ib.zalloc = Z_NULL; ib.zfree = Z_NULL; ib.opaque = Z_NULL;',
  '    int iback = inflateBackInit(&ib, 15, ibwin) == Z_OK &&',
  '        inflateBackEnd(&ib) == Z_OK;',
  '    printf("ZONLY clen=%lu match=%d gz=%d iback=%d ver=%s\\n", (unsigned long)clen,',
  '           strcmp(back, msg) == 0, gz, iback, zlibVersion());',
  '    printf("ZONLY-DONE\\n");',
  '    return 0;',
  '}',
];

// <SDL3/SDL.h> ONLY — the libpng-free control. Links the SDL veneer and
// runs (no window, no init) on an image with NO libpng package anywhere.
const SDLONLY_C = [
  '#include <SDL3/SDL.h>',
  '#include <stdio.h>',
  'int main(void) {',
  '    printf("SDLONLY err=%d\\n", (int)(SDL_GetError() != 0));',
  '    printf("SDLONLY-DONE\\n");',
  '    return 0;',
  '}',
];

async function main() {
  /* ---- session A: the fat image (baked /usr/{include,src} tiers) ---- */
  const { dir: tmpA, image } = freshImage('os-libpng-');
  const scriptA = [
    ...writeApp('/root/pngrt.c', PNGRT_C),
    ...writeApp('/root/ponly.c', PONLY_C),
    ...writeApp('/root/zonly.c', ZONLY_C),
    'echo ==sdlimg',
    'cd /root && cc pngrt.c -o pngrt && ./pngrt',
    'echo rc=$?',
    'echo ==ponly',
    'cc ponly.c -o ponly && ./ponly',
    'echo prc=$?',
    'echo ==zonly',
    'cc zonly.c -o zonly && ./zonly',
    'echo zrc=$?',
    // the hatches: with a block suppressed nothing links that library, so
    // the SAME programs must die at link naming a library symbol
    'echo ==phatch',
    'cc -DPNG_NO_REQUIRE_SOURCES ponly.c -o phatch.out 2>&1',
    'echo phrc=$?',
    'echo ==zhatch',
    'cc -DZLIB_NO_REQUIRE_SOURCES zonly.c -o zhatch.out 2>&1',
    'echo zhrc=$?',
    // The libpng package is folded "Built-in" — assert it lands in os-release.
    'echo ==pkgs',
    'grep -o "PACKAGES=[^ ]*" /usr/share/os-release || echo NO-PACKAGES-LINE',
    'echo ==done',
    'exit',
  ].join('\n');
  const a = driveBoot(scriptA, { image, timeout: 800000 });
  const aout = String(a.stdout || '');
  check('fat session exits clean', a.status === 0,
    String(a.status) + ' ' + String(a.stderr || '').slice(-300));

  // pixel 5 was written as (50,30,15,255); RGBA8 PNG round-trips exactly.
  const sdlimg = section(aout, 'sdlimg');
  check('fat: SDL_image veneer round trip still works (metadata via <png.h>)',
    /PNGRT w=6 h=4 pitch=24 fmt=\d+ px5=50,30,15 owned=1/.test(sdlimg) &&
    sdlimg.includes('PNGRT-DONE') && sdlimg.includes('rc=0'), sdlimg);
  const ponly = section(aout, 'ponly');
  check('fat: <png.h> STANDALONE links + round-trips (#498, no -I, no TU list)',
    /PONLY w=6 h=4 px5=50,30,15/.test(ponly) && ponly.includes('PONLY-DONE') &&
    ponly.includes('prc=0'), ponly);
  const zonly = section(aout, 'zonly');
  check('fat: <zlib.h> STANDALONE links + round-trips incl. gz*/infback (#498/#631)',
    /ZONLY clen=[1-9]\d* match=1 gz=1 iback=1 ver=1\./.test(zonly) && zonly.includes('ZONLY-DONE') &&
    zonly.includes('zrc=0'), zonly);
  const phatch = section(aout, 'phatch');
  check('fat: PNG_NO_REQUIRE_SOURCES suppresses the block (loud link error)',
    /Undefined symbol.*png_/i.test(phatch) && /phrc=[^0]/.test(phatch), phatch);
  const zhatch = section(aout, 'zhatch');
  check('fat: ZLIB_NO_REQUIRE_SOURCES suppresses the block (loud link error)',
    /Undefined symbol.*(compress|uncompress|zlibVersion)/i.test(zhatch) &&
    /zhrc=[^0]/.test(zhatch), zhatch);
  check('fat: libpng folded as a Built-in package (os-release PACKAGES=)',
    /^PACKAGES=(.*,)?libpng(,|$)/m.test(aout), section(aout, 'pkgs'));

  /* ---- session B: minimal image — absence honest, SDL libpng-free,
   *      then gucman install libpng and the standalone programs work ---- */
  const repo = ensurePackages(['libpng']);
  const MIN = ensureMinimalImage();
  const { dir: tmpB, image: minImage } = freshImage('os-libpng-min-');
  fs.copyFileSync(MIN, minImage);   // copy mtime = now -> input-fresh at boot
  const goodPort = await startServer(repo.dir);

  const scriptB = [
    ...writeApp('/root/sdlonly.c', SDLONLY_C),
    ...writeApp('/root/ponly.c', PONLY_C),
    ...writeApp('/root/zonly.c', ZONLY_C),
    // the compiler.js intent, on the one image that can PROVE absence: a
    // program including only <SDL3/SDL.h> links and runs with no libpng
    // package installed anywhere
    'echo ==sdlfree',
    'cd /root && cc sdlonly.c -o sdlonly && ./sdlonly',
    'echo src=$?',
    'echo ==nolib',
    'cc ponly.c 2>&1',
    'echo norc=$?',
    'echo ==install',
    'mkdir -p /etc/gucman',
    `echo http://127.0.0.1:${goodPort} > /etc/gucman/repos`,
    'gucman install libpng; echo IRC=$?',
    'test -f /usr/local/include/png.h && echo PNG-INC-OK',
    'test -f /usr/local/include/zlib.h && echo ZLIB-INC-OK',
    'test -f /usr/local/src/png/png.c && echo PNG-SRC-OK',
    'test -f /usr/local/src/z/adler32.c && echo Z-SRC-OK',
    'echo ==cc2',
    'cc ponly.c -o ponly && ./ponly',
    'echo prc=$?',
    'cc zonly.c -o zonly && ./zonly',
    'echo zrc=$?',
    'echo ==done',
    'exit',
  ].join('\n');
  const b = driveBoot(scriptB, { image: minImage, args: ['--packages=none'], timeout: 800000 });
  const bout = String(b.stdout || '');
  check('minimal session exits clean', b.status === 0,
    String(b.status) + ' ' + String(b.stderr || '').slice(-300));

  const sdlfree = section(bout, 'sdlfree');
  check('minimal: <SDL3/SDL.h>-only program links + runs LIBPNG-FREE',
    sdlfree.includes('SDLONLY err=') && sdlfree.includes('SDLONLY-DONE') &&
    sdlfree.includes('src=0'), sdlfree);
  const nolib = section(bout, 'nolib');
  check('minimal: <png.h> fails CLEAN without the libpng package',
    /norc=[^0]/.test(nolib) && /png\.h/.test(nolib), nolib);
  const inst = section(bout, 'install');
  check('minimal: gucman install libpng succeeds', inst.includes('IRC=0'), inst);
  check('minimal: png.h + zlib.h planted at the include tier',
    inst.includes('PNG-INC-OK') && inst.includes('ZLIB-INC-OK'), inst);
  check('minimal: png + z require namespaces planted',
    inst.includes('PNG-SRC-OK') && inst.includes('Z-SRC-OK'), inst);
  const cc2 = section(bout, 'cc2');
  check('minimal: <png.h> standalone works through /usr/local/{include,src}',
    /PONLY w=6 h=4 px5=50,30,15/.test(cc2) && cc2.includes('prc=0'), cc2);
  check('minimal: <zlib.h> standalone works through the installed tiers',
    /ZONLY clen=[1-9]\d* match=1 gz=1 iback=1 ver=1\./.test(cc2) && cc2.includes('zrc=0'), cc2);

  fs.rmSync(tmpA, { recursive: true, force: true });
  fs.rmSync(tmpB, { recursive: true, force: true });
  console.log(failures ? `\ncc-libpng e2e: ${failures} FAILED` : '\ncc-libpng e2e: PASS');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e && e.stack || e);
  process.exit(1);
});
