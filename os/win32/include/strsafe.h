/* strsafe.h — declaration-only (todos/0060). On Windows this is a
 * header-only inline library; here the W entries are veneer symbols so
 * unimplemented ones land in the PORTS.md demand log (0059 implements
 * them as a real strsafe.c slice). Cb variants take BYTE counts, Cch
 * take character counts (C11 draft: STRSAFE_MAX_CCH 2^31-1). */
#pragma once

#include <windows.h>

typedef HRESULT STRSAFEAPI;
#define STRSAFE_E_INSUFFICIENT_BUFFER ((HRESULT)0x8007007A)
#define STRSAFE_E_INVALID_PARAMETER   ((HRESULT)0x80070057)
#define STRSAFE_MAX_CCH 2147483647

HRESULT StringCchCopyW(LPWSTR dst, size_t cchDst, LPCWSTR src);
HRESULT StringCchCopyA(LPSTR dst, size_t cchDst, LPCSTR src);
HRESULT StringCchCopyNW(LPWSTR dst, size_t cchDst, LPCWSTR src, size_t cchSrc);
HRESULT StringCchCatW(LPWSTR dst, size_t cchDst, LPCWSTR src);
HRESULT StringCchCatA(LPSTR dst, size_t cchDst, LPCSTR src);
HRESULT StringCchPrintfW(LPWSTR dst, size_t cchDst, LPCWSTR fmt, ...);
HRESULT StringCchPrintfA(LPSTR dst, size_t cchDst, LPCSTR fmt, ...);
HRESULT StringCchLengthW(LPCWSTR s, size_t max, size_t *len);
HRESULT StringCchPrintfExW(LPWSTR dst, size_t cchDst, LPWSTR *end,
                           size_t *remaining, DWORD flags, LPCWSTR fmt, ...);
HRESULT StringCchPrintfExA(LPSTR dst, size_t cchDst, LPSTR *end,
                           size_t *remaining, DWORD flags, LPCSTR fmt, ...);
HRESULT StringCchCatNW(LPWSTR dst, size_t cchDst, LPCWSTR src, size_t cchSrc);
HRESULT StringCbPrintfExW(LPWSTR dst, size_t cbDst, LPWSTR *end,
                          size_t *remaining, DWORD flags, LPCWSTR fmt, ...);
HRESULT StringCbCopyExW(LPWSTR dst, size_t cbDst, LPCWSTR src, LPWSTR *end,
                        size_t *remaining, DWORD flags);
#define STRSAFE_IGNORE_NULLS      0x00000100
#define STRSAFE_FILL_BEHIND_NULL  0x00000200
#define STRSAFE_FILL_ON_FAILURE   0x00000400
#define STRSAFE_NULL_ON_FAILURE   0x00000800
#define STRSAFE_NO_TRUNCATION     0x00001000
HRESULT StringCbCopyW(LPWSTR dst, size_t cbDst, LPCWSTR src);
HRESULT StringCbCopyA(LPSTR dst, size_t cbDst, LPCSTR src);
HRESULT StringCbCatW(LPWSTR dst, size_t cbDst, LPCWSTR src);
HRESULT StringCbCatA(LPSTR dst, size_t cbDst, LPCSTR src);
HRESULT StringCbPrintfW(LPWSTR dst, size_t cbDst, LPCWSTR fmt, ...);
HRESULT StringCbPrintfA(LPSTR dst, size_t cbDst, LPCSTR fmt, ...);

#ifdef UNICODE
#define StringCchCopy StringCchCopyW
#define StringCchCopyN StringCchCopyNW
#define StringCchCat StringCchCatW
#define StringCchPrintf StringCchPrintfW
#define StringCchPrintfEx StringCchPrintfExW
#define StringCchLength StringCchLengthW
#define StringCbCopy StringCbCopyW
#define StringCbCopyEx StringCbCopyExW
#define StringCbCat StringCbCatW
#define StringCbPrintf StringCbPrintfW
#define StringCbPrintfEx StringCbPrintfExW
#define StringCchCatN StringCchCatNW
#else
#define StringCchCopy StringCchCopyA
#define StringCchCat StringCchCatA
#define StringCchPrintf StringCchPrintfA
#define StringCbCopy StringCbCopyA
#define StringCbCat StringCbCatA
#define StringCbPrintf StringCbPrintfA
#endif
