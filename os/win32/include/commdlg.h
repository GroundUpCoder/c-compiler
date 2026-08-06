/* commdlg.h — comdlg32 surface for the port corpus (todos/0060).
 * Declaration-only: the common dialogs are a 0059+ growth item; every
 * entry point referenced here logs into PORTS.md. Struct layouts follow
 * the classic (pre-Win2000) sizes — ILP32 like the rest of the veneer. */
#pragma once

#include <windows.h>
#include <commctrl.h>   /* NMHDR for the OFNOTIFY hook records */

typedef UINT_PTR (*LPOFNHOOKPROC)(HWND, UINT, WPARAM, LPARAM);
typedef UINT_PTR (*LPCCHOOKPROC)(HWND, UINT, WPARAM, LPARAM);
typedef UINT_PTR (*LPCFHOOKPROC)(HWND, UINT, WPARAM, LPARAM);
typedef UINT_PTR (*LPFRHOOKPROC)(HWND, UINT, WPARAM, LPARAM);
typedef UINT_PTR (*LPPRINTHOOKPROC)(HWND, UINT, WPARAM, LPARAM);
typedef UINT_PTR (*LPSETUPHOOKPROC)(HWND, UINT, WPARAM, LPARAM);
typedef UINT_PTR (*LPPAGESETUPHOOK)(HWND, UINT, WPARAM, LPARAM);
typedef UINT_PTR (*LPPAGEPAINTHOOK)(HWND, UINT, WPARAM, LPARAM);

typedef struct tagOFNW {
    DWORD     lStructSize;
    HWND      hwndOwner;
    HINSTANCE hInstance;
    LPCWSTR   lpstrFilter;
    LPWSTR    lpstrCustomFilter;
    DWORD     nMaxCustFilter;
    DWORD     nFilterIndex;
    LPWSTR    lpstrFile;
    DWORD     nMaxFile;
    LPWSTR    lpstrFileTitle;
    DWORD     nMaxFileTitle;
    LPCWSTR   lpstrInitialDir;
    LPCWSTR   lpstrTitle;
    DWORD     Flags;
    WORD      nFileOffset;
    WORD      nFileExtension;
    LPCWSTR   lpstrDefExt;
    LPARAM    lCustData;
    LPOFNHOOKPROC lpfnHook;
    LPCWSTR   lpTemplateName;
} OPENFILENAMEW, *LPOPENFILENAMEW;

#define OFN_READONLY             0x00000001
#define OFN_OVERWRITEPROMPT      0x00000002
#define OFN_HIDEREADONLY         0x00000004
#define OFN_ENABLEHOOK           0x00000020
#define OFN_ENABLETEMPLATE       0x00000040
#define OFN_PATHMUSTEXIST        0x00000800
#define OFN_FILEMUSTEXIST        0x00001000
#define OFN_EXPLORER             0x00080000

BOOL GetOpenFileNameW(OPENFILENAMEW *ofn);
BOOL GetSaveFileNameW(OPENFILENAMEW *ofn);
short GetFileTitleW(LPCWSTR file, LPWSTR title, WORD n);

/* Explorer-dialog hook notifications */
typedef struct _OFNOTIFYW {
    NMHDR hdr;
    OPENFILENAMEW *lpOFN;
    LPWSTR pszFile;
} OFNOTIFYW, *LPOFNOTIFYW;
#define CDN_FIRST  (0u - 601u)
#define CDN_FILEOK (CDN_FIRST - 5)

typedef struct tagCHOOSEFONTW {
    DWORD     lStructSize;
    HWND      hwndOwner;
    HDC       hDC;
    LOGFONTW *lpLogFont;
    INT       iPointSize;
    DWORD     Flags;
    COLORREF  rgbColors;
    LPARAM    lCustData;
    LPCFHOOKPROC lpfnHook;
    LPCWSTR   lpTemplateName;
    HINSTANCE hInstance;
    LPWSTR    lpszStyle;
    WORD      nFontType;
    WORD      ___MISSING_ALIGNMENT__;
    INT       nSizeMin;
    INT       nSizeMax;
} CHOOSEFONTW, *LPCHOOSEFONTW;

#define CF_SCREENFONTS       0x00000001
#define CF_PRINTERFONTS      0x00000002
#define CF_BOTH              (CF_SCREENFONTS | CF_PRINTERFONTS)
#define CF_INITTOLOGFONTSTRUCT 0x00000040
#define CF_NOVERTFONTS       0x01000000

BOOL ChooseFontW(CHOOSEFONTW *cf);

