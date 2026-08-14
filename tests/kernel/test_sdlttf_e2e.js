#!/usr/bin/env node
// Ticket #468 acceptance: the SDL_ttf CLASSIC API as a builtin veneer over
// FreeType (the SDL3_image contract, with the #464 freetype srclib as the
// backend). One fat-image session proves, end to end through the in-OS cc:
//
//   - `cc ttfdemo.c -o ttfdemo.out` with NO -I flags and NO FreeType TU list
//     builds a program that #includes <SDL3_ttf/SDL_ttf.h> — the header's
//     __require_source("__SDL_ttf.c") plus ft2build.h's own require block
//     are the whole link story (source-lib §4.2);
//   - TTF_OpenFont on the baked Noto Sans face works, and the renderers
//     produce REAL ink: the C program pixel-asserts count, color, bilevel
//     vs antialiased coverage, baseline positioning, and the opaque Shaded
//     bg box — never just a non-NULL return (the #364 lesson);
//   - TTF_GetStringSize agrees with the rendered surface dims (both run the
//     one layout core, and this asserts it end to end);
//   - a multi-byte UTF-8 string ("\xC3\xA9" = e-acute) renders as ONE glyph
//     whose accent reaches higher than a bare 'e' — the positive control
//     that the UTF-8 path is real and not a Latin-1 fallback — and invalid
//     bytes render predictably (U+FFFD rule) instead of crashing;
//   - wrapping, styles (bold = more ink, underline = a real full-width rule
//     row), hinting/kerning round-trips, glyph metrics, measuring, the
//     zero-width error, the fg.a==0-means-opaque upstream quirk, and
//     TTF_GetError sharing SDL's error string.
//
// The C program is SELF-CHECKING (ok/FAILCHK lines + a SUMMARY count); this
// driver requires fail==0 and pins the ok count's floor, so a shrinking demo
// cannot keep the test green. The missing-freetype loud failure and the
// pay-for-what-you-use control (a plain-SDL program compiling with NO
// freetype anywhere) live host-side in tests/host/test_sdlttf_link.js —
// cheap there, boot-priced here.
//
// Run: node tests/kernel/test_sdlttf_e2e.js
'use strict';
const fs = require('fs');
const { driveBoot, freshImage, section } = require('./lib/drive.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + String(extra).slice(0, 800) : '')); failures++; }
}

