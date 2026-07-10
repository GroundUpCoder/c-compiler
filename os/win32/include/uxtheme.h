/* uxtheme.h — visual-styles surface for the port corpus (todos/0060).
 * Declaration-only: calc's theme.c is the only consumer; the veneer has
 * no theming (Win95 look by design), so these will stay in the demand
 * log until a stub slice returns "not themed". */
#pragma once

#include <windows.h>

HTHEME OpenThemeData(HWND hwnd, LPCWSTR classList);
HRESULT CloseThemeData(HTHEME theme);
HRESULT DrawThemeBackground(HTHEME theme, HDC hdc, int part, int state,
                            const RECT *rect, const RECT *clip);
HRESULT DrawThemeText(HTHEME theme, HDC hdc, int part, int state,
                      LPCWSTR text, int len, DWORD flags, DWORD flags2,
                      const RECT *rect);
HRESULT GetThemeColor(HTHEME theme, int part, int state, int prop, COLORREF *out);
HRESULT GetThemeBackgroundContentRect(HTHEME theme, HDC hdc, int part,
                                      int state, const RECT *bounding, RECT *out);
HRESULT SetWindowTheme(HWND hwnd, LPCWSTR subApp, LPCWSTR subIdList);
BOOL IsThemeActive(void);
BOOL IsAppThemed(void);
BOOL IsThemeBackgroundPartiallyTransparent(HTHEME theme, int part, int state);
HRESULT DrawThemeParentBackground(HWND hwnd, HDC hdc, const RECT *rect);
