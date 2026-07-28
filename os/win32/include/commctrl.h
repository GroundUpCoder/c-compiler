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

#define ICC_LISTVIEW_CLASSES 0x00000001

/* ==================================================================
 * SysHeader32 + SysListView32 (report view), todos/0370. Struct layouts
 * are the CLASSIC (pre-IE4) shapes — the corpus compiles against THESE
 * headers, so the layout is ours to pin. A/W generic per the corpus
 * convention (implemented entries are ANSI generics; W variants carry
 * UTF-16 text and translate inside the control). */

/* ---- SysHeader32 ---- */
#define WC_HEADERA "SysHeader32"
#define WC_HEADERW u"SysHeader32"

#define HDI_WIDTH   0x0001
#define HDI_TEXT    0x0002
#define HDI_FORMAT  0x0004
#define HDI_LPARAM  0x0008

#define HDF_LEFT    0x0000
#define HDF_RIGHT   0x0001
#define HDF_CENTER  0x0002
#define HDF_STRING  0x4000

typedef struct tagHDITEMA {
    UINT   mask;
    int    cxy;
    LPSTR  pszText;
    HANDLE hbm;
    int    cchTextMax;
    int    fmt;
    LPARAM lParam;
} HDITEMA, *LPHDITEMA;

typedef struct tagHDITEMW {
    UINT   mask;
    int    cxy;
    LPWSTR pszText;
    HANDLE hbm;
    int    cchTextMax;
    int    fmt;
    LPARAM lParam;
} HDITEMW, *LPHDITEMW;

#define HDM_FIRST        0x1200
#define HDM_GETITEMCOUNT (HDM_FIRST + 0)
#define HDM_INSERTITEMA  (HDM_FIRST + 1)
#define HDM_DELETEITEM   (HDM_FIRST + 2)
#define HDM_GETITEMA     (HDM_FIRST + 3)
#define HDM_SETITEMA     (HDM_FIRST + 4)
#define HDM_INSERTITEMW  (HDM_FIRST + 10)
#define HDM_GETITEMW     (HDM_FIRST + 11)
#define HDM_SETITEMW     (HDM_FIRST + 12)

typedef struct tagNMHEADERA {
    NMHDR    hdr;
    int      iItem;
    int      iButton;
    HDITEMA *pitem;
} NMHEADERA, *LPNMHEADERA;

/* ---- WM_NOTIFY codes (UINT wrap-around arithmetic, the Windows values;
 * NMHEADER/NMLISTVIEW carry no strings, so one code serves A and W) ---- */
#define NM_CLICK          ((UINT)-2)
#define NM_DBLCLK         ((UINT)-3)
#define NM_RETURN         ((UINT)-4)
#define NM_RCLICK         ((UINT)-5)
#define HDN_FIRST         ((UINT)-300)
#define HDN_ITEMCHANGEDA  (HDN_FIRST - 1)
#define HDN_ITEMCLICKA    (HDN_FIRST - 2)
#define HDN_ITEMCHANGED   HDN_ITEMCHANGEDA
#define HDN_ITEMCLICK     HDN_ITEMCLICKA
#define LVN_FIRST         ((UINT)-100)
#define LVN_ITEMCHANGED   (LVN_FIRST - 1)
#define LVN_COLUMNCLICK   (LVN_FIRST - 8)

/* ---- SysListView32 ---- */
#define WC_LISTVIEWA "SysListView32"
#define WC_LISTVIEWW u"SysListView32"

/* window styles (LVS_TYPEMASK low bits select the view) */
#define LVS_ICON            0x0000
#define LVS_REPORT          0x0001
#define LVS_SMALLICON       0x0002
#define LVS_LIST            0x0003
#define LVS_TYPEMASK        0x0003
#define LVS_SINGLESEL       0x0004
#define LVS_SHOWSELALWAYS   0x0008

/* item states */
#define LVIS_FOCUSED        0x0001
#define LVIS_SELECTED       0x0002

/* LVITEM mask */
#define LVIF_TEXT           0x0001
#define LVIF_IMAGE          0x0002
#define LVIF_PARAM          0x0004
#define LVIF_STATE          0x0008

/* LVCOLUMN mask + fmt */
#define LVCF_FMT            0x0001
#define LVCF_WIDTH          0x0002
#define LVCF_TEXT           0x0004
#define LVCF_SUBITEM        0x0008
#define LVCFMT_LEFT         0x0000
#define LVCFMT_RIGHT        0x0001
#define LVCFMT_CENTER       0x0002

/* LVM_GETNEXTITEM flags */
#define LVNI_ALL            0x0000
#define LVNI_FOCUSED        0x0001
#define LVNI_SELECTED       0x0002

