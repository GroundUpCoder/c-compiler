#!/usr/bin/env node
// Ticket #464 acceptance: FreeType is a STANDALONE srclib package, directly
// usable from the in-OS cc with no Win32 anywhere. `#include <ft2build.h>`
// is the whole link story — the library's own header carries the guarded
// __require_source block (source-lib §4.2 as amended by #464), the names
// resolve at the srclib install tiers, and the shims' "../src/..." relative
// includes cross the symlink farms via physical-TU-path resolution exactly
// as the win32 veneer's do.
//
//   - FAT image: `cc ftdemo.c` (no -I, no TU list) builds a bare-FreeType
//     program that loads the baked mono.ttf, renders a real glyph and
//     reports its bitmap — compile AND run, end to end
//   - the FT_NO_REQUIRE_SOURCES hatch: the same compile with the guard
//     defined must FAIL AT LINK (undefined FreeType symbol) — proving the
//     header block was the link metadata, and that the hatch suppresses it
//   - MINIMAL image: cc fails CLEAN (no srclib tiers), `gucman install
//     freetype` plants headers + sources WITHOUT win32 (no /opt/win32, no
//     win32 DB record — the standalone half of the #464 split), and the
//     same compile + run works through the installed tiers
//
// Run: node tests/kernel/test_cc_freetype_e2e.js
'use strict';
const fs = require('fs');
const { driveBoot, freshImage, section } = require('./lib/drive.js');
const { ensureMinimalImage, ensurePackages, startServer } = require('./lib/gucman.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

// The acceptance app: bare FreeType, no veneer — init, load the baked mono
// face, render 'A' at 24px, report face facts + the glyph bitmap. `dark`
// counts strong-coverage pixels so the assertion is about REAL rasterizer
// output, not just a nonzero buffer pointer.
const FTDEMO_C = [
  '#include <ft2build.h>',
  '#include FT_FREETYPE_H',
  '#include <stdio.h>',
  'int main(void) {',
  '    FT_Library lib;',
  '    FT_Face face;',
  '    if (FT_Init_FreeType(&lib)) { printf("INIT-FAIL\\n"); return 1; }',
  '    if (FT_New_Face(lib, "/usr/share/fonts/mono.ttf", 0, &face)) { printf("FACE-FAIL\\n"); return 1; }',
  '    if (FT_Set_Pixel_Sizes(face, 0, 24)) { printf("SIZE-FAIL\\n"); return 1; }',
  '    if (FT_Load_Char(face, (FT_ULong)\'A\', FT_LOAD_RENDER)) { printf("GLYPH-FAIL\\n"); return 1; }',
  '    FT_Bitmap *bm = &face->glyph->bitmap;',
  '    int dark = 0;',
  '    for (unsigned r = 0; r < bm->rows; r++)',
  '        for (unsigned c = 0; c < bm->width; c++)',
  '            if (bm->buffer[r * (unsigned)bm->pitch + c] > 128) dark++;',
  '    printf("FTDEMO face=%s w=%u h=%u dark=%d\\n",',
  '           face->family_name, bm->width, bm->rows, dark);',
  '    FT_Done_Face(face);',
  '    FT_Done_FreeType(lib);',
  '    printf("FTDEMO-DONE\\n");',
  '    return 0;',
  '}',
];

const writeApp = (path, lines) => [
  `cat > ${path} << 'EOF'`, ...lines, 'EOF',
];

// A rendered 24px 'A' from a real face: nonzero box, a plausible number of
// strong-coverage pixels (an empty or garbage raster fails both ways).
const FTDEMO_RE = /FTDEMO face=\S+ w=([1-9]\d*) h=([1-9]\d*) dark=([1-9]\d*)/;

async function main() {
  /* ---- session A: the fat image (baked /usr/{include,src} tiers) ---- */
  const { dir: tmpA, image } = freshImage('os-ccft-');
  const scriptA = [
    ...writeApp('/root/ftdemo.c', FTDEMO_C),
    'echo ==cc',
    'cd /root && cc ftdemo.c -o ftdemo.out',
    'echo ccrc=$?',
    'echo ==run',
    './ftdemo.out',
    'echo runrc=$?',
    'echo ==hatch',
    // the escape hatch: with the block suppressed nothing links FreeType,
    // so the SAME program must die at link naming a FreeType symbol
    'cc -DFT_NO_REQUIRE_SOURCES ftdemo.c -o hatch.out 2>&1',
    'echo hrc=$?',
    'echo ==done',
    'exit',
  ].join('\n');
  const a = driveBoot(scriptA, { image, timeout: 420000 });
  const aout = String(a.stdout || '');
  check('fat session exits clean', a.status === 0,
    String(a.status) + ' ' + String(a.stderr || '').slice(-300));

  const cc = section(aout, 'cc');
  check('fat: cc ftdemo.c compiles (ft2build.h require block pulls the library)',
    cc.includes('ccrc=0'), cc);
  const run = section(aout, 'run');
  check('fat: the glyph really renders (face + nonzero bitmap + coverage)',
    FTDEMO_RE.test(run), run);
  check('fat: the app exits clean', run.includes('runrc=0') && run.includes('FTDEMO-DONE'), run);
  const hatch = section(aout, 'hatch');
  check('fat: FT_NO_REQUIRE_SOURCES suppresses the block (loud link error)',
    /Undefined symbol.*FT_/i.test(hatch) && /hrc=[^0]/.test(hatch), hatch);

  /* ---- session B: minimal image + gucman install freetype (NO win32) ---- */
  const repo = ensurePackages(['freetype']);
  const MIN = ensureMinimalImage();
  const { dir: tmpB, image: minImage } = freshImage('os-ccft-min-');
  fs.copyFileSync(MIN, minImage);   // copy mtime = now -> input-fresh at boot
  const goodPort = await startServer(repo.dir);

  const scriptB = [
    ...writeApp('/root/ftdemo.c', FTDEMO_C),
    'echo ==nolib',
    'cd /root && cc ftdemo.c 2>&1',
    'echo norc=$?',
    'echo ==install',
    'mkdir -p /etc/gucman',
    `echo http://127.0.0.1:${goodPort} > /etc/gucman/repos`,
    'gucman install freetype; echo IRC=$?',
    // the standalone half of the split: headers + sources planted with NO
    // win32 anywhere on the system
    'test -f /usr/local/include/ft2build.h && echo FT-INC-OK',
    'test -f /usr/local/include/freetype/freetype.h && echo FT-TREE-OK',
    'test -f /usr/local/src/freetype/ftbase.c && echo FT-SRC-OK',
    'test ! -e /opt/win32 && echo NO-WIN32-OPT',
    'test ! -e /var/lib/gucman/win32.json && echo NO-WIN32-DB',
    'echo ==cc2',
    'cc ftdemo.c -o ftdemo.out',
    'echo ccrc=$?',
    './ftdemo.out',
    'echo runrc=$?',
    'echo ==done',
    'exit',
  ].join('\n');
  const b = driveBoot(scriptB, { image: minImage, args: ['--packages=none'], timeout: 420000 });
  const bout = String(b.stdout || '');
  check('minimal session exits clean', b.status === 0,
    String(b.status) + ' ' + String(b.stderr || '').slice(-300));

  const nolib = section(bout, 'nolib');
  check('minimal: cc fails CLEAN without the freetype package',
    /norc=[^0]/.test(nolib) && /ft2build\.h/.test(nolib), nolib);

  const inst = section(bout, 'install');
  check('minimal: gucman install freetype succeeds', inst.includes('IRC=0'), inst);
  check('minimal: ft2build.h planted at the include tier', inst.includes('FT-INC-OK'), inst);
  check('minimal: freetype/ header tree planted', inst.includes('FT-TREE-OK'), inst);
  check('minimal: require-source namespace planted', inst.includes('FT-SRC-OK'), inst);
  check('minimal: install pulled NO win32 payload', inst.includes('NO-WIN32-OPT'), inst);
  check('minimal: install recorded NO win32 package', inst.includes('NO-WIN32-DB'), inst);

  const cc2 = section(bout, 'cc2');
  check('minimal: cc compiles through /usr/local/{include,src}',
    cc2.includes('ccrc=0'), cc2);
  check('minimal: the glyph renders through the installed tiers',
    FTDEMO_RE.test(cc2) && cc2.includes('runrc=0'), cc2);

  fs.rmSync(tmpA, { recursive: true, force: true });
  fs.rmSync(tmpB, { recursive: true, force: true });
  console.log(failures ? `\ncc-freetype e2e: ${failures} FAILED` : '\ncc-freetype e2e: PASS');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e && e.stack || e);
  process.exit(1);
});
