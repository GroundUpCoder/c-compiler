#!/usr/bin/env node
// libjpeg srclib e2e (0448 / #93; STANDALONE link since #498): the in-OS
// `cc` builds a program against the libjpeg package with NO -I and NO
// explicit TU list — <jpeglib.h> itself carries the guarded
// __require_source block (source-lib §4.2, the #464 ft2build.h pattern),
// so including the header IS the whole link story. Before #498 this test
// hand-wrote the TU list into the program, which made it read as a
// standalone proof while proving the consumer-carries-the-block path.
//
//   - FAT image: a self-contained JPEG ROUND TRIP plus an error-path
//     control (no window, no renderer):
//       - libjpeg ENCODES a 16x16 RGB gradient to /root/t.jpg (quality 85,
//         baseline, islow DCT — byte-deterministic; the same pixels as
//         vendor/libjpeg/testdata/gradient_16x16.*)
//       - libjpeg DECODES it back and asserts EXACT pixel values (decode
//         of a given stream by this code is deterministic — the values
//         are from the clang-native golden gradient_16x16_dec.rgb)
//       - a truncated+garbled copy must be REJECTED through the error
//         manager (longjmp, not exit) — the positive control that the
//         decode path can really fail
//   - the hatch: -DJPEG_NO_REQUIRE_SOURCES suppresses the block, so the
//     SAME program must FAIL AT LINK naming a jpeg symbol
//   - MINIMAL image: <jpeglib.h> fails CLEAN (absence is honest),
//     `gucman install libjpeg` plants the include/src tiers, and the same
//     compile + run works through them
//
// Run: node tests/kernel/test_cc_libjpeg_e2e.js
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

