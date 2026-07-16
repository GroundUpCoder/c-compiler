/* commctrl.h — comctl32 surface for the port corpus (todos/0060).
 * Declaration-only; the status bar (notepad) is the first real demand. */
#pragma once

#include <windows.h>

typedef struct tagINITCOMMONCONTROLSEX {
    DWORD dwSize;
    DWORD dwICC;
} INITCOMMONCONTROLSEX, *LPINITCOMMONCONTROLSEX;

#define ICC_WIN95_CLASSES 0x000000FF
#define ICC_BAR_CLASSES   0x00000004
#define ICC_STANDARD_CLASSES 0x00004000

void InitCommonControls(void);
BOOL InitCommonControlsEx(const INITCOMMONCONTROLSEX *icc);

typedef struct tagNMHDR {
    HWND     hwndFrom;
    UINT_PTR idFrom;
    UINT     code;
} NMHDR, *LPNMHDR;
#define WM_NOTIFY 0x004E

/* Status bar */
#define STATUSCLASSNAMEW u"msctls_statusbar32"
#define STATUSCLASSNAMEA "msctls_statusbar32"
#ifdef UNICODE
#define STATUSCLASSNAME STATUSCLASSNAMEW
#else
#define STATUSCLASSNAME STATUSCLASSNAMEA
#endif
#define WM_USER_SB 0x0400
#define SB_SETTEXTA (WM_USER_SB + 1)
#define SB_SETTEXTW (WM_USER_SB + 11)
#define SB_SETPARTS (WM_USER_SB + 4)
#define SB_GETRECT  (WM_USER_SB + 10)
#define SBARS_SIZEGRIP 0x0100
#define CCS_TOP    0x0001
#define CCS_BOTTOM 0x0003
#define CCS_NORESIZE 0x0004
#ifdef UNICODE
#define SB_SETTEXT SB_SETTEXTW
#else
#define SB_SETTEXT SB_SETTEXTA
#endif
HWND CreateStatusWindowW(LONG style, LPCWSTR text, HWND parent, UINT id);
HWND CreateStatusWindowA(LONG style, LPCSTR text, HWND parent, UINT id);
#ifdef UNICODE
#define CreateStatusWindow CreateStatusWindowW
#else
#define CreateStatusWindow CreateStatusWindowA
#endif

/* Common-control class names */
#define WC_BUTTONW    u"Button"
#define WC_BUTTONA    "Button"
#define WC_STATICW    u"Static"
#define WC_STATICA    "Static"
#define WC_EDITW      u"Edit"
#define WC_EDITA      "Edit"
#define WC_LISTBOXW   u"ListBox"
#define WC_LISTBOXA   "ListBox"
#define WC_COMBOBOXW  u"ComboBox"
#define WC_COMBOBOXA  "ComboBox"
#ifdef UNICODE
#define WC_BUTTON   WC_BUTTONW
#define WC_STATIC   WC_STATICW
#define WC_EDIT     WC_EDITW
#define WC_LISTBOX  WC_LISTBOXW
#define WC_COMBOBOX WC_COMBOBOXW
#else
#define WC_BUTTON   WC_BUTTONA
#define WC_STATIC   WC_STATICA
#define WC_EDIT     WC_EDITA
#define WC_LISTBOX  WC_LISTBOXA
#define WC_COMBOBOX WC_COMBOBOXA
#endif
