/* gdi32w.c — gdi32's UTF-16 wrappers (0068), split out of gdi32.c by M4
 * (todos/0259): they convert at kernel32's MultiByteToWideChar/
 * WideCharToMultiByte boundary, and the menucore link set (os/wm.c)
 * carries gdi32 WITHOUT kernel32 — so the W layer rides with the veneer
 * (lib.json), the ANSI raster core with the engine (menucore.json). */

/* The veneer is implemented ANSI (WIN32.md friction #2: implement W, shim
 * A). Ported apps build -DUNICODE (0060); the implementation must not. */
#undef UNICODE
#undef _UNICODE
#include <windows.h>
#include "win32_internal.h"
#include <stdlib.h>
#include <string.h>

/* ============================================================ W text (0068)
 * Mechanical UTF-16 wrappers over the implemented ANSI entries (WIN32.md
 * friction #2: implement A here, convert at the boundary — kernel32.c
 * owns MultiByteToWideChar/WideCharToMultiByte). Metrics and object
 * queries are charset-free apart from LOGFONT's face name. */

static char *gdi_w2a(LPCWSTR s, int len, int *outLen) {  /* len: chars or -1 */
    if (!s) return NULL;
    int n = WideCharToMultiByte(CP_UTF8, 0, s, len, NULL, 0, NULL, NULL);
    if (n < 0) n = 0;
    char *out = (char *)malloc((size_t)n + 1);
    if (!out) return NULL;
    if (n > 0) WideCharToMultiByte(CP_UTF8, 0, s, len, out, n, NULL, NULL);
    out[n] = 0;
    if (outLen) *outLen = len < 0 ? n - 1 : n;   /* -1 counted the NUL */
    return out;
}

BOOL TextOutW(HDC dc, int x, int y, LPCWSTR str, int len) {
    int alen;
    char *a = gdi_w2a(str, len, &alen);
    if (!a) return FALSE;
    BOOL r = TextOut(dc, x, y, a, alen);
    free(a);
    return r;
}

BOOL ExtTextOutW(HDC dc, int x, int y, UINT options, const RECT *r,
                 LPCWSTR str, UINT len, const INT *dx) {
    int alen;
    char *a = gdi_w2a(str, (int)len, &alen);
    if (!a) return FALSE;
    BOOL ok = ExtTextOut(dc, x, y, options, r, a, (UINT)alen, dx);
    free(a);
    return ok;
}

int DrawTextW(HDC dc, LPCWSTR str, int len, RECT *r, UINT format) {
    int alen;
    char *a = gdi_w2a(str, len, &alen);
    if (!a) return 0;
    int out = DrawText(dc, a, alen, r, format);
    free(a);
    return out;
}

BOOL GetTextExtentPoint32W(HDC dc, LPCWSTR str, int len, SIZE *size) {
    int alen;
    char *a = gdi_w2a(str, len, &alen);
    if (!a) return FALSE;
    BOOL r = GetTextExtentPoint32(dc, a, alen, size);
    free(a);
    return r;
}

BOOL GetTextMetricsW(HDC dc, TEXTMETRICW *tmw) {
    TEXTMETRIC tm;
    if (!tmw || !GetTextMetrics(dc, &tm)) return FALSE;
    memset(tmw, 0, sizeof *tmw);
    tmw->tmHeight = tm.tmHeight;
    tmw->tmAscent = tm.tmAscent;
    tmw->tmDescent = tm.tmDescent;
    tmw->tmInternalLeading = tm.tmInternalLeading;
    tmw->tmExternalLeading = tm.tmExternalLeading;
    tmw->tmAveCharWidth = tm.tmAveCharWidth;
    tmw->tmMaxCharWidth = tm.tmMaxCharWidth;
    tmw->tmWeight = tm.tmWeight;
    tmw->tmOverhang = tm.tmOverhang;
    tmw->tmDigitizedAspectX = tm.tmDigitizedAspectX;
    tmw->tmDigitizedAspectY = tm.tmDigitizedAspectY;
    tmw->tmFirstChar = (WCHAR)tm.tmFirstChar;
    tmw->tmLastChar = (WCHAR)tm.tmLastChar;
    tmw->tmDefaultChar = (WCHAR)tm.tmDefaultChar;
    tmw->tmBreakChar = (WCHAR)tm.tmBreakChar;
    tmw->tmItalic = tm.tmItalic;
    tmw->tmUnderlined = tm.tmUnderlined;
    tmw->tmStruckOut = tm.tmStruckOut;
    tmw->tmPitchAndFamily = tm.tmPitchAndFamily;
    tmw->tmCharSet = tm.tmCharSet;
    return TRUE;
}

