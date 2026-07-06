/* main.c — the standalone entry point. In a multicall busybox, appletlib's
 * main() dispatches on argv[0]; here hush IS the binary (/bin/sh). */
#define PV_NO_INTERCEPT 1
#include "libbb.h"

int hush_main(int argc, char **argv) MAIN_EXTERNALLY_VISIBLE;

int main(int argc, char **argv)
{
    return hush_main(argc, argv);
}
