/* #789 installed browser fixture. SDL CPU/WebGPU use identical lifecycle.
   #794 adds the owner relation (SDL_SetWindowParent), effective visibility
   (guc_window_viewable) and the close-reason query (guc_window_close_reason). */
#define SDL_MAIN_USE_CALLBACKS
#include <SDL3/SDL.h>
#include <SDL_popup.h>
#include <stdio.h>
#include <string.h>
static SDL_Window *control,*target,*popup,*helper;
static SDL_Renderer *cr,*tr,*pr,*hr;
static const char *driver;
static int lastFocus=-1, lastViewable=-1, initialized;
SDL_AppResult SDL_AppInit(void **state,int argc,char **argv) {
    driver=argc>1 && !strcmp(argv[1],"software")?"software":"gucos";
    SDL_Init(SDL_INIT_VIDEO);
    /* The helper is an ordinary unowned window that stays visible throughout:
       when the owner group hides (#794) keyboard focus falls to it, so the
       test's keystrokes keep reaching this process. */
    helper=SDL_CreateWindow("UI lifecycle helper",120,60,0);
    control=SDL_CreateWindow("UI lifecycle control",280,160,0);
    target=SDL_CreateWindow("UI lifecycle target",220,130,SDL_WINDOW_HIDDEN);
    if(!helper||!control||!target) return SDL_APP_FAILURE;
    hr=SDL_CreateRenderer(helper,driver); cr=SDL_CreateRenderer(control,driver); tr=SDL_CreateRenderer(target,driver);
    if(!hr||!cr||!tr) return SDL_APP_FAILURE;
    printf("RENDER-DRIVER %s\n",driver); fflush(stdout);
    return SDL_APP_CONTINUE;
}
SDL_AppResult SDL_AppEvent(void *state,SDL_Event *e) {
    if(e->type==SDL_EVENT_QUIT) return SDL_APP_SUCCESS;
    if(e->type==SDL_EVENT_WINDOW_CLOSE_REQUESTED) {
        /* #794: the same SDL close event carries a gucOS reason. A popup
           dismissal is housekeeping (destroy the popup); a close request on
           the target is VETOED here — the app keeps pumping, so the kernel's
           hung-app watchdog must leave it alive. */
        SDL_Window *w=SDL_GetWindowFromID(e->window.windowID);
        int reason=w?guc_window_close_reason(w):-1;
        printf("CLOSE-REASON %d %s\n",reason,w==popup?"popup":w==target?"target":"other"); fflush(stdout);
        if(w==popup) { SDL_DestroyRenderer(pr); SDL_DestroyWindow(popup); popup=NULL; pr=NULL; }
        return SDL_APP_CONTINUE;
    }
    if(e->type==SDL_EVENT_WINDOW_FOCUS_GAINED) {   /* diagnostic: which window holds the keyboard */
        SDL_Window *w=SDL_GetWindowFromID(e->window.windowID);
        printf("FOCUS-GAINED %s\n",w==helper?"helper":w==control?"control":w==target?"target":w==popup?"popup":"other"); fflush(stdout);
    }
    if(e->type==SDL_EVENT_KEY_DOWN) {
        int k=e->key.key, ok=1;
        printf("KEY %c\n",(k>=32&&k<127)?(char)k:'?'); fflush(stdout);   /* diagnostic: the key reached the process */
        if(k=='s') ok=SDL_ShowWindow(target);
        else if(k=='h') ok=SDL_HideWindow(target);
        else if(k=='a') ok=SDL_RaiseWindow(target);
        else if(k=='o') ok=SDL_SetWindowParent(target,control);
        else if(k=='c') ok=SDL_HideWindow(control);
        else if(k=='v') ok=SDL_ShowWindow(control);
        else if(k=='p') {
            popup=SDL_CreatePopupWindow(target,12,12,80,40,SDL_WINDOW_POPUP_MENU);
            pr=popup?SDL_CreateRenderer(popup,driver):NULL;
            ok=popup&&pr;
        }
        else if(k=='q') return SDL_APP_SUCCESS;
        else return SDL_APP_CONTINUE;
        printf("ACTION %c %d\n",k,ok); fflush(stdout);
    }
    return SDL_APP_CONTINUE;
}
SDL_AppResult SDL_AppIterate(void *state) {
    SDL_SetRenderDrawColor(hr,90,90,90,255); SDL_RenderClear(hr); SDL_RenderPresent(hr);
    SDL_SetRenderDrawColor(cr,32,100,180,255); SDL_RenderClear(cr); SDL_RenderPresent(cr);
    SDL_SetRenderDrawColor(tr,211,31,171,255); SDL_RenderClear(tr); SDL_RenderPresent(tr);
    if(popup) { SDL_SetRenderDrawColor(pr,240,220,20,255); SDL_RenderClear(pr); SDL_RenderPresent(pr); }
    int focus=(SDL_GetWindowFlags(target)&SDL_WINDOW_INPUT_FOCUS)!=0;
    if(focus!=lastFocus) {printf("TARGET-FOCUS %d\n",focus);fflush(stdout);lastFocus=focus;}
    int viewable=guc_window_viewable(target);
    if(viewable!=lastViewable) {printf("TARGET-VIEWABLE %d hidden=%d\n",viewable,(SDL_GetWindowFlags(target)&SDL_WINDOW_HIDDEN)!=0);fflush(stdout);lastViewable=viewable;}
    if(!initialized) {printf("UI-LIFECYCLE-READY\n");fflush(stdout);initialized=1;}
    return SDL_APP_CONTINUE;
}
void SDL_AppQuit(void *state,SDL_AppResult result) {
    if(pr)SDL_DestroyRenderer(pr);
    SDL_DestroyRenderer(tr);SDL_DestroyRenderer(cr);SDL_DestroyRenderer(hr);
    /* Destroying the owner destroys the owned target (and any popup) with it (#794). */
    SDL_DestroyWindow(control);
    printf("OWNER-CASCADE %d\n",SDL_GetWindowFromID(SDL_GetWindowID(target))==NULL?1:0); fflush(stdout);
    SDL_DestroyWindow(helper);
    SDL_Quit();
    printf("UI-LIFECYCLE-EXIT\n");fflush(stdout);
}
