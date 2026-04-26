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

#define WINDOW_SCALE 2

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
    if (e.type == SDL_QUIT)
    {
      puts("Quit requested");
      atexit(SDL_Quit);
      exit(1);
    }

    if (e.type == SDL_KEYDOWN)
    {
      addKeyToQueue(1, e.key.keysym.sym);
    }
    else if (e.type == SDL_KEYUP)
    {
      addKeyToQueue(0, e.key.keysym.sym);
    }
  }
}


void DG_Init()
{
  window = SDL_CreateWindow("DOOM",
                            SDL_WINDOWPOS_UNDEFINED,
                            SDL_WINDOWPOS_UNDEFINED,
                            DOOMGENERIC_RESX * WINDOW_SCALE,
                            DOOMGENERIC_RESY * WINDOW_SCALE,
                            SDL_WINDOW_SHOWN
                            );

  surface = SDL_GetWindowSurface(window);
}

void DG_DrawFrame()
{
  unsigned char *dst = (unsigned char *)surface->pixels;
  int win_w = DOOMGENERIC_RESX * WINDOW_SCALE;
  for (int sy = 0; sy < DOOMGENERIC_RESY; sy++) {
    for (int sx = 0; sx < DOOMGENERIC_RESX; sx++) {
      unsigned int px = DG_ScreenBuffer[sy * DOOMGENERIC_RESX + sx];
      unsigned char r = (px >> 16) & 0xFF;
      unsigned char g = (px >> 8)  & 0xFF;
      unsigned char b =  px        & 0xFF;
      for (int dy = 0; dy < WINDOW_SCALE; dy++) {
        for (int dx = 0; dx < WINDOW_SCALE; dx++) {
          int di = (sy * WINDOW_SCALE + dy) * win_w + (sx * WINDOW_SCALE + dx);
          dst[di * 4 + 0] = r;
          dst[di * 4 + 1] = g;
          dst[di * 4 + 2] = b;
          dst[di * 4 + 3] = 255;
        }
      }
    }
  }
  SDL_UpdateWindowSurface(window);

  handleKeyInput();
}

void DG_SleepMs(uint32_t ms)
{
  SDL_Delay(ms);
}

uint32_t DG_GetTicksMs()
{
  return SDL_GetTicks();
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