const TTFDEMO_C = [
  '#include <SDL3_ttf/SDL_ttf.h>',
  '#include <stdio.h>',
  '#include <string.h>',
  '',
  'static int nok, nfail;',
  'static void ck(const char *name, int cond) {',
  '    if (cond) { nok++; printf("ok %s\\n", name); }',
  '    else { nfail++; printf("FAILCHK %s\\n", name); }',
  '}',
  '',
  '/* ink stats over an RGBA32 surface: count/bbox of alpha>=128 pixels,',
  '   antialiased (0<a<255) count, and ink pixels off the expected rgb. */',
  'typedef struct { int ink, minx, maxx, miny, maxy, aa, badcolor; } Stats;',
  'static Stats stats(SDL_Surface *s, int fr, int fg, int fb) {',
  '    Stats st = { 0, 1 << 30, -1, 1 << 30, -1, 0, 0 };',
  '    unsigned char *px = (unsigned char *)s->pixels;',
  '    for (int y = 0; y < s->h; y++) for (int x = 0; x < s->w; x++) {',
  '        unsigned char *p = px + (y * s->w + x) * 4;',
  '        if (p[3] > 0 && p[3] < 255) st.aa++;',
  '        if (p[3] >= 128) {',
  '            st.ink++;',
  '            if (x < st.minx) st.minx = x;',
  '            if (x > st.maxx) st.maxx = x;',
  '            if (y < st.miny) st.miny = y;',
  '            if (y > st.maxy) st.maxy = y;',
  '            if (p[0] != fr || p[1] != fg || p[2] != fb) st.badcolor++;',
  '        }',
  '    }',
  '    return st;',
  '}',
  '',
  'int main(void) {',
  '    SDL_Color red = { 255, 0, 0, 255 };',
  '    SDL_Color blue = { 0, 0, 255, 255 };',
  '    int dummy = 0;',
  '',
  '    ck("wasinit-0", TTF_WasInit() == 0);',
  '    ck("init", TTF_Init());',
  '    ck("wasinit-1", TTF_WasInit() == 1);',
  '',
  '    ck("openfont-missing-null", TTF_OpenFont("/no/such/font.ttf", 24.0f) == NULL);',
  '    ck("openfont-missing-error", TTF_GetError()[0] != 0);',
  '    ck("error-shared-with-sdl", strcmp(TTF_GetError(), SDL_GetError()) == 0);',
  '',
  '    TTF_Font *f = TTF_OpenFont("/usr/share/fonts/sans.ttf", 24.0f);',
  '    ck("openfont", f != NULL);',
  '    if (!f) { printf("TTFDEMO-ABORT %s\\n", TTF_GetError()); return 1; }',
  '',
  '    int asc = TTF_GetFontAscent(f), desc = TTF_GetFontDescent(f);',
  '    int fh = TTF_GetFontHeight(f), skip = TTF_GetFontLineSkip(f);',
  '    printf("METRICS h=%d asc=%d desc=%d skip=%d fam=%s sty=%s\\n", fh, asc, desc, skip,',
  '           TTF_GetFontFamilyName(f), TTF_GetFontStyleName(f));',
  '    ck("ascent-pos", asc > 0);',
  '    ck("descent-neg", desc < 0);',
  '    ck("height-sum", fh == asc - desc);',
  '    ck("height-sane-24pt", fh >= 24 && fh <= 44);',
  '    ck("lineskip-pos", skip > 0);',
  '    ck("family-noto", strcmp(TTF_GetFontFamilyName(f), "Noto Sans") == 0);',
  '    ck("fixedwidth-no", !TTF_FontIsFixedWidth(f));',
  '    ck("size-24", TTF_GetFontSize(f) == 24.0f);',
  '    { int hd = 0, vd = 0; TTF_GetFontDPI(f, &hd, &vd); ck("dpi-72", hd == 72 && vd == 72); }',
  '',
  '    int w = 0, hh = 0;',
  '    ck("size-hello", TTF_GetStringSize(f, "Hello", 0, &w, &hh));',
  '    printf("SIZE w=%d h=%d\\n", w, hh);',
  '    ck("size-w-pos", w > 0);',
  '    ck("size-h-is-height", hh == fh);',
  '',
  '    /* Blended: AA ink, exact fg color, dims == measured, baseline sane',
  '       ("Hello" has no descenders, so ink stays above the baseline row). */',
  '    SDL_Surface *bs = TTF_RenderText_Blended(f, "Hello", 0, red);',
  '    ck("blended-nonnull", bs != NULL);',
  '    if (!bs) { printf("TTFDEMO-ABORT %s\\n", TTF_GetError()); return 1; }',
  '    ck("blended-format", bs->format == SDL_PIXELFORMAT_RGBA32);',
  '    ck("blended-dims", bs->w == w && bs->h == hh);',
  '    ck("blended-pitch", bs->pitch == bs->w * 4);',
  '    Stats sb = stats(bs, 255, 0, 0);',
  '    printf("BLENDED ink=%d aa=%d bbox=%d,%d,%d,%d\\n", sb.ink, sb.aa, sb.minx, sb.miny, sb.maxx, sb.maxy);',
  '    ck("blended-ink", sb.ink > 50);',
  '    ck("blended-antialiased", sb.aa > 0);',
  '    ck("blended-color-exact", sb.badcolor == 0);',
  '    ck("blended-ink-above-baseline", sb.maxy <= asc + 1);',
  '    ck("blended-cap-top", sb.miny >= 2 && sb.miny <= asc * 2 / 3);',
  '    ck("blended-cap-height", (sb.maxy - sb.miny + 1) >= fh * 2 / 5);',
  '    ck("blended-ink-left", sb.minx >= 0 && sb.minx <= w / 4);',
  '    ck("blended-ink-right", sb.maxx < w);',
  '',
  '    /* Solid: BILEVEL raster (every alpha 0 or 255), same dims. */',
  '    SDL_Surface *ss = TTF_RenderText_Solid(f, "Hello", 0, red);',
  '    ck("solid-nonnull", ss != NULL);',
  '    if (ss) {',
  '        int bilevel = 1;',
  '        unsigned char *px = (unsigned char *)ss->pixels;',
  '        for (int i = 0; i < ss->w * ss->h; i++)',
  '            if (px[i * 4 + 3] != 0 && px[i * 4 + 3] != 255) bilevel = 0;',
  '        Stats st = stats(ss, 255, 0, 0);',
  '        ck("solid-dims", ss->w == w && ss->h == hh);',
  '        ck("solid-bilevel", bilevel);',
  '        ck("solid-ink", st.ink > 50);',
  '        ck("solid-color-exact", st.badcolor == 0);',
  '    }',
  '',
  '    /* Shaded: fully opaque, bg-colored box, strong-fg pixels present. */',
  '    SDL_Surface *sh = TTF_RenderText_Shaded(f, "Hello", 0, red, blue);',
  '    ck("shaded-nonnull", sh != NULL);',
  '    if (sh) {',
  '        unsigned char *px = (unsigned char *)sh->pixels;',
  '        int opaque = 1, strongfg = 0;',
  '        for (int i = 0; i < sh->w * sh->h; i++) {',
  '            unsigned char *p = px + i * 4;',
  '            if (p[3] != 255) opaque = 0;',
  '            if (p[0] > 200 && p[2] < 60) strongfg++;',
  '        }',
  '        ck("shaded-dims", sh->w == w && sh->h == hh);',
  '        ck("shaded-opaque", opaque);',
  '        ck("shaded-corner-bg", px[0] == 0 && px[2] == 255);',
  '        ck("shaded-strong-fg", strongfg > 20);',
  '    }',
  '',
  '    /* UTF-8: 2-byte e-acute is ONE glyph (a Latin-1 fallback would draw',
  '       two), and its accent reaches higher than a bare e. */',
  '    int we = 0, wee = 0;',
  '    TTF_GetStringSize(f, "\\xC3\\xA9", 0, &we, &dummy);',
  '    TTF_GetStringSize(f, "e", 0, &wee, &dummy);',
  '    printf("UTF8 we=%d wee=%d\\n", we, wee);',
  '    ck("utf8-hasglyph-eacute", TTF_FontHasGlyph(f, 0xE9));',
  '    ck("utf8-eacute-one-glyph", we > 0 && we < wee * 3 / 2);',
  '    SDL_Surface *se = TTF_RenderText_Blended(f, "\\xC3\\xA9", 0, red);',
  '    SDL_Surface *sp = TTF_RenderText_Blended(f, "e", 0, red);',
  '    ck("utf8-renders", se != NULL && sp != NULL);',
  '    if (se && sp) {',
  '        Stats ste = stats(se, 255, 0, 0), stp = stats(sp, 255, 0, 0);',
  '        ck("utf8-accent-taller", ste.miny < stp.miny);',
  '    }',
  '    SDL_Surface *si = TTF_RenderText_Blended(f, "\\xFF\\xFF" "a", 0, red);',
  '    ck("utf8-invalid-renders", si != NULL);',
  '',
  '    /* Wrapping: two lines at a width under the single-line width; the',
  '       wrapped renderer agrees with the wrapped size; wrap_width 0 wraps',
  '       ONLY on newlines; the single-line calls do not wrap at all. */',
  '    int w1 = 0, h1 = 0, w2 = 0, h2 = 0;',
  '    TTF_GetStringSize(f, "aaa bbb", 0, &w1, &h1);',
  '    ck("wrap-single-ok", w1 > 0 && h1 == fh);',
  '    ck("wrapped-size-ok", TTF_GetStringSizeWrapped(f, "aaa bbb", 0, w1 - 5, &w2, &h2));',
  '    printf("WRAP w1=%d h1=%d w2=%d h2=%d\\n", w1, h1, w2, h2);',
  '    ck("wrap-two-lines", h2 == fh + skip);',
  '    ck("wrap-narrower", w2 < w1);',
  '    SDL_Surface *sw = TTF_RenderText_Blended_Wrapped(f, "aaa bbb", 0, red, w1 - 5);',
  '    ck("wrap-render-dims", sw != NULL && sw->w == w2 && sw->h == h2);',
  '    { int wn = 0, hn = 0, wm = 0, hm = 0;',
  '      TTF_GetStringSizeWrapped(f, "x\\ny", 0, 0, &wn, &hn);',
  '      ck("wrap0-breaks-newline", hn == fh + skip);',
  '      TTF_GetStringSize(f, "x\\ny", 0, &wm, &hm);',
  '      ck("single-line-ignores-newline", hm == fh); }',
  '',
  '    /* Styles: bold has more ink; underline draws a real full-width rule',
  '       row below the baseline; style state round-trips. */',
  '    TTF_SetFontStyle(f, TTF_STYLE_BOLD);',
  '    ck("style-roundtrip", TTF_GetFontStyle(f) == TTF_STYLE_BOLD);',
  '    SDL_Surface *sbold = TTF_RenderText_Blended(f, "Hello", 0, red);',
  '    if (sbold) {',
  '        Stats stb = stats(sbold, 255, 0, 0);',
  '        printf("BOLD ink=%d normal-ink=%d\\n", stb.ink, sb.ink);',
  '        ck("bold-more-ink", stb.ink > sb.ink);',
  '    } else ck("bold-render", 0);',
  '    TTF_SetFontStyle(f, TTF_STYLE_UNDERLINE);',
  '    SDL_Surface *su = TTF_RenderText_Blended(f, "Hello", 0, red);',
  '    if (su) {',
  '        unsigned char *px = (unsigned char *)su->pixels;',
  '        int rulerow = 0;',
  '        for (int y = asc - 1; y < su->h; y++) {',
  '            int span = 0;',
  '            for (int x = 0; x < su->w; x++) if (px[(y * su->w + x) * 4 + 3] >= 128) span++;',
  '            if (span >= su->w * 3 / 4) rulerow = 1;',
  '        }',
  '        ck("underline-rule-row", rulerow);',
  '    } else ck("underline-render", 0);',
  '    TTF_SetFontStyle(f, TTF_STYLE_ITALIC);',
  '    SDL_Surface *sit = TTF_RenderText_Blended(f, "Hello", 0, red);',
  '    ck("italic-renders", sit != NULL);',
  '    TTF_SetFontStyle(f, TTF_STYLE_NORMAL);',
  '',
  '    /* Hinting + kerning state round-trips (Noto kerns via GPOS, which the',
  '       kern-table-only path reports as no pairs — value stays sane). */',
  '    TTF_SetFontHinting(f, TTF_HINTING_MONO);',
  '    ck("hinting-roundtrip", TTF_GetFontHinting(f) == TTF_HINTING_MONO);',
  '    SDL_Surface *shm = TTF_RenderText_Blended(f, "Hello", 0, red);',
  '    ck("mono-hinted-renders", shm != NULL);',
  '    TTF_SetFontHinting(f, TTF_HINTING_NORMAL);',
  '    TTF_SetFontKerning(f, 0);',
  '    ck("kerning-off", !TTF_GetFontKerning(f));',
  '    TTF_SetFontKerning(f, 1);',
  '    { int kk = 123;',
  '      ck("kerning-query", TTF_GetGlyphKerning(f, (Uint32)\'A\', (Uint32)\'V\', &kk));',
  '      ck("kerning-value-sane", kk <= 0 && kk >= -10); }',
  '',
  '    /* Glyph metrics + measuring + single-glyph render. */',
  '    { int gminx, gmaxx, gminy, gmaxy, gadv;',
  '      ck("glyph-metrics", TTF_GetGlyphMetrics(f, (Uint32)\'A\', &gminx, &gmaxx, &gminy, &gmaxy, &gadv));',
  '      printf("GLYPH-A minx=%d maxx=%d miny=%d maxy=%d adv=%d\\n", gminx, gmaxx, gminy, gmaxy, gadv);',
  '      ck("glyph-adv", gadv > 0 && gadv < w);',
  '      ck("glyph-box", gmaxx > gminx && gmaxy > gminy);',
  '      ck("glyph-cap", gmaxy <= asc + 1 && gmaxy >= asc / 2); }',
  '    { int mw = 0; size_t mlen = 0;',
  '      ck("measure-all", TTF_MeasureString(f, "Hello", 0, 0, &mw, &mlen));',
  '      ck("measure-all-len", mlen == 5 && mw == w);',
  '      int mw2 = 0; size_t mlen2 = 0;',
  '      ck("measure-half", TTF_MeasureString(f, "Hello", 0, w / 2, &mw2, &mlen2));',
  '      ck("measure-half-fits", mlen2 >= 1 && mlen2 < 5 && mw2 <= w / 2); }',
  '    SDL_Surface *g = TTF_RenderGlyph_Blended(f, (Uint32)\'A\', red);',
  '    ck("render-glyph", g != NULL && g->h == fh && g->w > 0);',
  '',
  '    /* Zero-width text is a NAMED error; empty size is w=0,h=height. */',
  '    ck("empty-render-null", TTF_RenderText_Blended(f, "", 0, red) == NULL);',
  '    ck("empty-render-error", strstr(TTF_GetError(), "zero width") != NULL);',
  '    { int zw = -1, zh = -1;',
  '      ck("empty-size-ok", TTF_GetStringSize(f, "", 0, &zw, &zh));',
  '      ck("empty-size-vals", zw == 0 && zh == fh); }',
  '    ck("null-font-render-null", TTF_RenderText_Blended(NULL, "x", 0, red) == NULL);',
  '',
  '    /* fg.a==0 means opaque (the upstream quirk, pinned). */',
  '    { SDL_Color trans = { 0, 255, 0, 0 };',
  '      SDL_Surface *q = TTF_RenderText_Blended(f, "Q", 0, trans);',
  '      if (q) { Stats sq = stats(q, 0, 255, 0); ck("alpha0-means-opaque", sq.ink > 0); }',
  '      else ck("alpha0-render", 0); }',
  '',
  '    /* Size changes: 12pt narrower than 24pt; 12pt at 144dpi ~= 24pt at 72',
  '       (points x dpi is the pixel size — the DPI leg is real, not stored). */',
  '    { int w12 = 0, w24 = 0;',
  '      ck("setsize", TTF_SetFontSize(f, 12.0f));',
  '      TTF_GetStringSize(f, "Hello", 0, &w12, &dummy);',
  '      ck("smaller-narrower", w12 > 0 && w12 < w);',
  '      ck("setsize-dpi", TTF_SetFontSizeDPI(f, 12.0f, 144, 144));',
  '      TTF_GetStringSize(f, "Hello", 0, &w24, &dummy);',
  '      printf("DPI w24pt=%d w12pt=%d w12pt144=%d\\n", w, w12, w24);',
  '      ck("dpi-scales", w24 > w12 * 3 / 2);',
  '      TTF_SetFontSizeDPI(f, 24.0f, 72, 72); }',
  '',
  '    /* Remaining renderer arms exist and produce ink. */',
  '    SDL_Surface *r1 = TTF_RenderText_Solid_Wrapped(f, "aaa bbb", 0, red, w1 - 5);',
  '    SDL_Surface *r2 = TTF_RenderText_Shaded_Wrapped(f, "aaa bbb", 0, red, blue, w1 - 5);',
  '    SDL_Surface *r3 = TTF_RenderGlyph_Solid(f, (Uint32)\'A\', red);',
  '    SDL_Surface *r4 = TTF_RenderGlyph_Shaded(f, (Uint32)\'A\', red, blue);',
  '    ck("solid-wrapped", r1 != NULL && r1->h == fh + skip);',
  '    ck("shaded-wrapped", r2 != NULL && r2->h == fh + skip);',
  '    ck("glyph-solid", r3 != NULL);',
  '    ck("glyph-shaded", r4 != NULL);',
  '',
  '    SDL_DestroySurface(bs); SDL_DestroySurface(ss); SDL_DestroySurface(sh);',
  '    SDL_DestroySurface(se); SDL_DestroySurface(sp); SDL_DestroySurface(si);',
  '    SDL_DestroySurface(sw); SDL_DestroySurface(sbold); SDL_DestroySurface(su);',
  '    SDL_DestroySurface(sit); SDL_DestroySurface(shm); SDL_DestroySurface(g);',
  '    SDL_DestroySurface(r1); SDL_DestroySurface(r2); SDL_DestroySurface(r3);',
  '    SDL_DestroySurface(r4);',
  '    TTF_CloseFont(f);',
  '    TTF_Quit();',
  '    ck("wasinit-final", TTF_WasInit() == 0);',
  '    printf("SUMMARY ok=%d fail=%d\\n", nok, nfail);',
  '    printf("TTFDEMO-DONE\\n");',
  '    return nfail ? 1 : 0;',
  '}',
];

