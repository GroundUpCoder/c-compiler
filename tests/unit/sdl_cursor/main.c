/* SDL3 cursor API (todos/0105): system shapes only, tracked application-wide.
   - SDL_GetDefaultCursor never NULL; SDL_GetCursor starts at the default.
   - SDL_CreateSystemCursor validates the id (NULL on out-of-range).
   - SDL_SetCursor swaps the active cursor and returns true; NULL is the
     "redraw current" no-op (keeps the active cursor).
   - Show/Hide toggle SDL_CursorVisible.
   - SDL_DestroyCursor on the active cursor falls back to the default; the
     default cursor is never freed. Runs under the null backend (no display),
     so __sdl_set_cursor is a no-op and only the C bookkeeping is exercised. */
#include <SDL.h>
#include <stdio.h>

int main(void) {
    SDL_Cursor *def = SDL_GetDefaultCursor();
    printf("default_nonnull=%d\n", def != NULL);
    printf("initial_is_default=%d\n", SDL_GetCursor() == def);

    SDL_Cursor *bad = SDL_CreateSystemCursor((SDL_SystemCursor)999);
    printf("bad_id_null=%d\n", bad == NULL);

    SDL_Cursor *ibeam = SDL_CreateSystemCursor(SDL_SYSTEM_CURSOR_TEXT);
    printf("ibeam_nonnull=%d\n", ibeam != NULL);
    printf("set_ret=%d\n", (int)SDL_SetCursor(ibeam));
    printf("active_is_ibeam=%d\n", SDL_GetCursor() == ibeam);

    printf("null_set_ret=%d\n", (int)SDL_SetCursor(NULL));   /* redraw no-op */
    printf("active_still_ibeam=%d\n", SDL_GetCursor() == ibeam);

    printf("visible0=%d\n", (int)SDL_CursorVisible());
    SDL_HideCursor();
    printf("visible_hidden=%d\n", (int)SDL_CursorVisible());
    SDL_ShowCursor();
    printf("visible_shown=%d\n", (int)SDL_CursorVisible());

    SDL_DestroyCursor(ibeam);                 /* active -> falls back to default */
    printf("active_after_destroy=%d\n", SDL_GetCursor() == def);
    return 0;
}
