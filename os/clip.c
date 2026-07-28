/* clip.c — the shell's clipboard bridge (todos/0090): Windows' clip.exe
 * shape plus a read flag.
 *
 *   cmd | clip        stdin -> the system clipboard
 *   clip -o           clipboard -> stdout (exit 1 if empty)
 *
 * The two operations live in os/clipio.h (todos/0397), shared verbatim
 * with /bin/pbcopy and /bin/pbpaste — the macOS-named front-ends onto the
 * same one kernel slot. The contract here is unchanged; see clipio.h for
 * the slot's semantics and its text-only limit.
 */
#include "clipio.h"

int main(int argc, char **argv) {
    if (argc > 1 && strcmp(argv[1], "-o") == 0) return clipio_get_to_file(stdout);
    if (argc > 1) {
        fprintf(stderr, "usage: cmd | clip   (stdin -> clipboard)\n"
                        "       clip -o      (clipboard -> stdout)\n");
        return 2;
    }
    return clipio_set_from_fd(0, "clip");
}