typedef struct tagFINDREPLACEW {
    DWORD     lStructSize;
    HWND      hwndOwner;
    HINSTANCE hInstance;
    DWORD     Flags;
    LPWSTR    lpstrFindWhat;
    LPWSTR    lpstrReplaceWith;
    WORD      wFindWhatLen;
    WORD      wReplaceWithLen;
    LPARAM    lCustData;
    LPFRHOOKPROC lpfnHook;
    LPCWSTR   lpTemplateName;
} FINDREPLACEW, *LPFINDREPLACEW;

#define FR_DOWN         0x00000001
#define FR_WHOLEWORD    0x00000002
#define FR_MATCHCASE    0x00000004
#define FR_FINDNEXT     0x00000008
#define FR_REPLACE      0x00000010
#define FR_REPLACEALL   0x00000020
#define FR_DIALOGTERM   0x00000040
#define FR_HIDEUPDOWN   0x00004000
#define FR_HIDEMATCHCASE 0x00008000
#define FR_HIDEWHOLEWORD 0x00010000

HWND FindTextW(FINDREPLACEW *fr);
HWND ReplaceTextW(FINDREPLACEW *fr);
UINT RegisterWindowMessageW(LPCWSTR name);
#define FINDMSGSTRINGW u"commdlg_FindReplace"
#define FINDMSGSTRINGA "commdlg_FindReplace"

typedef struct tagPDW {
    DWORD     lStructSize;
    HWND      hwndOwner;
    HGLOBAL   hDevMode;
    HGLOBAL   hDevNames;
    HDC       hDC;
    DWORD     Flags;
    WORD      nFromPage;
    WORD      nToPage;
    WORD      nMinPage;
    WORD      nMaxPage;
    WORD      nCopies;
    HINSTANCE hInstance;
    LPARAM    lCustData;
    LPPRINTHOOKPROC lpfnPrintHook;
    LPSETUPHOOKPROC lpfnSetupHook;
    LPCWSTR   lpPrintTemplateName;
    LPCWSTR   lpSetupTemplateName;
    HGLOBAL   hPrintTemplate;
    HGLOBAL   hSetupTemplate;
} PRINTDLGW, *LPPRINTDLGW;

#define PD_ALLPAGES        0x00000000
#define PD_SELECTION       0x00000001
#define PD_PAGENUMS        0x00000002
#define PD_NOSELECTION     0x00000004
#define PD_RETURNDC        0x00000100
#define PD_RETURNDEFAULT   0x00000400
#define PD_USEDEVMODECOPIESANDCOLLATE 0x00040000

BOOL PrintDlgW(PRINTDLGW *pd);

typedef struct tagPSDW {
    DWORD     lStructSize;
    HWND      hwndOwner;
    HGLOBAL   hDevMode;
    HGLOBAL   hDevNames;
    DWORD     Flags;
    POINT     ptPaperSize;
    RECT      rtMinMargin;
    RECT      rtMargin;
    HINSTANCE hInstance;
    LPARAM    lCustData;
    LPPAGESETUPHOOK lpfnPageSetupHook;
    LPPAGEPAINTHOOK lpfnPagePaintHook;
    LPCWSTR   lpPageSetupTemplateName;
    HGLOBAL   hPageSetupTemplate;
} PAGESETUPDLGW, *LPPAGESETUPDLGW;

#define PSD_INHUNDREDTHSOFMILLIMETERS 0x00000008
#define PSD_MARGINS                   0x00000002
#define PSD_RETURNDEFAULT             0x00000400
#define PSD_ENABLEPAGESETUPHOOK       0x00002000
#define PSD_ENABLEPAGESETUPTEMPLATE   0x00008000

BOOL PageSetupDlgW(PAGESETUPDLGW *psd);
DWORD CommDlgExtendedError(void);

#ifdef UNICODE
#define OPENFILENAME OPENFILENAMEW
#define LPOPENFILENAME LPOPENFILENAMEW
#define GetOpenFileName GetOpenFileNameW
#define GetSaveFileName GetSaveFileNameW
#define GetFileTitle GetFileTitleW
#define CHOOSEFONT CHOOSEFONTW
#define ChooseFont ChooseFontW
#define FINDREPLACE FINDREPLACEW
#define LPFINDREPLACE LPFINDREPLACEW
#define FindText FindTextW
#define ReplaceText ReplaceTextW
#define RegisterWindowMessage RegisterWindowMessageW
#define FINDMSGSTRING FINDMSGSTRINGW
#define PRINTDLG PRINTDLGW
#define LPPRINTDLG LPPRINTDLGW
#define PrintDlg PrintDlgW
#define PAGESETUPDLG PAGESETUPDLGW
#define LPPAGESETUPDLG LPPAGESETUPDLGW
#define PageSetupDlg PageSetupDlgW
#endif
