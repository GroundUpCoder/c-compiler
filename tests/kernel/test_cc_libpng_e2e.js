#!/usr/bin/env node
// libpng source-lib + SDL3_image builtin veneer e2e (Minesweeper-SDL3 lane):
// the in-OS `cc` builds a program that uses the libpng package (folded
// "Built-in" into the fat image) AND the builtin <SDL3_image/SDL_image.h>
// veneer, with NO -I and NO explicit TU list — the SDL_image header's
// __require_source block pulls libpng+zlib from /usr/src via the FS tiers,
// exactly as an unmodified SDL3 game does.
//
// The program is a self-contained PNG ROUND TRIP (no window, no renderer):
//   - libpng's simplified API writes a 6x4 RGBA gradient to /root/t.png
//   - SDL3_image's IMG_Load reads it back into a heap RGBA32 SDL_Surface
//   - assert dimensions + a decoded pixel + that SDL_DestroySurface reclaims it
// This exercises the whole veneer/package chain that the game relies on
// (decode path, IMG_SURFACE_OWNED free) without any display dependency.
//
// Run: node tests/kernel/test_cc_libpng_e2e.js
'use strict';
const { driveBoot, freshImage } = require('./lib/drive.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const { image } = freshImage('os-libpng-');

const script = [
  "cat > /root/pngrt.c << 'EOF'",
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
  'EOF',
  'cd /root && cc pngrt.c -o pngrt && ./pngrt',
  'echo rc=$?',
  // The libpng package is folded "Built-in" — assert it lands in os-release.
  'echo ==pkgs',
  'grep -o "PACKAGES=[^ ]*" /usr/share/os-release || echo NO-PACKAGES-LINE',
  'echo ==done',
  'exit',
].join('\n');

const r = driveBoot(script, { image, timeout: 600000 });
check('session exits clean', r.status === 0, String(r.status) + ' ' + (r.stderr || '').slice(-300));

const lines = r.stdout.split('\n');
// pixel 5 was written as (50,30,15,255); RGBA8 PNG round-trips exactly.
check('cc built + ran the libpng/SDL_image round trip IN-OS (no -I, no TU list)',
  lines.some(l => l.startsWith('PNGRT w=6 h=4 pitch=24 fmt=') && l.includes('px5=50,30,15') && l.includes('owned=1')),
  JSON.stringify(lines.filter(l => l.includes('PNGRT') || l.includes('FAIL')).slice(0, 4)));
check('SDL_DestroySurface reclaimed the owned surface (no crash after free)',
  lines.includes('PNGRT-DONE') && lines.includes('rc=0'),
  JSON.stringify(lines.slice(-8)));
check('libpng folded as a Built-in package (os-release PACKAGES=)',
  /^PACKAGES=(.*,)?libpng(,|$)/m.test(r.stdout), JSON.stringify(lines.filter(l => l.includes('PACKAGES')).slice(0, 2)));

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
