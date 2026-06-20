/* SDL3 conformance: NULL/invalid-argument handling.
   - Every object-taking entry point validates its handle and sets the SDL error
     to SDL's exact wording ("Parameter 'X' is invalid") instead of crashing.
   - SDL_PollEvent(NULL) PEEKS: returns true if an event is queued but does NOT
     remove it (and never dereferences the NULL pointer). */
#include <SDL.h>
#include <stdio.h>

/* Internal producer (defined in __SDL.c, exported to the host). Declared here so
   the test can queue an event without a DOM. */
extern void __sdl_push_quit_event(int window_id);

int main(void) {
    /* NULL handles → false + SDL-worded error, no crash. */
    SDL_ClearError();
    printf("renderclear=%d err=[%s]\n", (int)SDL_RenderClear(NULL), SDL_GetError());
    SDL_ClearError();
    printf("texblend=%d err=[%s]\n", (int)SDL_SetTextureBlendMode(NULL, SDL_BLENDMODE_BLEND), SDL_GetError());
    SDL_ClearError();
    printf("putaudio=%d err=[%s]\n", (int)SDL_PutAudioStreamData(NULL, "x", 1), SDL_GetError());
    SDL_ClearError();
    printf("settitle=%d err=[%s]\n", (int)SDL_SetWindowTitle(NULL, "x"), SDL_GetError());
    SDL_ClearError();
    printf("getqueued=%d\n", SDL_GetAudioStreamQueued(NULL));

    /* PollEvent(NULL) on an empty queue: false, no crash. */
    printf("poll_null_empty=%d\n", (int)SDL_PollEvent(NULL));

    /* Queue one event, then peek twice with NULL (must NOT drain), then drain. */
    __sdl_push_quit_event(1);
    printf("peek1=%d\n", (int)SDL_PollEvent(NULL));   /* true, leaves it queued */
    printf("peek2=%d\n", (int)SDL_PollEvent(NULL));   /* still true */
    SDL_Event e;
    int got = (int)SDL_PollEvent(&e);
    printf("drain=%d type_is_quit=%d\n", got, e.type == SDL_EVENT_QUIT);
    printf("poll_after_drain=%d\n", (int)SDL_PollEvent(NULL));  /* now empty → false */
    return 0;
}
