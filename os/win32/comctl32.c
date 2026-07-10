/* comctl32.c — the common-controls veneer slice (todos/0048, design
 * todos/WIN32.md). The "common controls" here ARE user32's controls —
 * this OS has one control implementation, so Init* has nothing to load
 * and the library exists for the entry points the port corpus links
 * (calc calls InitCommonControls for theming/manifest reasons only). */

#undef UNICODE
#undef _UNICODE
#include <windows.h>
#include <commctrl.h>

void InitCommonControls(void) { /* one toolkit, nothing to register */ }

BOOL InitCommonControlsEx(const INITCOMMONCONTROLSEX *icc) {
    return icc != NULL && icc->dwSize == sizeof *icc;
}
