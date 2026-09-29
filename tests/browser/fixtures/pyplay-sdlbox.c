/* pyplay transport fixture: a CLASSIC blocking SDL loop — the shape a Python
 * game loop has once pygame drives SDL — presenting through the window
 * surface (shm mailbox), sleeping in SDL_Delay, reading key/mouse/quit
 * events. Built by tests/browser/os-pyplay.mjs with this repo's compiler and
 * dropped into the page as a .wasm entry.
 *
 * Protocol (stdout, one line each):
 *   READY               first frame presented
 *   FRAME <n>           every 30 frames
 *   KEY <scancode> <sym> on key down; also cycles the fill colour
 *   CLICK <button> <x> <y>
 *   QUIT                on the close request; exits 0
 * Fill colours cycle red -> green -> blue (RGBA32 bytes). */
#include <SDL.h>
#include <stdio.h>

static void fill(SDL_Surface *s, int c) {
  static const unsigned char rgb[3][3] = { { 255, 0, 0 }, { 0, 255, 0 }, { 0, 0, 255 } };
  unsigned char *row = (unsigned char *)s->pixels;
  for (int y = 0; y < s->h; y++, row += s->pitch) {
    for (int x = 0; x < s->w; x++) {
      row[x * 4 + 0] = rgb[c][0]; row[x * 4 + 1] = rgb[c][1];
      row[x * 4 + 2] = rgb[c][2]; row[x * 4 + 3] = 255;
    }
  }
}

int main(int argc, char **argv) {
  if (!SDL_Init(SDL_INIT_VIDEO)) { fprintf(stderr, "SDL_Init: %s\n", SDL_GetError()); return 1; }
  SDL_Window *w = SDL_CreateWindow("sdlbox", 320, 200, 0);
  if (!w) { fprintf(stderr, "SDL_CreateWindow: %s\n", SDL_GetError()); return 1; }
  SDL_Surface *s = SDL_GetWindowSurface(w);
  if (!s) { fprintf(stderr, "SDL_GetWindowSurface: %s\n", SDL_GetError()); return 1; }
  int color = 0, frames = 0, running = 1;
  while (running) {
    SDL_Event e;
    while (SDL_PollEvent(&e)) {
      if (e.type == SDL_EVENT_QUIT || e.type == SDL_EVENT_WINDOW_CLOSE_REQUESTED) {
        printf("QUIT\n"); running = 0;
      } else if (e.type == SDL_EVENT_KEY_DOWN) {
        printf("KEY %d %d\n", (int)e.key.scancode, (int)e.key.key);
        color = (color + 1) % 3;
      } else if (e.type == SDL_EVENT_MOUSE_BUTTON_DOWN) {
        printf("CLICK %d %d %d\n", (int)e.button.button, (int)e.button.x, (int)e.button.y);
      }
    }
    fill(s, color);
    SDL_UpdateWindowSurface(w);
    if (frames == 0) printf("READY\n");
    if (++frames % 30 == 0) printf("FRAME %d\n", frames);
    fflush(stdout);
    SDL_Delay(16);
  }
  SDL_DestroyWindow(w);
  SDL_Quit();
  return 0;
}
