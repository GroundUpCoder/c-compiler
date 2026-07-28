/* pbcopy.c — stdin -> the system clipboard, the macOS name (todos/0397).
 *
 *   cmd | pbcopy
 *
 * The same one kernel clipboard slot /bin/clip writes (todos/0090), so
 * `echo hi | pbcopy` really pastes into notepad and `clip -o` really
 * prints it back. The operation itself is os/clipio.h, shared verbatim
 * with clip and pbpaste; see that header for the slot's text-only limit
 * (a NUL ends the payload).
 *
 * pbcopy takes NO arguments. macOS's -pboard (general/ruler/find/font)
 * and -Prefer are out of scope: this platform has ONE slot, so a board
 * selector would have nothing to select. Argv is refused loudly rather
 * than ignored — a script that asks for a board it will not get must
 * hear about it.
 */
#include "clipio.h"

int main(int argc, char **argv) {
    (void)argv;
    if (argc > 1) {
        fprintf(stderr, "usage: cmd | pbcopy   (stdin -> clipboard)\n"
                        "pbcopy takes no arguments; -pboard is unsupported "
                        "(this system has one clipboard slot).\n");
        return 2;
    }
    return clipio_set_from_fd(0, "pbcopy");
}
