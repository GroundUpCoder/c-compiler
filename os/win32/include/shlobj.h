/* shlobj.h — shell32 folder surface for the port corpus (todos/0060).
 * Declaration-only. */
#pragma once

#include <windows.h>
#include <shellapi.h>

#define CSIDL_PERSONAL 0x0005
#define CSIDL_DESKTOP  0x0000
#define SHGFP_TYPE_CURRENT 0

BOOL SHGetSpecialFolderPathW(HWND hwnd, LPWSTR path, int csidl, BOOL create);
HRESULT SHGetFolderPathW(HWND hwnd, int csidl, HANDLE token, DWORD flags, LPWSTR path);
#ifdef UNICODE
#define SHGetSpecialFolderPath SHGetSpecialFolderPathW
#define SHGetFolderPath SHGetFolderPathW
#endif
