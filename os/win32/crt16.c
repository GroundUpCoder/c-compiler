/* crt16.c — the 16-bit wide CRT for the Win32 veneer (todos/0059).
 *
 * tchar.h's deviation, implemented: this libc's wchar_t is 4 bytes, so
 * the msvcrt wide names (wcslen & co) can't be reused at WCHAR's 2-byte
 * width — the _tcs / _t names ARE the real 16-bit symbols instead (see
 * include/tchar.h). Also here: the strsafe.h entries (header-only inline
 * on Windows, real symbols in this veneer so PORTS.md sees demand) and
 * user32's wsprintfW family, which is string-only and shares the one
 * wide formatter below.
 *
 * The formatter strategy: parse each %spec, render numerics/floats
 * through libc's snprintf into a narrow scratch (so float formatting is
 * never reimplemented), widen the ASCII result; %s/%c handle WCHAR
 * directly. %I64 (msvcrt's 64-bit size prefix) maps to long long.
 */

#undef UNICODE
#undef _UNICODE
#define _UNICODE 1            /* tchar.h: declare the 16-bit prototypes */
#include <windows.h>
#include <tchar.h>
#include <strsafe.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "win32_internal.h"     /* __u8_next — the one veneer UTF-8 decoder */

/* ========================================================== _tcs* CRT */

size_t _tcslen(const WCHAR *s) {
    size_t n = 0;
    while (s[n]) n++;
    return n;
}

WCHAR *_tcscpy(WCHAR *dst, const WCHAR *src) {
    WCHAR *d = dst;
    while ((*d++ = *src++)) {}
    return dst;
}

WCHAR *_tcsncpy(WCHAR *dst, const WCHAR *src, size_t n) {
    size_t i = 0;
    for (; i < n && src[i]; i++) dst[i] = src[i];
    for (; i < n; i++) dst[i] = 0;
    return dst;
}

WCHAR *_tcscat(WCHAR *dst, const WCHAR *src) {
    _tcscpy(dst + _tcslen(dst), src);
    return dst;
}

int _tcscmp(const WCHAR *a, const WCHAR *b) {
    while (*a && *a == *b) { a++; b++; }
    return (int)*a - (int)*b;
}

int _tcsncmp(const WCHAR *a, const WCHAR *b, size_t n) {
    for (size_t i = 0; i < n; i++) {
        if (a[i] != b[i]) return (int)a[i] - (int)b[i];
        if (!a[i]) return 0;
    }
    return 0;
}

static WCHAR tupper(WCHAR c) { return (c >= 'a' && c <= 'z') ? (WCHAR)(c - 32) : c; }
static WCHAR tlower(WCHAR c) { return (c >= 'A' && c <= 'Z') ? (WCHAR)(c + 32) : c; }

int _tcsicmp(const WCHAR *a, const WCHAR *b) {
    while (*a && tupper(*a) == tupper(*b)) { a++; b++; }
    return (int)tupper(*a) - (int)tupper(*b);
}

int _tcsnicmp(const WCHAR *a, const WCHAR *b, size_t n) {
    for (size_t i = 0; i < n; i++) {
        if (tupper(a[i]) != tupper(b[i])) return (int)tupper(a[i]) - (int)tupper(b[i]);
        if (!a[i]) return 0;
    }
    return 0;
}

WCHAR *_tcschr(const WCHAR *s, WCHAR c) {
    for (;; s++) {
        if (*s == c) return (WCHAR *)s;
        if (!*s) return NULL;
    }
}

WCHAR *_tcsrchr(const WCHAR *s, WCHAR c) {
    const WCHAR *last = NULL;
    for (;; s++) {
        if (*s == c) last = s;
        if (!*s) return (WCHAR *)last;
    }
}

WCHAR *_tcsstr(const WCHAR *hay, const WCHAR *needle) {
    if (!*needle) return (WCHAR *)hay;
    for (; *hay; hay++) {
        size_t i = 0;
        while (needle[i] && hay[i] == needle[i]) i++;
        if (!needle[i]) return (WCHAR *)hay;
    }
    return NULL;
}

WCHAR *_tcsdup(const WCHAR *s) {
    size_t n = _tcslen(s) + 1;
    WCHAR *d = (WCHAR *)malloc(n * sizeof(WCHAR));
    if (d) memcpy(d, s, n * sizeof(WCHAR));
    return d;
}

int _ttoi(const WCHAR *s) { return (int)_ttol(s); }

