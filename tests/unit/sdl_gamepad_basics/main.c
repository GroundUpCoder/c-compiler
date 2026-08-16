/* SDL gamepad object model (#607), no-device environment: the API is fully
   live with an empty registry (this runtime's null/headless flavor has no
   pad source), pre-init calls fail loud, list/open contracts hold, and the
   string<->enum tables are upstream's. Event delivery and hotplug ride the
   OS input ring and are covered by tests/kernel/test_gamepad_e2e.js. */
#include <SDL.h>
#include <stdio.h>
#include <string.h>

int main(void) {
    /* Pre-init: loud failure, not a quiet empty answer. */
    int cnt = -1;
    SDL_JoystickID *ids = SDL_GetGamepads(&cnt);
    printf("preinit_list=%d cnt=%d err_nonempty=%d\n",
           ids == NULL, cnt, SDL_GetError()[0] != '\0');
    printf("preinit_has=%d\n", (int)SDL_HasGamepad());

    printf("init=%d\n", (int)SDL_Init(SDL_INIT_GAMEPAD));
    /* GAMEPAD implies EVENTS (the VIDEO/AUDIO rule). */
    printf("wasinit=%d events=%d\n",
           SDL_WasInit(SDL_INIT_GAMEPAD) != 0, SDL_WasInit(SDL_INIT_EVENTS) != 0);

    /* Empty registry: a real, 0-terminated, SDL_free-able empty list. */
    cnt = -1;
    ids = SDL_GetGamepads(&cnt);
    printf("list=%d cnt=%d zterm=%d\n", ids != NULL, cnt, ids && ids[0] == 0);
    SDL_free(ids);
    printf("has=%d is=%d\n", (int)SDL_HasGamepad(), (int)SDL_IsGamepad(1));

    /* Open of a nonexistent instance id fails loud. */
    SDL_ClearError();
    SDL_Gamepad *g = SDL_OpenGamepad(42);
    printf("open=%d err_nonempty=%d\n", g == NULL, SDL_GetError()[0] != '\0');
    printf("fromid=%d\n", SDL_GetGamepadFromID(42) == NULL);

    /* String tables: upstream SDL3 vocabulary, both directions. */
    printf("btn_a=[%s] btn_dpup=[%s] btn_misc6=[%s]\n",
           SDL_GetGamepadStringForButton(SDL_GAMEPAD_BUTTON_SOUTH),
           SDL_GetGamepadStringForButton(SDL_GAMEPAD_BUTTON_DPAD_UP),
           SDL_GetGamepadStringForButton(SDL_GAMEPAD_BUTTON_MISC6));
    printf("btn_bad=%d\n", SDL_GetGamepadStringForButton(SDL_GAMEPAD_BUTTON_COUNT) == NULL);
    printf("from_a=%d from_B=%d from_junk=%d\n",
           (int)SDL_GetGamepadButtonFromString("a"),
           (int)SDL_GetGamepadButtonFromString("B"),   /* case-insensitive */
           (int)SDL_GetGamepadButtonFromString("warp"));
    printf("ax_lx=[%s] ax_rt=[%s] from_lefty=%d from_junk=%d\n",
           SDL_GetGamepadStringForAxis(SDL_GAMEPAD_AXIS_LEFTX),
           SDL_GetGamepadStringForAxis(SDL_GAMEPAD_AXIS_RIGHT_TRIGGER),
           (int)SDL_GetGamepadAxisFromString("lefty"),
           (int)SDL_GetGamepadAxisFromString("z"));

    /* Event-enable toggle round-trips (default on). */
    printf("ev_default=%d\n", (int)SDL_GamepadEventsEnabled());
    SDL_SetGamepadEventsEnabled(0);
    printf("ev_off=%d\n", (int)SDL_GamepadEventsEnabled());
    SDL_SetGamepadEventsEnabled(1);

    /* Enum values are upstream SDL3, pinned. */
    printf("enums=%d %d %d %d %d\n",
           (int)SDL_GAMEPAD_BUTTON_COUNT, (int)SDL_GAMEPAD_AXIS_COUNT,
           SDL_EVENT_GAMEPAD_AXIS_MOTION, SDL_EVENT_GAMEPAD_ADDED,
           SDL_EVENT_GAMEPAD_REMOVED);

    SDL_Quit();
    return 0;
}
