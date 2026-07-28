/* clipio.h — clipboard I/O over the kernel's ONE clipboard slot, ONE
 * implementation in ONE place (todos/0397).
 *
 * Header-only by design (the openwith.h / fileops.h precedent): /bin/clip
 * (the Windows clip.exe shape, todos/0090), /bin/pbcopy and /bin/pbpaste
 * (the macOS shape) are three front-ends over these two operations and
 * must stay behaviorally identical through them. The manifest stages the
 * header beside each source via image.json's `hdrs` field, so there is no
 * link coupling and no second copy of the buffer growth loop.
 *
 * The slot is the kernel's single clipboard (SDL_SetClipboardText /
 * SDL_GetClipboardText across the CLIP_SET/CLIP_GET RPCs), shared with
 * term's Ctrl+Shift+C/V, every win32 app's Ctrl+C/X/V, and the host
 * browser clipboard seam. So a write here really pastes into notepad, and
 * a read really sees what the user copied on the host.
 *
 * KNOWN LIMIT, carried forward deliberately: the slot is a C string, so
 * TEXT ONLY — bytes at or past a NUL do not ride. clipio_set_from_fd
 * still reads its input to EOF and still reports success, exactly as
 * clip.c always did; the truncation happens inside SDL_SetClipboardText.
 * This is a real constraint of the one-slot design (todos/0090), not a
 * defect to repair here. A binary-safe clipboard needs a second format on
 * the slot (the fileops.h FO_CLIP_FMT precedent), which is out of scope.
 *
 * Both operations return a PROCESS EXIT STATUS and report their own cause
 * to stderr first, so a front-end's main() is `return clipio_...(...)`.
 * `prog` names the caller in those diagnostics (argv[0] is not used — the
 * programs want their manifest names, not a path).
 */
#ifndef CLIPIO_H
#define CLIPIO_H

#include <SDL.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

/* Read fd to EOF, then make those bytes the clipboard slot.
 * Returns 0 on success, 1 after reporting a read/allocation/SDL failure. */
static int clipio_set_from_fd(int fd, const char *prog) {
    size_t cap = 65536, n = 0;
    char *buf = malloc(cap);
    if (!buf) { perror(prog); return 1; }
    for (;;) {
        if (n + 1 >= cap) {
            cap *= 2;
            char *nb = realloc(buf, cap);
            if (!nb) { perror(prog); free(buf); return 1; }
            buf = nb;
        }
        ssize_t r = read(fd, buf + n, cap - n - 1);
        if (r < 0) { perror(prog); free(buf); return 1; }
        if (r == 0) break;
        n += (size_t)r;
    }
    buf[n] = 0;
    int ok = SDL_SetClipboardText(buf) ? 1 : 0;
    free(buf);
    if (!ok) {
        fprintf(stderr, "%s: %s\n", prog, SDL_GetError());
        return 1;
    }
    return 0;
}

/* Write the clipboard slot to out, with no trailing newline added.
 * Returns 0, or 1 when the slot is empty — and then prints NOTHING, so
 * `pbpaste || echo empty` is a usable test. */
static int clipio_get_to_file(FILE *out) {
    char *t = SDL_GetClipboardText();
    if (!t || !t[0]) { SDL_free(t); return 1; }
    fputs(t, out);
    SDL_free(t);
    return 0;
}

#endif /* CLIPIO_H */