/* extended styles (LVM_SET/GETEXTENDEDLISTVIEWSTYLE) */
#define LVS_EX_GRIDLINES     0x0001
#define LVS_EX_FULLROWSELECT 0x0020

/* hit-test flags */
#define LVHT_NOWHERE        0x0001
#define LVHT_ONITEMLABEL    0x0004
#define LVHT_ONITEM         0x000E

typedef struct tagLVCOLUMNA {
    UINT  mask;
    int   fmt;
    int   cx;
    LPSTR pszText;
    int   cchTextMax;
    int   iSubItem;
} LVCOLUMNA, *LPLVCOLUMNA;

typedef struct tagLVCOLUMNW {
    UINT   mask;
    int    fmt;
    int    cx;
    LPWSTR pszText;
    int    cchTextMax;
    int    iSubItem;
} LVCOLUMNW, *LPLVCOLUMNW;

typedef struct tagLVITEMA {
    UINT   mask;
    int    iItem;
    int    iSubItem;
    UINT   state;
    UINT   stateMask;
    LPSTR  pszText;
    int    cchTextMax;
    int    iImage;
    LPARAM lParam;
} LVITEMA, *LPLVITEMA;

typedef struct tagLVITEMW {
    UINT   mask;
    int    iItem;
    int    iSubItem;
    UINT   state;
    UINT   stateMask;
    LPWSTR pszText;
    int    cchTextMax;
    int    iImage;
    LPARAM lParam;
} LVITEMW, *LPLVITEMW;

typedef struct tagLVHITTESTINFO {
    POINT pt;
    UINT  flags;
    int   iItem;
    int   iSubItem;
} LVHITTESTINFO, *LPLVHITTESTINFO;

typedef struct tagNMLISTVIEW {
    NMHDR  hdr;
    int    iItem;
    int    iSubItem;
    UINT   uNewState;
    UINT   uOldState;
    UINT   uChanged;
    POINT  ptAction;
    LPARAM lParam;
} NMLISTVIEW, *LPNMLISTVIEW;

typedef int (*PFNLVCOMPARE)(LPARAM, LPARAM, LPARAM);

#define LVM_FIRST                     0x1000
#define LVM_GETITEMCOUNT              (LVM_FIRST + 4)
#define LVM_GETITEMA                  (LVM_FIRST + 5)
#define LVM_SETITEMA                  (LVM_FIRST + 6)
#define LVM_INSERTITEMA               (LVM_FIRST + 7)
#define LVM_DELETEITEM                (LVM_FIRST + 8)
#define LVM_DELETEALLITEMS            (LVM_FIRST + 9)
#define LVM_GETNEXTITEM               (LVM_FIRST + 12)
#define LVM_HITTEST                   (LVM_FIRST + 18)
#define LVM_ENSUREVISIBLE             (LVM_FIRST + 19)
#define LVM_GETCOLUMNA                (LVM_FIRST + 25)
#define LVM_SETCOLUMNA                (LVM_FIRST + 26)
#define LVM_INSERTCOLUMNA             (LVM_FIRST + 27)
#define LVM_DELETECOLUMN              (LVM_FIRST + 28)
#define LVM_GETHEADER                 (LVM_FIRST + 31)
#define LVM_SETITEMSTATE              (LVM_FIRST + 43)
#define LVM_GETITEMSTATE              (LVM_FIRST + 44)
#define LVM_GETITEMTEXTA              (LVM_FIRST + 45)
#define LVM_SETITEMTEXTA              (LVM_FIRST + 46)
#define LVM_SORTITEMS                 (LVM_FIRST + 48)
#define LVM_GETSELECTEDCOUNT          (LVM_FIRST + 50)
#define LVM_SETEXTENDEDLISTVIEWSTYLE  (LVM_FIRST + 54)
#define LVM_GETEXTENDEDLISTVIEWSTYLE  (LVM_FIRST + 55)
#define LVM_GETITEMW                  (LVM_FIRST + 75)
#define LVM_SETITEMW                  (LVM_FIRST + 76)
#define LVM_INSERTITEMW               (LVM_FIRST + 77)
#define LVM_GETCOLUMNW                (LVM_FIRST + 95)
#define LVM_SETCOLUMNW                (LVM_FIRST + 96)
#define LVM_INSERTCOLUMNW             (LVM_FIRST + 97)
#define LVM_GETITEMTEXTW              (LVM_FIRST + 115)
#define LVM_SETITEMTEXTW              (LVM_FIRST + 116)

