/* htmlhelp.h — hhctrl surface for the port corpus (todos/0060).
 * Declaration-only (calc's help window). */
#pragma once

#include <windows.h>

HWND HtmlHelpW(HWND caller, LPCWSTR file, UINT cmd, DWORD_PTR data);
HWND HtmlHelpA(HWND caller, LPCSTR file, UINT cmd, DWORD_PTR data);
#ifdef UNICODE
#define HtmlHelp HtmlHelpW
#else
#define HtmlHelp HtmlHelpA
#endif

#define HH_DISPLAY_TOPIC      0x0000
#define HH_DISPLAY_TEXT_POPUP 0x000E
#define HH_HELP_CONTEXT       0x000F
#define HH_CLOSE_ALL          0x0012

typedef struct tagHH_POPUP {
    int      cbStruct;
    HINSTANCE hinst;
    UINT     idString;
    LPCTSTR  pszText;
    POINT    pt;
    COLORREF clrForeground;
    COLORREF clrBackground;
    RECT     rcMargins;
    LPCTSTR  pszFont;
} HH_POPUP;