// The round trip, STANDALONE: no __require_source anywhere in the program.
const JPGRT_C = [
  '#include <stdio.h>',
  '#include <stdlib.h>',
  '#include <string.h>',
  '#include <setjmp.h>',
  '#include <jpeglib.h>',
  'struct ej { struct jpeg_error_mgr mgr; jmp_buf jb; };',
  'static void err_exit(j_common_ptr ci) { longjmp(((struct ej *)ci->err)->jb, 1); }',
  'static unsigned char *dec(const char *path, int *w, int *h) {',
  '    FILE *f = fopen(path, "rb");',
  '    if (!f) return NULL;',
  '    struct jpeg_decompress_struct ci;',
  '    struct ej je;',
  '    ci.err = jpeg_std_error(&je.mgr);',
  '    je.mgr.error_exit = err_exit;',
  '    unsigned char *px = NULL;',
  '    if (setjmp(je.jb)) { jpeg_destroy_decompress(&ci); fclose(f); free(px); return NULL; }',
  '    jpeg_create_decompress(&ci);',
  '    jpeg_stdio_src(&ci, f);',
  '    jpeg_read_header(&ci, TRUE);',
  '    ci.out_color_space = JCS_RGB;',
  '    jpeg_start_decompress(&ci);',
  '    *w = ci.output_width; *h = ci.output_height;',
  '    px = malloc((size_t)*w * *h * 3);',
  '    while (ci.output_scanline < ci.output_height) {',
  '        JSAMPROW row = px + (size_t)ci.output_scanline * *w * 3;',
  '        jpeg_read_scanlines(&ci, &row, 1);',
  '    }',
  '    jpeg_finish_decompress(&ci);',
  '    jpeg_destroy_decompress(&ci);',
  '    fclose(f);',
  '    return px;',
  '}',
  'int main(void) {',
  '    int W = 16, H = 16;',
  '    unsigned char *buf = malloc((size_t)W * H * 3);',
  '    for (int y = 0; y < H; y++) for (int x = 0; x < W; x++) {',
  '        unsigned char *p = buf + (y * W + x) * 3;',
  '        p[0] = x * 16; p[1] = y * 16; p[2] = (x + y) * 8;',
  '    }',
  '    FILE *f = fopen("/root/t.jpg", "wb");',
  '    if (!f) { printf("OPEN-FAIL\\n"); return 1; }',
  '    struct jpeg_compress_struct co;',
  '    struct ej je;',
  '    co.err = jpeg_std_error(&je.mgr);',
  '    je.mgr.error_exit = err_exit;',
  '    if (setjmp(je.jb)) { printf("ENC-FAIL\\n"); return 1; }',
  '    jpeg_create_compress(&co);',
  '    jpeg_stdio_dest(&co, f);',
  '    co.image_width = W; co.image_height = H;',
  '    co.input_components = 3; co.in_color_space = JCS_RGB;',
  '    jpeg_set_defaults(&co);',
  '    jpeg_set_quality(&co, 85, TRUE);',
  '    jpeg_start_compress(&co, TRUE);',
  '    while (co.next_scanline < co.image_height) {',
  '        JSAMPROW row = buf + (size_t)co.next_scanline * W * 3;',
  '        jpeg_write_scanlines(&co, &row, 1);',
  '    }',
  '    jpeg_finish_compress(&co);',
  '    jpeg_destroy_compress(&co);',
  '    fclose(f);',
  '    int w, h;',
  '    unsigned char *px = dec("/root/t.jpg", &w, &h);',
  '    if (!px) { printf("DEC-FAIL\\n"); return 1; }',
  '    printf("JPGRT w=%d h=%d p00=%d,%d,%d p55=%d,%d,%d pA3=%d,%d,%d pFF=%d,%d,%d\\n",',
  '           w, h, px[0], px[1], px[2],',
  '           px[(5*16+5)*3], px[(5*16+5)*3+1], px[(5*16+5)*3+2],',
  '           px[(3*16+10)*3], px[(3*16+10)*3+1], px[(3*16+10)*3+2],',
  '           px[(15*16+15)*3], px[(15*16+15)*3+1], px[(15*16+15)*3+2]);',
  '    free(px);',
  '    /* error-path control: a truncated+garbled copy must be rejected */',
  '    FILE *in = fopen("/root/t.jpg", "rb");',
  '    fseek(in, 0, SEEK_END); long n = ftell(in); fseek(in, 0, SEEK_SET);',
  '    unsigned char *raw = malloc(n);',
  '    fread(raw, 1, n, in); fclose(in);',
  '    long bad_n = n / 3;',
  '    for (long i = 30; i < bad_n; i += 7) raw[i] ^= 0xa5;',
  '    FILE *out = fopen("/root/bad.jpg", "wb");',
  '    fwrite(raw, 1, bad_n, out); fclose(out); free(raw);',
  '    unsigned char *bad = dec("/root/bad.jpg", &w, &h);',
  '    if (bad) { printf("CORRUPT-DECODED\\n"); free(bad); return 1; }',
  '    printf("JPGRT-CORRUPT-REJECTED\\n");',
  '    printf("JPGRT-DONE\\n");',
  '    free(buf);',
  '    return 0;',
  '}',
];

// Exact values from the clang-native golden gradient_16x16_dec.rgb:
// (0,0)=(1,1,1) (5,5)=(80,80,80) (10,3)=(161,47,107) (15,15)=(240,240,240).
const JPGRT_RE_OK = (s) =>
  /JPGRT w=16 h=16/.test(s) && s.includes('p00=1,1,1') &&
  s.includes('p55=80,80,80') && s.includes('pA3=161,47,107') &&
  s.includes('pFF=240,240,240');

