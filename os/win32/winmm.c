/* winmm.c — the winmm veneer slice (todos/0068, design todos/WIN32.md).
 * PlaySoundW is a SUCCESS STUB by the 0068 acceptance: the OS has a real
 * kernel mixer (todos/0017), but the corpus' wave assets are deliberately
 * not vendored (winmine's .wavs) — when a port ships waves worth hearing,
 * route SND_RESOURCE through the WRES pack into an SDL_AudioStream here. */

#undef UNICODE
#undef _UNICODE
#include <windows.h>
#include <mmsystem.h>

BOOL PlaySoundW(LPCWSTR sound, HMODULE mod, DWORD flags) {
    (void)sound; (void)mod; (void)flags;
    return TRUE;
}
