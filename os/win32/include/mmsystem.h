/* mmsystem.h — winmm surface for the port corpus (todos/0060).
 * Declaration-only; PlaySound demand rides PORTS.md (the OS already has
 * a kernel mixer — todos/0017 — so the implementation is a small shim). */
#pragma once

#include <windows.h>

BOOL PlaySoundW(LPCWSTR sound, HMODULE mod, DWORD flags);
#ifdef UNICODE
#define PlaySound PlaySoundW
#endif

#define SND_SYNC      0x0000
#define SND_ASYNC     0x0001
#define SND_NODEFAULT 0x0002
#define SND_MEMORY    0x0004
#define SND_LOOP      0x0008
#define SND_NOSTOP    0x0010
#define SND_PURGE     0x0040
#define SND_FILENAME  0x00020000
#define SND_RESOURCE  0x00040004
