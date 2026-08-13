#!/usr/bin/env node
// SDL3 trivial-absence batch e2e (#601): the 11-name register slice — batch
// draw calls (RenderFillRects/RenderRects/RenderLines/RenderPoints), state
// getters (GetRenderDrawColor, GetWindowFlags), the allocation family
// (SDL_malloc/calloc/realloc over the SDL_free heap), SDL_rand/srand (+
// rand_bits/randf), SDL_Log-to-stderr, and GetBasePath/GetPrefPath over the
// real fs — one app built by the in-OS cc (the test_sdl_render_e2e harness).
//
//   - console run (fd 2 redirected): allocation contracts, deterministic
//     re-seeded SDL_rand sequences in [0,n), SDL_Log lands on STDERR only,
//     BASE=/root/ for a /root/util spawn, PREF dirs really created under
//     $HOME with trailing slashes
//   - a /root/ulink symlink run proves GetBasePath chases argv[0] links
//     (the user32 res_chase precedent)
//   - windowed run: GetWindowFlags returns exactly the create flags,
//     GetRenderDrawColor defaults to white then round-trips, and the four
//     batch draws land pixel-exact in a `wmctl shot` (fills, outline edges
//     with untouched interiors, point gaps, connected polyline segments)
//
// Run: node tests/kernel/test_sdl_util_e2e.js
'use strict';
const { driveBoot, freshImage } = require('./lib/drive.js');
const { parsePng } = require('../lib/png.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const { image } = freshImage('os-sdlutil-');

const scriptA = [
  "cat > /root/util.c << 'EOF'",
  '#include <SDL3/SDL.h>',
  '#include <stdio.h>',
  '#include <string.h>',
  '#include <sys/stat.h>',
  '',
  'static int fails = 0;',
  'static void chk(const char *name, int cond) {',
  '    printf("%s %s\\n", cond ? "ok" : "FAIL", name);',
  '    if (!cond) fails++;',
  '}',
  '',
  'static int console_main(void) {',
  '    void *p0 = SDL_malloc(0);',
  '    chk("SDL_malloc(0) non-NULL", p0 != NULL);',
  '    SDL_free(p0);',
  '    char *pm = (char *)SDL_malloc(16);',
  '    chk("SDL_malloc works", pm != NULL);',
  '    strcpy(pm, "hello");',
  '    pm = (char *)SDL_realloc(pm, 4096);',
  '    chk("SDL_realloc preserves contents", pm && strcmp(pm, "hello") == 0);',
  '    SDL_free(pm);',
  '    unsigned char *pc = (unsigned char *)SDL_calloc(8, 8);',
  '    int zeroed = pc != NULL;',
  '    for (int i = 0; pc && i < 64; i++) if (pc[i]) zeroed = 0;',
  '    chk("SDL_calloc zeroes", zeroed);',
  '    SDL_free(pc);',
  '    void *pr = SDL_realloc(NULL, 8);',
  '    chk("SDL_realloc(NULL) mallocs", pr != NULL);',
  '    SDL_free(pr);',
  '',
  '    SDL_srand(42);',
  '    Sint32 seq1[8], seq2[8];',
  '    int inrange = 1;',
  '    for (int i = 0; i < 8; i++) { seq1[i] = SDL_rand(100); if (seq1[i] < 0 || seq1[i] >= 100) inrange = 0; }',
  '    SDL_srand(42);',
  '    for (int i = 0; i < 8; i++) seq2[i] = SDL_rand(100);',
  '    chk("SDL_rand stays in [0,100)", inrange);',
  '    chk("SDL_srand reseeds deterministically", memcmp(seq1, seq2, sizeof seq1) == 0);',
  '    int varies = 0;',
  '    for (int i = 1; i < 8; i++) if (seq1[i] != seq1[0]) varies = 1;',
  '    chk("SDL_rand varies", varies);',
  '    chk("SDL_rand_bits varies", SDL_rand_bits() != SDL_rand_bits());',
  '    int fok = 1;',
  '    for (int i = 0; i < 32; i++) { float f = SDL_randf(); if (!(f >= 0.0f && f < 1.0f)) fok = 0; }',
  '    chk("SDL_randf stays in [0,1)", fok);',
  '',
  '    SDL_Log("log line %d %s", 42, "ok");',
  '',
  '    const char *base = SDL_GetBasePath();',
  '    printf("BASE %s\\n", base ? base : "(null)");',
  '    char *pref = SDL_GetPrefPath("guc", "utiltest");',
  '    printf("PREF %s\\n", pref ? pref : "(null)");',
  '    if (pref) {',
  '        struct stat st;',
  '        chk("pref dir exists", stat(pref, &st) == 0 && S_ISDIR(st.st_mode));',
  '        chk("pref ends with a slash", pref[strlen(pref) - 1] == 47);',
  '        SDL_free(pref);',
  '    } else { chk("pref dir exists", 0); chk("pref ends with a slash", 0); }',
  '    char *pref2 = SDL_GetPrefPath(NULL, "noorg");',
  '    printf("PREF2 %s\\n", pref2 ? pref2 : "(null)");',
  '    if (pref2) SDL_free(pref2);',
  '    printf("CON-DONE fails=%d\\n", fails);',
  '    return fails ? 1 : 0;',
  '}',
  '',
  'static int win_main(void) {',
  '    if (!SDL_Init(SDL_INIT_VIDEO)) { printf("INIT-FAIL %s\\n", SDL_GetError()); return 2; }',
  '    SDL_Window *w = SDL_CreateWindow("utilbox", 128, 96, SDL_WINDOW_RESIZABLE | SDL_WINDOW_TRANSPARENT);',
  '    if (!w) { printf("WIN-FAIL %s\\n", SDL_GetError()); return 2; }',
  '    SDL_WindowFlags wf = SDL_GetWindowFlags(w);',
  '    chk("GetWindowFlags returns the create flags",',
  '        (wf & SDL_WINDOW_RESIZABLE) && (wf & SDL_WINDOW_TRANSPARENT));',
  '    chk("GetWindowFlags invents nothing",',
  '        (wf & ~(SDL_WINDOW_RESIZABLE | SDL_WINDOW_TRANSPARENT)) == 0);',
  '    SDL_Renderer *r = SDL_CreateRenderer(w, NULL);',
  '    if (!r) { printf("RDR-FAIL %s\\n", SDL_GetError()); return 2; }',
  '    Uint8 cr, cg, cb, ca;',
  '    chk("GetRenderDrawColor defaults to white",',
  '        SDL_GetRenderDrawColor(r, &cr, &cg, &cb, &ca) && cr == 255 && cg == 255 && cb == 255 && ca == 255);',
  '    SDL_SetRenderDrawColor(r, 10, 20, 30, 255);',
  '    SDL_GetRenderDrawColor(r, &cr, &cg, &cb, &ca);',
  '    chk("GetRenderDrawColor round-trips", cr == 10 && cg == 20 && cb == 30 && ca == 255);',
  '    chk("GetRenderDrawColor takes NULL outs", SDL_GetRenderDrawColor(r, NULL, NULL, NULL, NULL));',
  '',
  '    SDL_SetRenderDrawColor(r, 20, 20, 20, 255);',
  '    SDL_RenderClear(r);',
  '    SDL_SetRenderDrawColor(r, 200, 0, 0, 255);',
  '    SDL_FRect frs[2] = { { 8, 8, 16, 16 }, { 40, 8, 16, 16 } };',
  '    chk("RenderFillRects", SDL_RenderFillRects(r, frs, 2));',
  '    SDL_SetRenderDrawColor(r, 0, 200, 0, 255);',
  '    SDL_FRect ors[2] = { { 72, 8, 16, 16 }, { 96, 8, 16, 16 } };',
  '    chk("RenderRects", SDL_RenderRects(r, ors, 2));',
  '    SDL_SetRenderDrawColor(r, 255, 255, 255, 255);',
  '    SDL_FPoint pts[3] = { { 8, 40 }, { 10, 40 }, { 12, 40 } };',
  '    chk("RenderPoints", SDL_RenderPoints(r, pts, 3));',
  '    SDL_SetRenderDrawColor(r, 0, 0, 200, 255);',
  '    SDL_FPoint ln[3] = { { 8.5f, 60.5f }, { 40.5f, 60.5f }, { 40.5f, 80.5f } };',
  '    chk("RenderLines", SDL_RenderLines(r, ln, 3));',
  '    chk("RenderLines rejects NULL points", !SDL_RenderLines(r, NULL, 2));',
  '    chk("RenderPoints accepts count 0", SDL_RenderPoints(r, pts, 0));',
  '    SDL_RenderPresent(r);',
  '    printf("WIN-UP fails=%d\\n", fails);',
  '    fflush(stdout);',
  '    for (;;) { SDL_Event e; if (SDL_WaitEvent(&e) && e.type == SDL_EVENT_QUIT) break; }',
  '    SDL_Quit();',
  '    return 0;',
  '}',
  '',
  'int main(int argc, char **argv) {',
  '    if (argc > 1 && strcmp(argv[1], "win") == 0) return win_main();',
  '    if (argc > 1 && strcmp(argv[1], "base") == 0) {',
  '        const char *b = SDL_GetBasePath();',
  '        printf("BASE2 %s\\n", b ? b : "(null)");',
  '        return 0;',
  '    }',
  '    return console_main();',
  '}',
  'EOF',
  'cc /root/util.c -o /root/util && echo CC-OK',
  '/root/util con 2>/root/log.txt',
  'echo LOGFILE-BEGIN',
  'cat /root/log.txt',
  'echo LOGFILE-END',
  'ln -s /root/util /root/ulink',
  '/root/ulink base',
  '/root/util win &',
  'wmctl wait win utilbox 15000',
  'SID=$(wmctl list | grep "utilbox$" | sed "s/[^0-9].*//")',
  'wmctl wait seq $SID 1 8000',
  'wmctl shot $SID /root/util.png && echo shot-ok',
  '',
].join('\n');

const a = driveBoot(scriptA, { image, timeout: 600000 });
check('session exits clean', a.status === 0, String(a.status) + ' ' + (a.stderr || '').slice(-300));
check('cc built the util app in-OS', a.stdout.includes('CC-OK'),
  (a.stdout.match(/error[^\n]*/gi) || []).slice(0, 5).join('; '));
check('console checks all passed (CON-DONE fails=0)', a.stdout.includes('CON-DONE fails=0'),
  (a.stdout.match(/FAIL [^\n]*/g) || []).join('; '));

// SDL_Log went to STDERR: the line appears only inside the catted log file,
// never in the app's un-redirected stdout stream before LOGFILE-BEGIN.
const logIdx = a.stdout.indexOf('log line 42 ok');
const beginIdx = a.stdout.indexOf('LOGFILE-BEGIN');
check('SDL_Log line landed in the fd-2 capture', logIdx >= 0 && beginIdx >= 0 && logIdx > beginIdx,
  'logIdx=' + logIdx + ' beginIdx=' + beginIdx);

check('GetBasePath resolves the binary dir', a.stdout.includes('BASE /root/'),
  (a.stdout.match(/BASE [^\n]*/) || []).join(''));
check('GetBasePath chases the argv[0] symlink', a.stdout.includes('BASE2 /root/'),
  (a.stdout.match(/BASE2 [^\n]*/) || []).join(''));
check('GetPrefPath builds the org/app dir', a.stdout.includes('PREF /root/.local/share/guc/utiltest/'),
  (a.stdout.match(/PREF [^\n]*/) || []).join(''));
check('GetPrefPath accepts a NULL org', a.stdout.includes('PREF2 /root/.local/share/noorg/'),
  (a.stdout.match(/PREF2 [^\n]*/) || []).join(''));
check('windowed checks all passed (WIN-UP fails=0)', a.stdout.includes('WIN-UP fails=0'),
  (a.stdout.match(/(INIT|WIN|RDR)-FAIL[^\n]*/g) || []).join('; '));
check('shot written', a.stdout.includes('shot-ok'));

/* ---- session B: extract the PNG shot and probe the batch-draw scene ---- */
if (failures === 0) {
  const b = driveBoot('cat /root/util.png\n',
    { image, encoding: null, timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
  const buf = b.stdout;
  let shot = null;
  try { shot = parsePng(buf, 0); } catch (e) { /* short/garbled output */ }
  check('shot parses as PNG at client size 128x96',
    shot !== null && shot.w === 128 && shot.h === 96,
    shot ? shot.w + 'x' + shot.h : 'undecodable');
  if (shot) {
    const px = (x, y) => shot.px(x, y).slice(0, 3);
    const eq = (p, r, g, bch) => p[0] === r && p[1] === g && p[2] === bch;
    const probe = (name, x, y, r, g, bch) =>
      check(name, eq(px(x, y), r, g, bch), `(${x},${y}) = ${px(x, y)} want (${r},${g},${bch})`);

    probe('clear color intact away from the draws', 64, 90, 20, 20, 20);
    probe('FillRects rect 1 filled', 16, 16, 200, 0, 0);
    probe('FillRects rect 2 filled', 48, 16, 200, 0, 0);
    probe('RenderRects rect 1 top edge', 80, 8, 0, 200, 0);
    probe('RenderRects rect 2 top edge', 104, 8, 0, 200, 0);
    probe('RenderRects interior untouched', 80, 16, 20, 20, 20);
    probe('RenderPoints point at (8,40)', 8, 40, 255, 255, 255);
    probe('RenderPoints point at (10,40)', 10, 40, 255, 255, 255);
    probe('RenderPoints gap at (9,40) untouched', 9, 40, 20, 20, 20);
    probe('RenderLines horizontal segment', 20, 60, 0, 0, 200);
    probe('RenderLines connected vertical segment', 40, 70, 0, 0, 200);
    probe('RenderLines off-line pixel untouched', 20, 63, 20, 20, 20);
  }
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
