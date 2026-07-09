/* win32_internal.h — the private seam between gdi32.c and user32.c
 * (todos/0058). Not on the app include path; both sources include it by
 * relative name.
 *
 * gdi32 owns DCs and drawing; user32 owns HWNDs and presenting. A "screen"
 * DC is just a wrap of a raw RGBA span (the window surface, offset to the
 * target window's client origin) — SelectObject(bitmap) refuses on it and
 * DeleteDC refuses (unwrap frees it), exactly like a real GetDC DC.
 */
#pragma once

#include <windows.h>
#include <stdint.h>

/* Wrap a raw RGBA pixel span as a screen-kind DC. `bits` points at the
 * DC's (0,0); stride is in PIXELS. Counted in __gdi_dc_count. */
HDC __gdi_dc_wrap(void *bits, int w, int h, int stridePx);

/* Free a wrapped DC (no present — that is user32's job). */
void __gdi_dc_unwrap(HDC dc);
