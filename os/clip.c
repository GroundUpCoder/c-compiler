/* clip.c — the shell's clipboard bridge (todos/0090): Windows' clip.exe
 * shape plus a read flag.
 *
 *   cmd | clip        stdin -> the system clipboard
 *   clip -o           clipboard -> stdout (exit 1 if empty)
 *
 * The clipboard is the kernel's one slot (SDL_clipboard over the CLIP_SET/
 * CLIP_GET RPCs) — shared with term's Ctrl+Shift+C/V and every win32 app's
 * Ctrl+C/X/V, so `echo hi | clip` really pastes into notepad. Text only:
 * SDL_SetClipboardText is a C string, so bytes past a NUL don't ride.
 */
#include <SDL.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char **argv) {
    if (argc > 1 && strcmp(argv[1], "-o") == 0) {
        char *t = SDL_GetClipboardText();
        if (!t || !t[0]) { SDL_free(t); return 1; }
        fputs(t, stdout);
        SDL_free(t);
        return 0;
    }
    if (argc > 1) {
        fprintf(stderr, "usage: cmd | clip   (stdin -> clipboard)\n"
                        "       clip -o      (clipboard -> stdout)\n");
        return 2;
    }
    size_t cap = 65536, n = 0;
    char *buf = malloc(cap);
    if (!buf) { perror("clip"); return 1; }
    for (;;) {
        if (n + 1 >= cap) {
            cap *= 2;
            char *nb = realloc(buf, cap);
            if (!nb) { perror("clip"); return 1; }
            buf = nb;
        }
        ssize_t r = read(0, buf + n, cap - n - 1);
        if (r < 0) { perror("clip"); return 1; }
        if (r == 0) break;
        n += (size_t)r;
    }
    buf[n] = 0;
    if (!SDL_SetClipboardText(buf)) {
        fprintf(stderr, "clip: %s\n", SDL_GetError());
        return 1;
    }
    return 0;
}
