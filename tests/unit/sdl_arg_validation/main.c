/* #497: the veneer must not report success on invalid arguments — these are the
   outputs of ordinary game bugs (a 0x0 atlas from a failed config parse, a
   stale index-buffer count, a use-after-destroy), and "success" buries the
   failure far from the call that was wrong. Covers the ticket's table:
   degenerate/huge texture dims, unknown renderer driver name, a second
   renderer on a window, NULL audio buf, out-of-range geometry indices, and
   use of a destroyed window/texture (incl. double-destroy). Positive controls
   throughout: the valid twin of each case still succeeds. */
#include <SDL.h>
#include <stdio.h>
#include <string.h>

int main(void) {
    SDL_Init(SDL_INIT_VIDEO | SDL_INIT_AUDIO);
    SDL_Window *w = SDL_CreateWindow("t", 64, 48, 0);
    SDL_Window *w2 = SDL_CreateWindow("t2", 64, 48, 0);
    printf("windows: %d\n", w != NULL && w2 != NULL);
    SDL_Renderer *r = SDL_CreateRenderer(w, NULL);
    printf("renderer: %d\n", r != NULL);

    /* -- texture dimensions -- */
    SDL_ClearError();
    SDL_Texture *t0 = SDL_CreateTexture(r, SDL_PIXELFORMAT_RGBA32, SDL_TEXTUREACCESS_STATIC, 0, 0);
    printf("tex 0x0 rejected: %d err: %d\n", t0 == NULL, SDL_GetError()[0] != '\0');
    SDL_Texture *tn = SDL_CreateTexture(r, SDL_PIXELFORMAT_RGBA32, SDL_TEXTUREACCESS_STATIC, -8, -8);
    printf("tex neg rejected: %d\n", tn == NULL);
    SDL_ClearError();
    SDL_Texture *th = SDL_CreateTexture(r, SDL_PIXELFORMAT_RGBA32, SDL_TEXTUREACCESS_STATIC, 100000, 100000);
    printf("tex huge rejected: %d err: %d\n", th == NULL, SDL_GetError()[0] != '\0');
    SDL_Texture *tok = SDL_CreateTexture(r, SDL_PIXELFORMAT_RGBA32, SDL_TEXTUREACCESS_STATIC, 64, 64);
    printf("tex 64x64 ok: %d\n", tok != NULL);

    /* -- renderer driver name + one-renderer-per-window -- */
    SDL_ClearError();
    SDL_Renderer *ru = SDL_CreateRenderer(w2, "opengl");
    printf("unknown driver rejected: %d msg: %d\n", ru == NULL,
           strcmp(SDL_GetError(), "Couldn't find matching render driver") == 0);
    SDL_ClearError();
    SDL_Renderer *r2 = SDL_CreateRenderer(w, "gucos");
    printf("second renderer rejected: %d msg: %d\n", r2 == NULL,
           strcmp(SDL_GetError(), "Renderer already associated with window") == 0);
    SDL_Renderer *rg = SDL_CreateRenderer(w2, "gucos");
    printf("named driver ok: %d\n", rg != NULL);
    /* destroying the renderer frees the window's slot again */
    SDL_DestroyRenderer(rg);
    rg = SDL_CreateRenderer(w2, NULL);
    printf("recreate after destroy ok: %d\n", rg != NULL);

    /* -- RenderGeometry index bounds -- */
    SDL_Vertex v[3];
    memset(v, 0, sizeof v);
    int idx_bad[3] = {0, 1, 99};
    int idx_neg[3] = {0, 1, -1};
    int idx_ok[3] = {0, 1, 2};
    SDL_ClearError();
    printf("oob index rejected: %d err: %d\n",
           SDL_RenderGeometry(r, NULL, v, 3, idx_bad, 3) == 0, SDL_GetError()[0] != '\0');
    printf("neg index rejected: %d\n", SDL_RenderGeometry(r, NULL, v, 3, idx_neg, 3) == 0);
    printf("good indices ok: %d\n", SDL_RenderGeometry(r, NULL, v, 3, idx_ok, 3) == 1);

    /* -- NULL audio buf -- */
    SDL_AudioSpec spec;
    spec.format = SDL_AUDIO_S16;
    spec.channels = 2;
    spec.freq = 48000;
    SDL_AudioStream *au = SDL_OpenAudioDeviceStream(0, &spec, NULL, NULL);
    printf("audio stream: %d\n", au != NULL);
    SDL_ClearError();
    printf("null buf rejected: %d msg: %d\n", SDL_PutAudioStreamData(au, NULL, 100) == 0,
           strcmp(SDL_GetError(), "Parameter 'buf' is invalid") == 0);
    short samples[8] = {0};
    printf("real buf ok: %d\n", SDL_PutAudioStreamData(au, samples, sizeof samples) == 1);

    /* -- destroyed texture use -- */
    SDL_DestroyTexture(tok);
    SDL_ClearError();
    printf("dead tex mod rejected: %d err: %d\n",
           SDL_SetTextureColorMod(tok, 1, 2, 3) == 0, SDL_GetError()[0] != '\0');
    SDL_ClearError();
    printf("dead tex render rejected: %d\n", SDL_RenderTexture(r, tok, NULL, NULL) == 0);
    SDL_ClearError();
    SDL_DestroyTexture(tok);   /* double-destroy: error, not double-free */
    printf("tex double destroy loud: %d\n", SDL_GetError()[0] != '\0');

    /* -- destroyed window use -- */
    SDL_DestroyRenderer(rg);
    SDL_DestroyWindow(w2);
    SDL_ClearError();
    printf("dead window title rejected: %d err: %d\n",
           SDL_SetWindowTitle(w2, "x") == 0, SDL_GetError()[0] != '\0');
    SDL_ClearError();
    printf("dead window surface rejected: %d\n", SDL_GetWindowSurface(w2) == NULL);
    SDL_ClearError();
    SDL_DestroyWindow(w2);     /* double-destroy: error, not double-free */
    printf("window double destroy loud: %d\n", SDL_GetError()[0] != '\0');

    /* live window still fine after all of the above */
    printf("live window title ok: %d\n", SDL_SetWindowTitle(w, "still here") == 1);

    /* -- #711: destroyed RENDERER use (the #497 residue) -- the ticket's
       mode-1 table: every one of these reported success with an empty
       SDL_GetError() on a dangling renderer. Positive control first. */
    printf("live renderer clear ok: %d\n", SDL_RenderClear(r) == 1);
    SDL_DestroyRenderer(r);
    SDL_ClearError();
    printf("dead rdr fillrect rejected: %d err: %d\n",
           SDL_RenderFillRect(r, NULL) == 0, SDL_GetError()[0] != '\0');
    printf("dead rdr clear rejected: %d\n", SDL_RenderClear(r) == 0);
    printf("dead rdr drawcolor rejected: %d\n", SDL_SetRenderDrawColor(r, 1, 2, 3, 4) == 0);
    printf("dead rdr line rejected: %d\n", SDL_RenderLine(r, 0, 0, 8, 8) == 0);
    printf("dead rdr debugtext rejected: %d\n", SDL_RenderDebugText(r, 0, 0, "x") == 0);
    printf("dead rdr present rejected: %d\n", SDL_RenderPresent(r) == 0);
    printf("dead rdr createtex rejected: %d\n",
           SDL_CreateTexture(r, SDL_PIXELFORMAT_RGBA32, SDL_TEXTUREACCESS_STATIC, 8, 8) == NULL);
    printf("dead rdr settarget rejected: %d\n", SDL_SetRenderTarget(r, NULL) == 0);
    printf("dead rdr setvsync rejected: %d\n", SDL_SetRenderVSync(r, 0) == 0);
    SDL_ClearError();
    SDL_DestroyRenderer(r);    /* double-destroy: error, not double-free */
    printf("rdr double destroy loud: %d\n", SDL_GetError()[0] != '\0');

    /* -- #711 mode 3: destroyed WINDOW, renderer left alive -- upstream
       destroys the renderer with its window; here the dangling backref must
       read as a dead renderer, not keep succeeding at a freed surface. */
    SDL_Renderer *r3 = SDL_CreateRenderer(w, NULL);
    printf("renderer on live window ok: %d\n", r3 != NULL);
    SDL_DestroyWindow(w);
    SDL_ClearError();
    printf("dead window rdr fillrect rejected: %d err: %d\n",
           SDL_RenderFillRect(r3, NULL) == 0, SDL_GetError()[0] != '\0');
    printf("dead window rdr present rejected: %d\n", SDL_RenderPresent(r3) == 0);
    /* teardown after the window is still a working reclaim, silently */
    SDL_ClearError();
    SDL_DestroyRenderer(r3);
    printf("rdr destroy after window ok: %d\n", SDL_GetError()[0] == '\0');
    return 0;
}
