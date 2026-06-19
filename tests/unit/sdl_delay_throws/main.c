/* SDL_Delay cannot be honoured without JSPI (a blocking sleep can't yield to the
   browser), so it ALWAYS throws — fail loud rather than silently do nothing.
   The "before delay" line prints; "after delay" is never reached (the throw
   unwinds out of main, exiting non-zero). stderr carries the guidance message +
   a stack trace, so this test pins only stdout + the exit code. */
#include <SDL.h>
#include <stdio.h>

int main(void) {
    printf("before delay\n");
    SDL_Delay(10);
    printf("after delay\n");
    return 0;
}