long _ttol(const WCHAR *s) {
    long acc = 0;
    int neg = 0;
    while (*s == ' ' || *s == '\t') s++;
    if (*s == '-') { neg = 1; s++; } else if (*s == '+') s++;
    while (*s >= '0' && *s <= '9') acc = acc * 10 + (*s++ - '0');
    return neg ? -acc : acc;
}

int _istalpha(WCHAR c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'); }
int _istdigit(WCHAR c) { return c >= '0' && c <= '9'; }
int _istalnum(WCHAR c) { return _istalpha(c) || _istdigit(c); }
int _istspace(WCHAR c) { return c == ' ' || (c >= 0x09 && c <= 0x0D); }
WCHAR _totupper(WCHAR c) { return tupper(c); }
WCHAR _totlower(WCHAR c) { return tlower(c); }

/* narrow msvcrt crumbs (charset-free half of tchar.h) */

char *_strdup(const char *s) { return strdup(s); }

char *_strupr(char *s) {
    for (char *p = s; *p; p++)
        if (*p >= 'a' && *p <= 'z') *p -= 32;
    return s;
}

/* ================================================== the wide formatter */

/* Render fmt+ap into out (cap WCHARs including the terminator; always
 * terminated when cap > 0). Returns the untruncated length. */
static int w16_vformat(WCHAR *out, int cap, const WCHAR *fmt, va_list ap) {
    int o = 0;
    #define PUTW(ch) do { if (o < cap - 1) out[o] = (WCHAR)(ch); o++; } while (0)

    for (const WCHAR *f = fmt; *f; f++) {
        if (*f != '%') { PUTW(*f); continue; }
        f++;
        if (*f == '%') { PUTW('%'); continue; }

        /* flags / width / precision (either may be '*') */
        char flags[8];
        int nf = 0;
        while (*f == '-' || *f == '+' || *f == ' ' || *f == '#' || *f == '0') {
            if (nf < 7) flags[nf++] = (char)*f;
            f++;
        }
        flags[nf] = 0;
        int width = 0, prec = -1;
        if (*f == '*') { width = va_arg(ap, int); f++; }
        else while (*f >= '0' && *f <= '9') width = width * 10 + (int)(*f++ - '0');
        if (*f == '.') {
            f++;
            prec = 0;
            if (*f == '*') { prec = va_arg(ap, int); f++; }
            else while (*f >= '0' && *f <= '9') prec = prec * 10 + (int)(*f++ - '0');
        }

        /* size: h / l / ll / I64 -> 0 int, 1 long, 2 long long, -1 short */
        int size = 0;
        if (*f == 'I' && f[1] == '6' && f[2] == '4') { size = 2; f += 3; }
        else if (*f == 'l') { f++; if (*f == 'l') { size = 2; f++; } else size = 1; }
        else if (*f == 'h') { size = -1; f++; }

        WCHAR conv = *f;
        if (!conv) break;

        if (conv == 'c' || conv == 'C') {
            /* both are WCHAR-sized in a wide formatter (h forces narrow) */
            int c = va_arg(ap, int);
            int pad = width - 1;
            if (!strchr(flags, '-')) while (pad-- > 0) PUTW(' ');
            PUTW(c);
            if (strchr(flags, '-')) while (pad-- > 0) PUTW(' ');
            continue;
        }

        if (conv == 's' || conv == 'S') {
            /* %s wide, %S / %hs narrow (this is the W formatter) */
            int narrow = (conv == 'S') || size == -1;
            if (conv == 's' && size == -1) narrow = 1;
            static const WCHAR NULLW[] = u"(null)";
            const WCHAR *ws = NULL;
            const char *ns = NULL;
            int len = 0, nbytes = 0;
            if (narrow) {
                /* Narrow args are UTF-8 (kernel32's CP_ACP == CP_UTF8):
                 * decode per code point — the same conversion
                 * MultiByteToWideChar performs — with surrogate pairs
                 * for astral, never Latin-1 zero-extension. len counts
                 * UTF-16 units so width/precision stay unit-based. */
                ns = va_arg(ap, const char *);
                if (!ns) ns = "(null)";
                while (ns[nbytes]) nbytes++;
                for (int i = 0; i < nbytes; ) {
                    unsigned cp = __u8_next(ns, nbytes, &i);
                    len += cp >= 0x10000 ? 2 : 1;
                }
            } else {
                ws = va_arg(ap, const WCHAR *);
                if (!ws) ws = NULLW;
                while (ws[len]) len++;
            }
            if (prec >= 0 && len > prec) len = prec;
            int pad = width - len;
            if (!strchr(flags, '-')) while (pad-- > 0) PUTW(' ');
            if (narrow) {
                int left = len;
                for (int i = 0; i < nbytes && left > 0; ) {
                    unsigned cp = __u8_next(ns, nbytes, &i);
                    if (cp >= 0x10000) {
                        if (left < 2) break;   /* precision never splits a pair */
                        unsigned v = cp - 0x10000;
                        PUTW(0xD800 | (v >> 10));
                        PUTW(0xDC00 | (v & 0x3FF));
                        left -= 2;
                    } else {
                        PUTW(cp);
                        left--;
                    }
                }
            } else {
                for (int i = 0; i < len; i++) PUTW(ws[i]);
            }
            if (strchr(flags, '-')) while (pad-- > 0) PUTW(' ');
            continue;
        }

        /* numeric / float / pointer: rebuild a narrow spec and let libc
         * snprintf do the rendering, then widen the ASCII result */
        char spec[48], nbuf[128];
        int haveNum = 1;
        if (prec >= 0)
            snprintf(spec, sizeof spec, "%%%s%d.%d", flags, width, prec);
        else if (width > 0)
            snprintf(spec, sizeof spec, "%%%s%d", flags, width);
        else
            snprintf(spec, sizeof spec, "%%%s", flags);
        size_t sl = strlen(spec);

        switch (conv) {
        case 'd': case 'i': case 'u': case 'o': case 'x': case 'X': {
            const char *lenmod = (size == 2) ? "ll" : (size == 1) ? "l" : "";
            snprintf(spec + sl, sizeof spec - sl, "%s%c", lenmod, (char)conv);
            if (size == 2) {
                long long v = va_arg(ap, long long);
                snprintf(nbuf, sizeof nbuf, spec, v);
            } else if (size == 1) {
                long v = va_arg(ap, long);
                snprintf(nbuf, sizeof nbuf, spec, v);
            } else {
                int v = va_arg(ap, int);
                snprintf(nbuf, sizeof nbuf, spec, v);
            }
            break;
        }
        case 'f': case 'e': case 'E': case 'g': case 'G': {
            snprintf(spec + sl, sizeof spec - sl, "%c", (char)conv);
            double v = va_arg(ap, double);
            snprintf(nbuf, sizeof nbuf, spec, v);
            break;
        }
        case 'p': {
            snprintf(spec + sl, sizeof spec - sl, "p");
            void *v = va_arg(ap, void *);
            snprintf(nbuf, sizeof nbuf, spec, v);
            break;
        }
        default:
            PUTW('%');
            PUTW(conv);
            haveNum = 0;
            break;
        }
        if (haveNum)
            for (const char *c = nbuf; *c; c++) PUTW(*c);
    }

    if (cap > 0) out[o < cap ? o : cap - 1] = 0;
    #undef PUTW
    return o;
}

int _stprintf(WCHAR *buf, const WCHAR *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    int r = w16_vformat(buf, 0x7FFFFFF, fmt, ap);
    va_end(ap);
    return r;
}

int _sntprintf(WCHAR *buf, size_t n, const WCHAR *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    int r = w16_vformat(buf, (int)n, fmt, ap);
    va_end(ap);
    return r >= (int)n ? -1 : r;                  /* msvcrt: -1 on truncation */
}

/* wsprintf (user32's string-only formatter). The MSDN contract is a
 * 1024-unit buffer TOTAL — so at most 1023 characters plus the
 * terminator, nothing ever written at index 1024 (#319 gap #33: the old
 * cap of 1025 put the NUL one unit past the caller's buffer). */

int wvsprintfW(LPWSTR buf, LPCWSTR fmt, va_list args) {
    int r = w16_vformat(buf, 1024, fmt, args);
    return r > 1023 ? 1023 : r;
}

int wsprintfW(LPWSTR buf, LPCWSTR fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    int r = wvsprintfW(buf, fmt, ap);
    va_end(ap);
    return r;
}

int wsprintfA(LPSTR buf, LPCSTR fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    int r = vsnprintf(buf, 1024, fmt, ap);
    va_end(ap);
    return r > 1023 ? 1023 : r;
}

/* ============================================================ _stscanf */

/* The corpus needs numerics (calc: %I64X, %I64o, %lf) plus %s/%c for
 * completeness. Input is narrowed per-char (numbers are ASCII); each
 * conversion leans on strto*(3). */
int _stscanf(const WCHAR *s, const WCHAR *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    int assigned = 0;
    const WCHAR *p = s;

    for (const WCHAR *f = fmt; *f; f++) {
        if (_istspace(*f)) {
            while (_istspace(*p)) p++;
            continue;
        }
        if (*f != '%') {
            if (*p != *f) break;
            p++;
            continue;
        }
        f++;
        if (*f == '%') {
            if (*p != '%') break;
            p++;
            continue;
        }
        int suppress = 0;
        if (*f == '*') { suppress = 1; f++; }
        int width = 0;
        while (*f >= '0' && *f <= '9') width = width * 10 + (int)(*f++ - '0');
        int size = 0;      /* 0 int, 1 long, 2 long long, -1 short */
        if (*f == 'I' && f[1] == '6' && f[2] == '4') { size = 2; f += 3; }
        else if (*f == 'l') { f++; if (*f == 'l') { size = 2; f++; } else size = 1; }
        else if (*f == 'h') { size = -1; f++; }
        WCHAR conv = *f;

        while (conv != 'c' && _istspace(*p)) p++;

        if (conv == 's') {
            if (!*p) break;
            WCHAR *out = suppress ? NULL : va_arg(ap, WCHAR *);
            int i = 0;
            while (*p && !_istspace(*p) && (width == 0 || i < width)) {
                if (out) out[i] = *p;
                i++;
                p++;
            }
            if (out) { out[i] = 0; assigned++; }
            continue;
        }
        if (conv == 'c') {
            if (!*p) break;
            int n = width ? width : 1;
            WCHAR *out = suppress ? NULL : va_arg(ap, WCHAR *);
            for (int i = 0; i < n && *p; i++, p++)
                if (out) out[i] = *p;
            if (out) assigned++;
            continue;
        }

        /* numeric: narrow the digit run, then strto* */
        char nb[128];
        int ni = 0;
        int max = (width && width < 127) ? width : 127;
        while (*p && *p < 0x80 && !_istspace(*p) && ni < max) {
            char c = (char)*p;
            /* stop at chars that can't extend a number */
            if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') ||
                  (c >= 'A' && c <= 'F') || c == '+' || c == '-' || c == '.' ||
                  c == 'x' || c == 'X' || c == 'e' || c == 'E'))
                break;
            nb[ni++] = c;
            p++;
        }
        nb[ni] = 0;
        if (ni == 0) break;
        char *end = nb;

        switch (conv) {
        case 'd': case 'i': {
            long long v = strtoll(nb, &end, conv == 'i' ? 0 : 10);
            if (end == nb) goto done;
            if (!suppress) {
                if (size == 2) *va_arg(ap, long long *) = v;
                else if (size == 1) *va_arg(ap, long *) = (long)v;
                else if (size == -1) *va_arg(ap, short *) = (short)v;
                else *va_arg(ap, int *) = (int)v;
                assigned++;
            }
            break;
        }
        case 'u': case 'o': case 'x': case 'X': {
            int base = (conv == 'o') ? 8 : (conv == 'u') ? 10 : 16;
            unsigned long long v = strtoull(nb, &end, base);
            if (end == nb) goto done;
            if (!suppress) {
                if (size == 2) *va_arg(ap, unsigned long long *) = v;
                else if (size == 1) *va_arg(ap, unsigned long *) = (unsigned long)v;
                else if (size == -1) *va_arg(ap, unsigned short *) = (unsigned short)v;
                else *va_arg(ap, unsigned int *) = (unsigned int)v;
                assigned++;
            }
            break;
        }
        case 'f': case 'e': case 'g': {
            double v = strtod(nb, &end);
            if (end == nb) goto done;
            if (!suppress) {
                if (size >= 1) *va_arg(ap, double *) = v;
                else *va_arg(ap, float *) = (float)v;
                assigned++;
            }
            break;
        }
        default:
            goto done;
        }
        p -= (ni - (int)(end - nb));              /* unconsumed tail back */
    }

