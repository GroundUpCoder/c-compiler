//doomgeneric emscripten port

#include "doomkeys.h"
#include "m_argv.h"
#include "doomgeneric.h"

#include <stdio.h>
#include <unistd.h>

#include <ctype.h>
#include <stdbool.h>
#include <SDL.h>

#include <emscripten.h>

SDL_Window* window = NULL;
SDL_Surface* surface = NULL;

#define KEYQUEUE_SIZE 16

static unsigned short s_KeyQueue[KEYQUEUE_SIZE];
static unsigned int s_KeyQueueWriteIndex = 0;
static unsigned int s_KeyQueueReadIndex = 0;

static unsigned char convertToDoomKey(unsigned int key)
{
  switch (key)
    {
    case SDLK_RETURN:
      key = KEY_ENTER;
      break;
    case SDLK_ESCAPE:
      key = KEY_ESCAPE;
      break;
    case SDLK_BACKSPACE:
      key = KEY_BACKSPACE;
      break;
    case SDLK_DELETE:
      key = KEY_DEL;
      break;
    case SDLK_LEFT:
      key = KEY_LEFTARROW;
      break;
    case SDLK_RIGHT:
      key = KEY_RIGHTARROW;
      break;
    case SDLK_UP:
      key = KEY_UPARROW;
      break;
    case SDLK_DOWN:
      key = KEY_DOWNARROW;
      break;
    case SDLK_LCTRL:
    case SDLK_RCTRL:
      key = KEY_FIRE;
      break;
    case SDLK_SPACE:
      key = KEY_USE;
      break;
    case SDLK_LSHIFT:
    case SDLK_RSHIFT:
      key = KEY_RSHIFT;
      break;
    case SDLK_LALT:
    case SDLK_RALT:
      key = KEY_LALT;
      break;
    case SDLK_F2:
      key = KEY_F2;
      break;
    case SDLK_F3:
      key = KEY_F3;
      break;
    case SDLK_F4:
      key = KEY_F4;
      break;
    case SDLK_F5:
      key = KEY_F5;
      break;
    case SDLK_F6:
      key = KEY_F6;
      break;
    case SDLK_F7:
      key = KEY_F7;
      break;
    case SDLK_F8:
      key = KEY_F8;
      break;
    case SDLK_F9:
      key = KEY_F9;
      break;
    case SDLK_F10:
      key = KEY_F10;
      break;
    case SDLK_F11:
      key = KEY_F11;
      break;
    case SDLK_EQUALS:
    case SDLK_PLUS:
      key = KEY_EQUALS;
      break;
    case SDLK_MINUS:
      key = KEY_MINUS;
      break;
    default:
      key = tolower(key);
      break;
    }

  return key;
}

static void addKeyToQueue(int pressed, unsigned int keyCode)
{
  unsigned char key = convertToDoomKey(keyCode);

  unsigned short keyData = (pressed << 8) | key;

  s_KeyQueue[s_KeyQueueWriteIndex] = keyData;
  s_KeyQueueWriteIndex++;
  s_KeyQueueWriteIndex %= KEYQUEUE_SIZE;
}

static void handleKeyInput()
{
  SDL_Event e;
  while (SDL_PollEvent(&e))
  {
    if (e.type == SDL_EVENT_QUIT)
    {
      puts("Quit requested");
      atexit(SDL_Quit);
      exit(1);
    }

    if (e.type == SDL_EVENT_KEY_DOWN)
    {
      addKeyToQueue(1, e.key.key);
    }
    else if (e.type == SDL_EVENT_KEY_UP)
    {
      addKeyToQueue(0, e.key.key);
    }
  }
}


void DG_Init()
{
  /* Present at native 640x400 — no CPU pre-scale. The compositor scales
     fixed-size windows via the per-surface dst rect (todos/0024): drag a
     frame edge, `wmctl scale`, or maximize for scale-to-fit. */
  window = SDL_CreateWindow("DOOM",
                            DOOMGENERIC_RESX,
                            DOOMGENERIC_RESY,
                            0
                            );

  surface = SDL_GetWindowSurface(window);
}

void DG_DrawFrame()
{
  unsigned char *dst = (unsigned char *)surface->pixels;
  int n = DOOMGENERIC_RESX * DOOMGENERIC_RESY;
  for (int i = 0; i < n; i++) {
    unsigned int px = DG_ScreenBuffer[i];
    dst[i * 4 + 0] = (px >> 16) & 0xFF;
    dst[i * 4 + 1] = (px >> 8)  & 0xFF;
    dst[i * 4 + 2] =  px        & 0xFF;
    dst[i * 4 + 3] = 255;
  }
  SDL_UpdateWindowSurface(window);

  handleKeyInput();
}

void DG_SleepMs(uint32_t ms)
{
  /* No-op in the browser rAF/callback model: there is no blocking sleep here.
     main() registers doomgeneric_Tick via emscripten_set_main_loop(...,0,1) and
     returns; the host drives it via requestAnimationFrame (no JSPI). Doom's
     35Hz tics are paced by real-time I_GetTime() (SDL_GetTicks), which advances
     on its own, so the init title-melt and TryRunTics wait-loops still make
     progress without sleeping. SDL_Delay would throw without JSPI (and a
     blocking sleep can't yield to the browser anyway), so we never call it. */
  (void)ms;
}

uint32_t DG_GetTicksMs()
{
  return (uint32_t)SDL_GetTicks();
}

int DG_GetKey(int* pressed, unsigned char* doomKey)
{
  if (s_KeyQueueReadIndex == s_KeyQueueWriteIndex)
  {
    //key queue is empty
    return 0;
  }
  else
  {
    unsigned short keyData = s_KeyQueue[s_KeyQueueReadIndex];
    s_KeyQueueReadIndex++;
    s_KeyQueueReadIndex %= KEYQUEUE_SIZE;

    *pressed = keyData >> 8;
    *doomKey = keyData & 0xFF;

    return 1;
  }

  return 0;
}

void DG_SetWindowTitle(const char * title)
{
  if (window != NULL)
  {
    SDL_SetWindowTitle(window, title);
  }
}

int main(int argc, char **argv)
{
    doomgeneric_Create(argc, argv);

    emscripten_set_main_loop(doomgeneric_Tick, 0, 1);

    return 0;
}
