#!/usr/bin/env node
// libjpeg source-lib e2e (0448 / #93): the in-OS `cc` builds a program
// against the libjpeg package (folded "Built-in" into the fat image) with
// NO -I and NO explicit TU list — the program's own __require_source block
// pulls the jpeg TUs from /usr/src/jpeg via the FS tiers (the
// __SDL_image.c/windows.h consumer pattern; libjpeg ships no veneer, so
// the consumer carries the block), and <jpeglib.h> resolves through the
// /usr/include srclib tier.
//
// The program is a self-contained JPEG ROUND TRIP plus an error-path
// control (no window, no renderer):
//   - libjpeg ENCODES a 16x16 RGB gradient to /root/t.jpg (quality 85,
//     baseline, islow DCT — byte-deterministic; the same pixels as
//     vendor/libjpeg/testdata/gradient_16x16.*)
//   - libjpeg DECODES it back and asserts EXACT pixel values (decode of
//     a given stream by this code is deterministic — the values below
//     are from the clang-native golden gradient_16x16_dec.rgb)
//   - a truncated+garbled copy must be REJECTED through the error
//     manager (longjmp, not exit) — the positive control that the
//     decode path can really fail
//
// Run: node tests/kernel/test_cc_libjpeg_e2e.js
'use strict';
const { driveBoot, freshImage } = require('./lib/drive.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const { image } = freshImage('os-libjpeg-');

// Keep in sync with vendor/libjpeg/lib.json 'sources' (the __SDL_image.c
// rule): every library TU, resolved in-OS from /usr/src/jpeg.
const JPEG_TUS = [
  'jaricom', 'jcapimin', 'jcapistd', 'jcarith', 'jccoefct', 'jccolor',
  'jcdctmgr', 'jchuff', 'jcinit', 'jcmainct', 'jcmarker', 'jcmaster',
  'jcomapi', 'jcparam', 'jcprepct', 'jcsample', 'jctrans', 'jdapimin',
  'jdapistd', 'jdarith', 'jdatadst', 'jdatasrc', 'jdcoefct', 'jdcolor',
  'jddctmgr', 'jdhuff', 'jdinput', 'jdmainct', 'jdmarker', 'jdmaster',
  'jdmerge', 'jdpostct', 'jdsample', 'jdtrans', 'jerror', 'jfdctflt',
  'jfdctfst', 'jfdctint', 'jidctflt', 'jidctfst', 'jidctint', 'jquant1',
  'jquant2', 'jutils', 'jmemmgr', 'jmemnobs',
];

const script = [
  "cat > /root/jpgrt.c << 'EOF'",
  '#include <stdio.h>',
  '#include <stdlib.h>',
  '#include <string.h>',
  '#include <setjmp.h>',
  '#include <jpeglib.h>',
  ...JPEG_TUS.map(tu => `__require_source("jpeg/${tu}.c");`),
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
  'EOF',
  'cd /root && cc jpgrt.c -o jpgrt && ./jpgrt',
  'echo rc=$?',
  // The libjpeg package is folded "Built-in" — assert it lands in os-release.
  'echo ==pkgs',
  'grep -o "PACKAGES=[^ ]*" /usr/share/os-release || echo NO-PACKAGES-LINE',
  'echo ==done',
  'exit',
].join('\n');

const r = driveBoot(script, { image, timeout: 600000 });
check('session exits clean', r.status === 0, String(r.status) + ' ' + (r.stderr || '').slice(-300));

const lines = r.stdout.split('\n');
// Exact values from the clang-native golden gradient_16x16_dec.rgb:
// (0,0)=(1,1,1) (5,5)=(80,80,80) (10,3)=(161,47,107) (15,15)=(240,240,240).
check('cc built + ran the libjpeg round trip IN-OS (no -I, no TU list), decode exact',
  lines.some(l => l.startsWith('JPGRT w=16 h=16') && l.includes('p00=1,1,1') &&
                  l.includes('p55=80,80,80') && l.includes('pA3=161,47,107') &&
                  l.includes('pFF=240,240,240')),
  JSON.stringify(lines.filter(l => l.includes('JPGRT') || l.includes('FAIL')).slice(0, 4)));
check('corrupt JPEG rejected through the error manager (error path can fail)',
  lines.includes('JPGRT-CORRUPT-REJECTED'), JSON.stringify(lines.slice(-10)));
check('program exited clean', lines.includes('JPGRT-DONE') && lines.includes('rc=0'),
  JSON.stringify(lines.slice(-8)));
check('libjpeg folded as a Built-in package (os-release PACKAGES=)',
  /^PACKAGES=(.*,)?libjpeg(,|$)/m.test(r.stdout),
  JSON.stringify(lines.filter(l => l.includes('PACKAGES')).slice(0, 2)));

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