done:
    va_end(ap);
    return assigned;
}

/* ============================================================= strsafe */

static HRESULT cch_copyW(LPWSTR dst, size_t c, LPCWSTR src, size_t srcMax) {
    if (!dst || c == 0 || c > STRSAFE_MAX_CCH) return STRSAFE_E_INVALID_PARAMETER;
    if (!src) { dst[0] = 0; return STRSAFE_E_INVALID_PARAMETER; }
    size_t i = 0;
    for (; i < c - 1 && i < srcMax && src[i]; i++) dst[i] = src[i];
    dst[i] = 0;
    return (i < srcMax && src[i]) ? STRSAFE_E_INSUFFICIENT_BUFFER : S_OK;
}

static HRESULT cch_copyA(LPSTR dst, size_t c, LPCSTR src) {
    if (!dst || c == 0 || c > STRSAFE_MAX_CCH) return STRSAFE_E_INVALID_PARAMETER;
    if (!src) { dst[0] = 0; return STRSAFE_E_INVALID_PARAMETER; }
    size_t i = 0;
    for (; i < c - 1 && src[i]; i++) dst[i] = src[i];
    dst[i] = 0;
    return src[i] ? STRSAFE_E_INSUFFICIENT_BUFFER : S_OK;
}

static HRESULT cch_catW(LPWSTR dst, size_t c, LPCWSTR src, size_t srcMax) {
    if (!dst || c == 0 || c > STRSAFE_MAX_CCH) return STRSAFE_E_INVALID_PARAMETER;
    size_t used = 0;
    while (used < c && dst[used]) used++;
    if (used == c) return STRSAFE_E_INVALID_PARAMETER;   /* unterminated dst */
    return cch_copyW(dst + used, c - used, src, srcMax);
}

