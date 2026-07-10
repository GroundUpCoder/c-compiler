/* tchar.h — the TCHAR CRT surface for the port corpus (todos/0060).
 *
 * Deviation from Windows, on purpose: there _tcslen is a macro onto the
 * 16-bit-wchar_t msvcrt (wcslen). This libc's wchar_t is 4 bytes, so the
 * msvcrt names would collide with <wchar.h> at the wrong width. Instead
 * the _tcs / _t names ARE the veneer's real 16-bit symbols under
 * _UNICODE — declared here, implemented to PORTS.md demand (0059). A
 * "_tcslen" in the missing-symbol log reads as "16-bit wide CRT needed".
 */
#pragma once

#include <windows.h>
#include <string.h>
#include <stdlib.h>

#define _T(q)    __TEXT(q)
#define _TEXT(q) __TEXT(q)

#ifdef _UNICODE

typedef WCHAR _TCHAR;

/* the CRT entry alias (Windows' tchar.h does exactly this): a port
 * defining _tWinMain IS defining wWinMain — os/win32/wwinmain.c calls it */
#define _tWinMain wWinMain

size_t _tcslen(const WCHAR *s);
WCHAR *_tcscpy(WCHAR *dst, const WCHAR *src);
WCHAR *_tcsncpy(WCHAR *dst, const WCHAR *src, size_t n);
WCHAR *_tcscat(WCHAR *dst, const WCHAR *src);
int    _tcscmp(const WCHAR *a, const WCHAR *b);
int    _tcsncmp(const WCHAR *a, const WCHAR *b, size_t n);
int    _tcsicmp(const WCHAR *a, const WCHAR *b);
int    _tcsnicmp(const WCHAR *a, const WCHAR *b, size_t n);
WCHAR *_tcschr(const WCHAR *s, WCHAR c);
WCHAR *_tcsrchr(const WCHAR *s, WCHAR c);
WCHAR *_tcsstr(const WCHAR *hay, const WCHAR *needle);
WCHAR *_tcsdup(const WCHAR *s);
int    _stscanf(const WCHAR *s, const WCHAR *fmt, ...);
int    _stprintf(WCHAR *buf, const WCHAR *fmt, ...);
int    _sntprintf(WCHAR *buf, size_t n, const WCHAR *fmt, ...);
int    _ttoi(const WCHAR *s);
long   _ttol(const WCHAR *s);
int    _istalpha(WCHAR c);
int    _istalnum(WCHAR c);
int    _istdigit(WCHAR c);
int    _istspace(WCHAR c);
WCHAR  _totupper(WCHAR c);
WCHAR  _totlower(WCHAR c);

#else /* !_UNICODE: the TCHAR names are the narrow libc */

typedef char _TCHAR;

#define _tcslen   strlen
#define _tcscpy   strcpy
#define _tcsncpy  strncpy
#define _tcscat   strcat
#define _tcscmp   strcmp
#define _tcsncmp  strncmp
#define _tcschr   strchr
#define _tcsrchr  strrchr
#define _tcsstr   strstr
#define _ttoi     atoi
#define _ttol     atol

#endif /* _UNICODE */

/* charset-free msvcrt crumbs */
#include <alloca.h>
#define _alloca alloca
#define _countof(a) (sizeof(a) / sizeof((a)[0]))
char *_strdup(const char *s);
char *_strupr(char *s);