#ifdef UNICODE
#define WC_HEADER        WC_HEADERW
#define WC_LISTVIEW      WC_LISTVIEWW
#define HDITEM           HDITEMW
#define LPHDITEM         LPHDITEMW
#define HDM_INSERTITEM   HDM_INSERTITEMW
#define HDM_GETITEM      HDM_GETITEMW
#define HDM_SETITEM      HDM_SETITEMW
#define LVCOLUMN         LVCOLUMNW
#define LPLVCOLUMN       LPLVCOLUMNW
#define LVITEM           LVITEMW
#define LPLVITEM         LPLVITEMW
#define LVM_GETITEM      LVM_GETITEMW
#define LVM_SETITEM      LVM_SETITEMW
#define LVM_INSERTITEM   LVM_INSERTITEMW
#define LVM_GETCOLUMN    LVM_GETCOLUMNW
#define LVM_SETCOLUMN    LVM_SETCOLUMNW
#define LVM_INSERTCOLUMN LVM_INSERTCOLUMNW
#define LVM_GETITEMTEXT  LVM_GETITEMTEXTW
#define LVM_SETITEMTEXT  LVM_SETITEMTEXTW
#define NMHEADER         NMHEADERA          /* no strings ride it here */
#else
#define WC_HEADER        WC_HEADERA
#define WC_LISTVIEW      WC_LISTVIEWA
#define HDITEM           HDITEMA
#define LPHDITEM         LPHDITEMA
#define HDM_INSERTITEM   HDM_INSERTITEMA
#define HDM_GETITEM      HDM_GETITEMA
#define HDM_SETITEM      HDM_SETITEMA
#define LVCOLUMN         LVCOLUMNA
#define LPLVCOLUMN       LPLVCOLUMNA
#define LVITEM           LVITEMA
#define LPLVITEM         LPLVITEMA
#define LVM_GETITEM      LVM_GETITEMA
#define LVM_SETITEM      LVM_SETITEMA
#define LVM_INSERTITEM   LVM_INSERTITEMA
#define LVM_GETCOLUMN    LVM_GETCOLUMNA
#define LVM_SETCOLUMN    LVM_SETCOLUMNA
#define LVM_INSERTCOLUMN LVM_INSERTCOLUMNA
#define LVM_GETITEMTEXT  LVM_GETITEMTEXTA
#define LVM_SETITEMTEXT  LVM_SETITEMTEXTA
#define NMHEADER         NMHEADERA
#endif

/* The classic macro wrappers the corpus reaches for. */
#define ListView_GetItemCount(h)            ((int)SendMessage((h), LVM_GETITEMCOUNT, 0, 0))
#define ListView_InsertColumn(h, i, c)      ((int)SendMessage((h), LVM_INSERTCOLUMN, (WPARAM)(i), (LPARAM)(c)))
#define ListView_DeleteColumn(h, i)         ((BOOL)SendMessage((h), LVM_DELETECOLUMN, (WPARAM)(i), 0))
#define ListView_InsertItem(h, it)          ((int)SendMessage((h), LVM_INSERTITEM, 0, (LPARAM)(it)))
#define ListView_DeleteItem(h, i)           ((BOOL)SendMessage((h), LVM_DELETEITEM, (WPARAM)(i), 0))
#define ListView_DeleteAllItems(h)          ((BOOL)SendMessage((h), LVM_DELETEALLITEMS, 0, 0))
#define ListView_GetNextItem(h, i, f)       ((int)SendMessage((h), LVM_GETNEXTITEM, (WPARAM)(i), (LPARAM)(f)))
#define ListView_SetItemState(h, i, st, m)  do { LVITEM _lvsi; _lvsi.state = (st); _lvsi.stateMask = (m); \
        SendMessage((h), LVM_SETITEMSTATE, (WPARAM)(i), (LPARAM)&_lvsi); } while (0)
#define ListView_GetItemState(h, i, m)      ((UINT)SendMessage((h), LVM_GETITEMSTATE, (WPARAM)(i), (LPARAM)(m)))
#define ListView_EnsureVisible(h, i, p)     ((BOOL)SendMessage((h), LVM_ENSUREVISIBLE, (WPARAM)(i), (LPARAM)(p)))
#define ListView_SortItems(h, fn, ctx)      ((BOOL)SendMessage((h), LVM_SORTITEMS, (WPARAM)(ctx), (LPARAM)(fn)))
#define ListView_GetSelectedCount(h)        ((UINT)SendMessage((h), LVM_GETSELECTEDCOUNT, 0, 0))
#define ListView_HitTest(h, ht)             ((int)SendMessage((h), LVM_HITTEST, 0, (LPARAM)(ht)))
#define ListView_GetHeader(h)               ((HWND)SendMessage((h), LVM_GETHEADER, 0, 0))
#define ListView_SetExtendedListViewStyle(h, s) \
        ((DWORD)SendMessage((h), LVM_SETEXTENDEDLISTVIEWSTYLE, 0, (LPARAM)(s)))
#define Header_GetItemCount(h)              ((int)SendMessage((h), HDM_GETITEMCOUNT, 0, 0))

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
