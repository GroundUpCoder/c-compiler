#!/usr/bin/env node
// cJSON as a standalone srclib package (#662): the header carries its own
// __require_source block (source-lib §4.2, the ft2build.h pattern), so the
// in-OS `cc` links the parser from a bare #include <cJSON.h> — no -I, no TU
// list.
//
//   - FAT image: jsonrt.c parses a non-trivial JSON document (nested objects,
//     arrays, number/string/bool/null), asserts the extracted values, MUTATES
//     the tree (append an array item, replace a bool), then round-trips it:
//     serialize -> re-parse -> re-serialize must be byte-identical. Plus the
//     hatch: -DCJSON_NO_REQUIRE_SOURCES must make the SAME program fail AT
//     LINK naming a cJSON symbol — the proof the header block is the link
//     metadata.
//   - MINIMAL image (no packages baked) + the served index: absence is
//     honest (<cJSON.h> fails clean), then `gucman install cjson` plants
//     /usr/local/include/cJSON.h + /usr/local/src/cjson and the same
//     program compiles and runs through the installed tiers.
//
// Run: node tests/kernel/test_cc_cjson_e2e.js
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

// <cJSON.h> ONLY — parse, extract, mutate, and round-trip a game-config
// shaped document (the epic's motivating format).
const JSONRT_C = [
  '#include <cJSON.h>',
  '#include <stdio.h>',
  '#include <string.h>',
  'static const char *DOC =',
  '"{\\"game\\":{\\"title\\":\\"gucOS Quest\\",\\"version\\":[1,7,19],"',
  '"\\"fullscreen\\":false,\\"volume\\":0.75,\\"save\\":null,"',
  '"\\"levels\\":[{\\"name\\":\\"intro\\",\\"par\\":30},{\\"name\\":\\"caves\\",\\"par\\":95}],"',
  '"\\"keys\\":{\\"up\\":\\"w\\",\\"down\\":\\"s\\"}}}";',
  'int main(void) {',
  '    cJSON *root = cJSON_Parse(DOC);',
  '    if (!root) { printf("JSONRT-PARSE-FAIL %s\\n", cJSON_GetErrorPtr()); return 1; }',
  '    cJSON *game   = cJSON_GetObjectItemCaseSensitive(root, "game");',
  '    cJSON *title  = cJSON_GetObjectItemCaseSensitive(game, "title");',
  '    cJSON *levels = cJSON_GetObjectItemCaseSensitive(game, "levels");',
  '    cJSON *par1   = cJSON_GetObjectItemCaseSensitive(cJSON_GetArrayItem(levels, 1), "par");',
  '    cJSON *vol    = cJSON_GetObjectItemCaseSensitive(game, "volume");',
  '    cJSON *save   = cJSON_GetObjectItemCaseSensitive(game, "save");',
  '    cJSON *fscr   = cJSON_GetObjectItemCaseSensitive(game, "fullscreen");',
  '    printf("JSONRT title=%s levels=%d par1=%d vol=%.2f null=%d false=%d ver=%s\\n",',
  '           cJSON_GetStringValue(title), cJSON_GetArraySize(levels),',
  '           par1->valueint, vol->valuedouble,',
  '           cJSON_IsNull(save), cJSON_IsFalse(fscr), cJSON_Version());',
  '    cJSON *nl = cJSON_CreateObject();',
  '    cJSON_AddStringToObject(nl, "name", "summit");',
  '    cJSON_AddNumberToObject(nl, "par", 120);',
  '    cJSON_AddItemToArray(levels, nl);',
  '    cJSON_ReplaceItemInObjectCaseSensitive(game, "fullscreen", cJSON_CreateTrue());',
  '    char *s1 = cJSON_PrintUnformatted(root);',
  '    cJSON *back = cJSON_Parse(s1);',
  '    if (!back) { printf("JSONRT-REPARSE-FAIL\\n"); return 1; }',
  '    char *s2 = cJSON_PrintUnformatted(back);',
  '    cJSON *blv = cJSON_GetObjectItemCaseSensitive(',
  '        cJSON_GetObjectItemCaseSensitive(back, "game"), "levels");',
  '    printf("JSONRT rt=%d len=%d levels2=%d true=%d\\n",',
  '           strcmp(s1, s2) == 0, (int)strlen(s1), cJSON_GetArraySize(blv),',
  '           cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(',
  '               cJSON_GetObjectItemCaseSensitive(back, "game"), "fullscreen")));',
  '    cJSON_free(s1); cJSON_free(s2); cJSON_Delete(back); cJSON_Delete(root);',
  '    printf("JSONRT-DONE\\n");',
  '    return 0;',
  '}',
];

