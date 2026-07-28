/* pbpaste.c — the system clipboard -> stdout, the macOS name (todos/0397).
 *
 *   pbpaste           (exit 1, and prints nothing, when the slot is empty)
 *
 * The same one kernel clipboard slot /bin/clip reads (todos/0090), so
 * pbpaste really sees what a win32 app copied with Ctrl+C, what term
 * copied with Ctrl+Shift+C, and what the user copied on the HOST browser
 * (the clipboard seam refreshes the slot on the read). The operation
 * itself is os/clipio.h, shared verbatim with clip and pbcopy; see that
 * header for the slot's text-only limit (a NUL ends the payload).
 *
 * No trailing newline is added — the slot goes out byte for byte, as
 * `clip -o` has always done.
 *
 * pbpaste takes NO arguments. macOS's -pboard and -Prefer are out of
 * scope: this platform has ONE slot, and one text format on it. Argv is
 * refused loudly rather than ignored.
 */
#include "clipio.h"

int main(int argc, char **argv) {
    (void)argv;
    if (argc > 1) {
        fprintf(stderr, "usage: pbpaste   (clipboard -> stdout)\n"
                        "pbpaste takes no arguments; -pboard is unsupported "
                        "(this system has one clipboard slot).\n");
        return 2;
    }
    return clipio_get_to_file(stdout);
}
