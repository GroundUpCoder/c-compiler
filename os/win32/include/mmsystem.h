/* mmsystem.h — winmm surface for the port corpus (todos/0060).
 * PlaySound is real since todos/0094: WAVs through the 0017 kernel mixer
 * over the os/sounds.h event-scheme core (winmm.c documents the exact
 * contract — SND_RESOURCE stays silent success, SND_LOOP plays once). */
#pragma once

#include <windows.h>

BOOL PlaySoundA(LPCSTR sound, HMODULE mod, DWORD flags);
BOOL PlaySoundW(LPCWSTR sound, HMODULE mod, DWORD flags);
#ifdef UNICODE
#define PlaySound PlaySoundW
#else
#define PlaySound PlaySoundA
#endif

#define SND_SYNC      0x0000
#define SND_ASYNC     0x0001
#define SND_NODEFAULT 0x0002
#define SND_MEMORY    0x0004
#define SND_LOOP      0x0008
#define SND_NOSTOP    0x0010
#define SND_PURGE     0x0040
#define SND_ALIAS     0x00010000
#define SND_FILENAME  0x00020000
#define SND_RESOURCE  0x00040004