async function main() {
  /* ---- session A: the fat image (baked /usr/{include,src} tiers) ---- */
  const { dir: tmpA, image } = freshImage('os-libjpeg-');
  const scriptA = [
    ...writeApp('/root/jpgrt.c', JPGRT_C),
    'echo ==cc',
    'cd /root && cc jpgrt.c -o jpgrt && ./jpgrt',
    'echo rc=$?',
    // the hatch: with the block suppressed nothing links libjpeg, so the
    // SAME program must die at link naming a jpeg symbol
    'echo ==hatch',
    'cc -DJPEG_NO_REQUIRE_SOURCES jpgrt.c -o hatch.out 2>&1',
    'echo hrc=$?',
    // The libjpeg package is folded "Built-in" — assert it lands in os-release.
    'echo ==pkgs',
    'grep -o "PACKAGES=[^ ]*" /usr/share/os-release || echo NO-PACKAGES-LINE',
    'echo ==done',
    'exit',
  ].join('\n');
  const a = driveBoot(scriptA, { image, timeout: 800000 });
  const aout = String(a.stdout || '');
  check('fat session exits clean', a.status === 0,
    String(a.status) + ' ' + String(a.stderr || '').slice(-300));

  const cc = section(aout, 'cc');
  check('fat: <jpeglib.h> STANDALONE round trip, decode exact (#498, no -I, no TU list)',
    JPGRT_RE_OK(cc), cc.slice(0, 600));
  check('fat: corrupt JPEG rejected through the error manager (error path can fail)',
    cc.includes('JPGRT-CORRUPT-REJECTED'), cc.slice(-400));
  check('fat: program exited clean', cc.includes('JPGRT-DONE') && cc.includes('rc=0'),
    cc.slice(-400));
  const hatch = section(aout, 'hatch');
  check('fat: JPEG_NO_REQUIRE_SOURCES suppresses the block (loud link error)',
    /Undefined symbol.*jpeg_/i.test(hatch) && /hrc=[^0]/.test(hatch), hatch);
  check('fat: libjpeg folded as a Built-in package (os-release PACKAGES=)',
    /^PACKAGES=(.*,)?libjpeg(,|$)/m.test(aout), section(aout, 'pkgs'));

  /* ---- session B: minimal image + gucman install libjpeg ---- */
  const repo = ensurePackages(['libjpeg']);
  const MIN = ensureMinimalImage();
  const { dir: tmpB, image: minImage } = freshImage('os-libjpeg-min-');
  fs.copyFileSync(MIN, minImage);   // copy mtime = now -> input-fresh at boot
  const goodPort = await startServer(repo.dir);

  const scriptB = [
    ...writeApp('/root/jpgrt.c', JPGRT_C),
    'echo ==nolib',
    'cd /root && cc jpgrt.c 2>&1',
    'echo norc=$?',
    'echo ==install',
    'mkdir -p /etc/gucman',
    `echo http://127.0.0.1:${goodPort} > /etc/gucman/repos`,
    'gucman install libjpeg; echo IRC=$?',
    'test -f /usr/local/include/jpeglib.h && echo JPEG-INC-OK',
    'test -f /usr/local/src/jpeg/jdapimin.c && echo JPEG-SRC-OK',
    'echo ==cc2',
    'cc jpgrt.c -o jpgrt && ./jpgrt',
    'echo rc=$?',
    'echo ==done',
    'exit',
  ].join('\n');
  const b = driveBoot(scriptB, { image: minImage, args: ['--packages=none'], timeout: 800000 });
  const bout = String(b.stdout || '');
  check('minimal session exits clean', b.status === 0,
    String(b.status) + ' ' + String(b.stderr || '').slice(-300));

  const nolib = section(bout, 'nolib');
  check('minimal: <jpeglib.h> fails CLEAN without the libjpeg package',
    /norc=[^0]/.test(nolib) && /jpeglib\.h/.test(nolib), nolib);
  const inst = section(bout, 'install');
  check('minimal: gucman install libjpeg succeeds', inst.includes('IRC=0'), inst);
  check('minimal: jpeglib.h planted at the include tier', inst.includes('JPEG-INC-OK'), inst);
  check('minimal: jpeg require namespace planted', inst.includes('JPEG-SRC-OK'), inst);
  const cc2 = section(bout, 'cc2');
  check('minimal: the round trip works through /usr/local/{include,src}',
    JPGRT_RE_OK(cc2) && cc2.includes('JPGRT-DONE') && cc2.includes('rc=0'),
    cc2.slice(0, 600));

  fs.rmSync(tmpA, { recursive: true, force: true });
  fs.rmSync(tmpB, { recursive: true, force: true });
  console.log(failures ? `\ncc-libjpeg e2e: ${failures} FAILED` : '\ncc-libjpeg e2e: PASS');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e && e.stack || e);
  process.exit(1);
});
