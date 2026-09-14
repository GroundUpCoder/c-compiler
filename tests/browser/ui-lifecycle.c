/* #789 installed browser fixture. SDL CPU/WebGPU use identical lifecycle. */
#define SDL_MAIN_USE_CALLBACKS
#include <SDL3/SDL.h>
#include <stdio.h>
#include <string.h>
static SDL_Window *control,*target;
static SDL_Renderer *cr,*tr;
static int lastFocus=-1, initialized;
SDL_AppResult SDL_AppInit(void **state,int argc,char **argv) {
    const char *driver=argc>1 && !strcmp(argv[1],"software")?"software":"gucos";
    SDL_Init(SDL_INIT_VIDEO);
    control=SDL_CreateWindow("UI lifecycle control",280,160,0);
    target=SDL_CreateWindow("UI lifecycle target",220,130,SDL_WINDOW_HIDDEN);
    if(!control||!target) return SDL_APP_FAILURE;
    cr=SDL_CreateRenderer(control,driver); tr=SDL_CreateRenderer(target,driver);
    if(!cr||!tr) return SDL_APP_FAILURE;
    printf("RENDER-DRIVER %s\n",driver); fflush(stdout);
    return SDL_APP_CONTINUE;
}
SDL_AppResult SDL_AppEvent(void *state,SDL_Event *e) {
    if(e->type==SDL_EVENT_QUIT) return SDL_APP_SUCCESS;
    if(e->type==SDL_EVENT_KEY_DOWN) {
        int k=e->key.key, ok=1;
        if(k=='s') ok=SDL_ShowWindow(target);
        else if(k=='h') ok=SDL_HideWindow(target);
        else if(k=='a') ok=SDL_RaiseWindow(target);
        else if(k=='q') return SDL_APP_SUCCESS;
        else return SDL_APP_CONTINUE;
        printf("ACTION %c %d\n",k,ok); fflush(stdout);
    }
    return SDL_APP_CONTINUE;
}
SDL_AppResult SDL_AppIterate(void *state) {
    SDL_SetRenderDrawColor(cr,32,100,180,255); SDL_RenderClear(cr); SDL_RenderPresent(cr);
    SDL_SetRenderDrawColor(tr,211,31,171,255); SDL_RenderClear(tr); SDL_RenderPresent(tr);
    int focus=(SDL_GetWindowFlags(target)&SDL_WINDOW_INPUT_FOCUS)!=0;
    if(focus!=lastFocus) {printf("TARGET-FOCUS %d\n",focus);fflush(stdout);lastFocus=focus;}
    if(!initialized) {printf("UI-LIFECYCLE-READY\n");fflush(stdout);initialized=1;}
    return SDL_APP_CONTINUE;
}
void SDL_AppQuit(void *state,SDL_AppResult result) {
    SDL_DestroyRenderer(tr);SDL_DestroyRenderer(cr);
    SDL_DestroyWindow(target);SDL_DestroyWindow(control);SDL_Quit();
    printf("UI-LIFECYCLE-EXIT\n");fflush(stdout);
}