HRESULT StringCchCopyW(LPWSTR dst, size_t c, LPCWSTR src) {
    return cch_copyW(dst, c, src, (size_t)-1);
}
HRESULT StringCchCopyA(LPSTR dst, size_t c, LPCSTR src) {
    return cch_copyA(dst, c, src);
}
HRESULT StringCchCopyNW(LPWSTR dst, size_t c, LPCWSTR src, size_t n) {
    return cch_copyW(dst, c, src, n);
}
HRESULT StringCchCatW(LPWSTR dst, size_t c, LPCWSTR src) {
    return cch_catW(dst, c, src, (size_t)-1);
}
HRESULT StringCchCatA(LPSTR dst, size_t c, LPCSTR src) {
    size_t used = strlen(dst);
    if (used >= c) return STRSAFE_E_INVALID_PARAMETER;
    return cch_copyA(dst + used, c - used, src);
}
HRESULT StringCchCatNW(LPWSTR dst, size_t c, LPCWSTR src, size_t n) {
    return cch_catW(dst, c, src, n);
}

HRESULT StringCchLengthW(LPCWSTR s, size_t max, size_t *len) {
    if (!s || max > STRSAFE_MAX_CCH) return STRSAFE_E_INVALID_PARAMETER;
    size_t n = 0;
    while (n < max && s[n]) n++;
    if (n == max) return STRSAFE_E_INVALID_PARAMETER;
    if (len) *len = n;
    return S_OK;
}