async function main() {
  const { dir: tmp, image } = freshImage('os-sdlttf-');
  const script = [
    "cat > /root/ttfdemo.c << 'EOF'",
    ...TTFDEMO_C,
    'EOF',
    'echo ==cc',
    'cd /root && cc ttfdemo.c -o ttfdemo.out',
    'echo ccrc=$?',
    'echo ==run',
    './ttfdemo.out',
    'echo runrc=$?',
    'echo ==done',
    'exit',
  ].join('\n');
  const a = driveBoot(script, { image, timeout: 420000 });
  const out = String(a.stdout || '');
  check('session exits clean', a.status === 0,
    String(a.status) + ' ' + String(a.stderr || '').slice(-300));

  const cc = section(out, 'cc');
  check('cc ttfdemo.c compiles (header require block pulls FreeType, no -I, no TU list)',
    cc.includes('ccrc=0'), cc);

  const run = section(out, 'run');
  check('demo runs to completion', run.includes('TTFDEMO-DONE') && run.includes('runrc=0'), run.slice(-1200));
  check('zero in-program pixel/contract failures', !/FAILCHK/.test(run),
    run.split('\n').filter((l) => l.includes('FAILCHK')).join('; '));
  const m = /SUMMARY ok=(\d+) fail=(\d+)/.exec(run);
  check('summary present', !!m, run.slice(-400));
  if (m) {
    // Floor, not exact: additions must not silently vanish, but the pinned
    // number lives in the C program (nfail==0 is the exact assertion).
    check('check-count floor (>= 70 legs ran)', Number(m[1]) >= 70, m[0]);
    check('summary agrees zero failures', Number(m[2]) === 0, m[0]);
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures ? `\nsdlttf e2e: ${failures} FAILED` : '\nsdlttf e2e: PASS');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e && e.stack || e);
  process.exit(1);
});