HFONT CreateFontW(int height, int width, int escapement, int orientation,
                  int weight, DWORD italic, DWORD underline, DWORD strikeout,
                  DWORD charset, DWORD outPrecision, DWORD clipPrecision,
                  DWORD quality, DWORD pitchAndFamily, LPCWSTR faceName) {
    char *face = faceName ? gdi_w2a(faceName, -1, NULL) : NULL;
    HFONT f = CreateFont(height, width, escapement, orientation, weight,
                         italic, underline, strikeout, charset, outPrecision,
                         clipPrecision, quality, pitchAndFamily, face);
    free(face);
    return f;
}

HFONT CreateFontIndirectW(const LOGFONTW *lf) {
    if (!lf) return NULL;
    LOGFONT a;
    memset(&a, 0, sizeof a);
    a.lfHeight = lf->lfHeight;
    a.lfWidth = lf->lfWidth;
    a.lfEscapement = lf->lfEscapement;
    a.lfOrientation = lf->lfOrientation;
    a.lfWeight = lf->lfWeight;
    a.lfItalic = lf->lfItalic;
    a.lfUnderline = lf->lfUnderline;
    a.lfStrikeOut = lf->lfStrikeOut;
    a.lfCharSet = lf->lfCharSet;
    a.lfOutPrecision = lf->lfOutPrecision;
    a.lfClipPrecision = lf->lfClipPrecision;
    a.lfQuality = lf->lfQuality;
    a.lfPitchAndFamily = lf->lfPitchAndFamily;
    WideCharToMultiByte(CP_UTF8, 0, lf->lfFaceName, -1, a.lfFaceName,
                        sizeof a.lfFaceName - 1, NULL, NULL);
    return CreateFontIndirect(&a);
}

int GetObjectW(HGDIOBJ obj, int size, void *out) {
    /* Fonts are the ONE string-bearing object (#291): LOGFONTW differs
     * from LOGFONT in size AND face-name encoding, so a raw forward
     * would hand a W caller ANSI bytes under a W struct layout.
     * Everything else (BITMAP today) is charset-free and forwards. */
    if (!__gdi_obj_is_font(obj)) return GetObject(obj, size, out);
    LOGFONT a;
    if (GetObject(obj, (int)sizeof a, &a) != (int)sizeof a) return 0;
    LOGFONTW w;
    memset(&w, 0, sizeof w);
    w.lfHeight = a.lfHeight;
    w.lfWidth = a.lfWidth;
    w.lfEscapement = a.lfEscapement;
    w.lfOrientation = a.lfOrientation;
    w.lfWeight = a.lfWeight;
    w.lfItalic = a.lfItalic;
    w.lfUnderline = a.lfUnderline;
    w.lfStrikeOut = a.lfStrikeOut;
    w.lfCharSet = a.lfCharSet;
    w.lfOutPrecision = a.lfOutPrecision;
    w.lfClipPrecision = a.lfClipPrecision;
    w.lfQuality = a.lfQuality;
    w.lfPitchAndFamily = a.lfPitchAndFamily;
    MultiByteToWideChar(CP_UTF8, 0, a.lfFaceName, -1, w.lfFaceName,
                        LF_FACESIZE);
    if (!out) return (int)sizeof(LOGFONTW);
    int n = size < (int)sizeof(LOGFONTW) ? size : (int)sizeof(LOGFONTW);
    if (n <= 0) return 0;
    memcpy(out, &w, (size_t)n);
    return n;
}