const JSONRT_OK = /JSONRT title=gucOS Quest levels=2 par1=95 vol=0\.75 null=1 false=1 ver=1\.7\.19/;
const JSONRT_RT = /JSONRT rt=1 len=\d+ levels2=3 true=1/;

async function main() {
  /* ---- session A: the fat image (baked /usr/{include,src} tiers) ---- */
  const { dir: tmpA, image } = freshImage('os-cjson-');
  const scriptA = [
    ...writeApp('/root/jsonrt.c', JSONRT_C),
    'cd /root',
    'echo ==rt',
    'cc jsonrt.c -o jsonrt && ./jsonrt',
    'echo rc=$?',
    // the hatch: with the block suppressed nothing links the parser
    'echo ==hatch',
    'cc -DCJSON_NO_REQUIRE_SOURCES jsonrt.c -o hatch.out 2>&1',
    'echo hrc=$?',
    'echo ==pkgs',
    'grep -o "PACKAGES=[^ ]*" /usr/share/os-release || echo NO-PACKAGES-LINE',
    'echo ==done',
    'exit',
  ].join('\n');
  const a = driveBoot(scriptA, { image, timeout: 900000 });
  const aout = String(a.stdout || '');
  check('fat session exits clean', a.status === 0,
    String(a.status) + ' ' + String(a.stderr || '').slice(-300));

  const rt = section(aout, 'rt');
  check('fat: <cJSON.h> STANDALONE links + parses (values extracted)',
    JSONRT_OK.test(rt) && rt.includes('rc=0'), rt);
  check('fat: mutate + serialize -> re-parse -> re-serialize round-trips byte-identical',
    JSONRT_RT.test(rt) && rt.includes('JSONRT-DONE'), rt);
  const ha = section(aout, 'hatch');
  check('fat: CJSON_NO_REQUIRE_SOURCES suppresses the block (loud link error)',
    /Undefined symbol.*cJSON_/i.test(ha) && /hrc=[^0]/.test(ha), ha);
  const pkgs = section(aout, 'pkgs');
  check('fat: cjson folded as a built-in package (os-release PACKAGES=)',
    /^PACKAGES=(.*,)?cjson(,|$)/m.test(aout), pkgs);

  /* ---- session B: minimal image + the served index ---- */
  const repo = ensurePackages(['cjson']);
  const MIN = ensureMinimalImage();
  const { dir: tmpB, image: minImage } = freshImage('os-cjson-min-');
  fs.copyFileSync(MIN, minImage);   // copy mtime = now -> input-fresh at boot
  const port = await startServer(repo.dir);

  const scriptB = [
    ...writeApp('/root/jsonrt.c', JSONRT_C),
    'cd /root',
    'mkdir -p /etc/gucman',
    `echo http://127.0.0.1:${port} > /etc/gucman/repos`,
    // absence is honest before anything is installed. NB no pipeline: `cc
    // ... | head` would make $? head's status (the imagelibs e2e's rule).
    'echo ==absent',
    'cc jsonrt.c 2>&1',
    'echo arc=$?',
    'echo ==install',
    'gucman install cjson; echo IRC=$?',
    'test -f /usr/local/include/cJSON.h && echo CJSON-INC-OK',
    'test -f /usr/local/src/cjson/cJSON.c && echo CJSON-SRC-OK',
    'cc jsonrt.c -o jsonrt && ./jsonrt',
    'echo rc=$?',
    'echo ==done',
    'exit',
  ].join('\n');
  const b = driveBoot(scriptB, { image: minImage, args: ['--packages=none'], timeout: 900000 });
  const bout = String(b.stdout || '');
  check('minimal session exits clean', b.status === 0,
    String(b.status) + ' ' + String(b.stderr || '').slice(-300));

  const absent = section(bout, 'absent');
  check('minimal: <cJSON.h> fails CLEAN with nothing installed',
    /Could not find include file: cJSON\.h/.test(absent) && /arc=[^0]/.test(absent), absent);
  const inst = section(bout, 'install');
  check('minimal: gucman install cjson plants the include + src tiers',
    inst.includes('IRC=0') && inst.includes('CJSON-INC-OK') && inst.includes('CJSON-SRC-OK'), inst);
  check('minimal: <cJSON.h> compiles + round-trips through the installed tiers',
    JSONRT_OK.test(inst) && JSONRT_RT.test(inst) &&
    inst.includes('JSONRT-DONE') && inst.includes('rc=0'), inst);

  fs.rmSync(tmpA, { recursive: true, force: true });
  fs.rmSync(tmpB, { recursive: true, force: true });
  console.log(failures ? `\ncc-cjson e2e: ${failures} FAILED` : '\ncc-cjson e2e: PASS');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e && e.stack || e);
  process.exit(1);
});