static HRESULT cch_vprintfW(LPWSTR dst, size_t c, LPCWSTR fmt, va_list ap) {
    if (!dst || c == 0 || c > STRSAFE_MAX_CCH) return STRSAFE_E_INVALID_PARAMETER;
    int r = w16_vformat(dst, (int)c, fmt, ap);
    return r >= (int)c ? STRSAFE_E_INSUFFICIENT_BUFFER : S_OK;
}

HRESULT StringCchPrintfW(LPWSTR dst, size_t c, LPCWSTR fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    HRESULT hr = cch_vprintfW(dst, c, fmt, ap);
    va_end(ap);
    return hr;
}

HRESULT StringCchPrintfA(LPSTR dst, size_t c, LPCSTR fmt, ...) {
    if (!dst || c == 0) return STRSAFE_E_INVALID_PARAMETER;
    va_list ap;
    va_start(ap, fmt);
    int r = vsnprintf(dst, c, fmt, ap);
    va_end(ap);
    return (r < 0 || (size_t)r >= c) ? STRSAFE_E_INSUFFICIENT_BUFFER : S_OK;
}

static void ex_fill(LPWSTR dst, size_t c, LPWSTR *end, size_t *remaining) {
    size_t used = 0;
    while (used < c && dst[used]) used++;
    if (end) *end = dst + used;
    if (remaining) *remaining = c - used;
}

/* STRSAFE Ex flags (0211): FILL_ON_FAILURE floods the whole buffer with
 * the low-byte fill char (byte-wise, per real strsafe), NULL_ON_FAILURE
 * empties it — calc passes FILL_ON_FAILURE and it silently no-oped. */
static void ex_fail_fill(void *dst, size_t bytes, DWORD flags) {
    if (!dst || !bytes) return;
    if (flags & STRSAFE_FILL_ON_FAILURE) memset(dst, (int)(flags & 0xFF), bytes);
    else if (flags & STRSAFE_NULL_ON_FAILURE) memset(dst, 0, bytes >= 2 ? 2 : bytes);
}

HRESULT StringCchPrintfExW(LPWSTR dst, size_t c, LPWSTR *end,
                           size_t *remaining, DWORD flags, LPCWSTR fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    HRESULT hr = cch_vprintfW(dst, c, fmt, ap);
    va_end(ap);
    if (hr != S_OK) ex_fail_fill(dst, c * sizeof(WCHAR), flags);
    if (hr == S_OK || hr == STRSAFE_E_INSUFFICIENT_BUFFER) ex_fill(dst, c, end, remaining);
    return hr;
}

HRESULT StringCchPrintfExA(LPSTR dst, size_t c, LPSTR *end,
                           size_t *remaining, DWORD flags, LPCSTR fmt, ...) {
    if (!dst || c == 0) return STRSAFE_E_INVALID_PARAMETER;
    va_list ap;
    va_start(ap, fmt);
    int r = vsnprintf(dst, c, fmt, ap);
    va_end(ap);
    if (r < 0 || (size_t)r >= c) {
        ex_fail_fill(dst, c, flags);
        return STRSAFE_E_INSUFFICIENT_BUFFER;
    }
    size_t used = strlen(dst);
    if (end) *end = dst + used;
    if (remaining) *remaining = c - used;
    return S_OK;
}

/* Cb variants: byte counts -> element counts */

HRESULT StringCbCopyW(LPWSTR dst, size_t cb, LPCWSTR src) {
    return StringCchCopyW(dst, cb / sizeof(WCHAR), src);
}
HRESULT StringCbCopyA(LPSTR dst, size_t cb, LPCSTR src) {
    return StringCchCopyA(dst, cb, src);
}
HRESULT StringCbCatW(LPWSTR dst, size_t cb, LPCWSTR src) {
    return StringCchCatW(dst, cb / sizeof(WCHAR), src);
}
HRESULT StringCbCatA(LPSTR dst, size_t cb, LPCSTR src) {
    return StringCchCatA(dst, cb, src);
}

HRESULT StringCbPrintfW(LPWSTR dst, size_t cb, LPCWSTR fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    HRESULT hr = cch_vprintfW(dst, cb / sizeof(WCHAR), fmt, ap);
    va_end(ap);
    return hr;
}

HRESULT StringCbPrintfA(LPSTR dst, size_t cb, LPCSTR fmt, ...) {
    if (!dst || cb == 0) return STRSAFE_E_INVALID_PARAMETER;
    va_list ap;
    va_start(ap, fmt);
    int r = vsnprintf(dst, cb, fmt, ap);
    va_end(ap);
    return (r < 0 || (size_t)r >= cb) ? STRSAFE_E_INSUFFICIENT_BUFFER : S_OK;
}

HRESULT StringCbPrintfExW(LPWSTR dst, size_t cb, LPWSTR *end,
                          size_t *remaining, DWORD flags, LPCWSTR fmt, ...) {
    size_t c = cb / sizeof(WCHAR);
    va_list ap;
    va_start(ap, fmt);
    HRESULT hr = cch_vprintfW(dst, c, fmt, ap);
    va_end(ap);
    if (hr != S_OK) ex_fail_fill(dst, cb, flags);
    if (hr == S_OK || hr == STRSAFE_E_INSUFFICIENT_BUFFER) {
        size_t used = 0;
        while (used < c && dst[used]) used++;
        if (end) *end = dst + used;
        if (remaining) *remaining = (c - used) * sizeof(WCHAR);
    }
    return hr;
}

HRESULT StringCbCopyExW(LPWSTR dst, size_t cb, LPCWSTR src, LPWSTR *end,
                        size_t *remaining, DWORD flags) {
    size_t c = cb / sizeof(WCHAR);
    if (!src && (flags & STRSAFE_IGNORE_NULLS)) src = u"";
    HRESULT hr = StringCchCopyW(dst, c, src);
    if (hr != S_OK) ex_fail_fill(dst, cb, flags);
    if (hr == S_OK || hr == STRSAFE_E_INSUFFICIENT_BUFFER) {
        size_t used = 0;
        while (used < c && dst[used]) used++;
        if (end) *end = dst + used;
        if (remaining) *remaining = (c - used) * sizeof(WCHAR);
    }
    return hr;
}
