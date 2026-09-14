/* #789 real compiled SDL/User32 lifecycle assertions. No manual input claimed. */
#include <windows.h>
#include <SDL3/SDL.h>
#include <SDL_popup.h>
#include <stdio.h>
static int failures, notifications, destroyed;
static void check(const char *name, int ok) { printf("%s %s\n", ok ? "ok" : "FAIL", name); if (!ok) failures++; }
/* Effective visibility settles asynchronously: with /bin/wm subscribed a new
 * surface stays unmapped until the WM's placement ack (map-on-placement,
 * todos/0069; 200 ms backstop). Wait on the authoritative query, never nap. */
static int settle_viewable(SDL_Window *w, int want) {
    for (int i = 0; i < 300; i++) { if (guc_window_viewable(w) == want) return 1; SDL_PumpEvents(); SDL_Delay(10); }
    return 0;
}
static LRESULT proc(HWND h, UINT m, WPARAM w, LPARAM l) {
    if (m == WM_SHOWWINDOW) notifications++;
    if (m == WM_DESTROY) destroyed++;
    return DefWindowProc(h,m,w,l);
}
int main(void) {
    WNDCLASS wc = {0}; wc.lpfnWndProc=proc; wc.lpszClassName="LifeProbe";
    RegisterClass(&wc);
    HWND a=CreateWindow("LifeProbe","Lifecycle controller",WS_OVERLAPPEDWINDOW|WS_VISIBLE,0,0,260,160,NULL,NULL,NULL,NULL);
    HWND b=CreateWindow("LifeProbe","Lifecycle hidden",WS_OVERLAPPEDWINDOW,0,0,220,140,NULL,NULL,NULL,NULL);
    check("hidden top-level creation",a && b && !IsWindowVisible(b));
    check("hidden style clear",!(GetWindowLongPtr(b,GWL_STYLE)&WS_VISIBLE));
    check("show returns previous hidden",!ShowWindow(b,SW_SHOWNA));
    check("shown top-level",IsWindowVisible(b) && (GetWindowLongPtr(b,GWL_STYLE)&WS_VISIBLE));
    int before=notifications;
    check("duplicate show returns previous visible",ShowWindow(b,SW_SHOWNA));
    check("duplicate show does not notify",notifications==before);
    SetCapture(b);
    check("hide returns previous visible",ShowWindow(b,SW_HIDE));
    check("hide releases capture",!GetCapture());
    check("hide preserves HWND and clears visible style",IsWindow(b) && !IsWindowVisible(b) && !(GetWindowLongPtr(b,GWL_STYLE)&WS_VISIBLE));
    check("duplicate hide returns hidden",!ShowWindow(b,SW_HIDE));
    check("show again reuses HWND",!ShowWindow(b,SW_SHOWNOACTIVATE) && IsWindowVisible(b));
    WINDOWPLACEMENT wp={0}; wp.length=sizeof wp;
    GetWindowRect(b,&wp.rcNormalPosition);
    ShowWindow(b,SW_HIDE); wp.showCmd=SW_SHOWNA;
    check("placement unchanged geometry shows hidden top",SetWindowPlacement(b,&wp) && IsWindowVisible(b));
    wp.showCmd=SW_HIDE;
    check("placement hides top",SetWindowPlacement(b,&wp) && !IsWindowVisible(b));
    wp.showCmd=SW_SHOWNORMAL;
    check("placement restores hidden top",SetWindowPlacement(b,&wp) && IsWindowVisible(b));
    DestroyWindow(b); DestroyWindow(a);
    /* #794 owned top-levels through the Win32 adapter (Win32-visible facts). */
    HWND o=CreateWindow("LifeProbe","Owner",WS_OVERLAPPEDWINDOW|WS_VISIBLE,0,0,240,150,NULL,NULL,NULL,NULL);
    HWND d=CreateWindow("LifeProbe","Owned dialog",WS_POPUP|WS_VISIBLE,0,0,180,100,o,NULL,NULL,NULL);
    HWND d2=CreateWindow("LifeProbe","Owned of owned",WS_POPUP|WS_VISIBLE,0,0,120,80,d,NULL,NULL,NULL);
    check("owned creation succeeds",o && d && d2);
    check("GetParent of an owned top-level is its owner",GetParent(d)==o && GetParent(d2)==d && GetParent(o)==NULL);
    check("GetWindow(GW_OWNER)",GetWindow(d,GW_OWNER)==o && GetWindow(o,GW_OWNER)==NULL);
    check("owner hide preserves the owned window's requested state",ShowWindow(o,SW_HIDE) && IsWindowVisible(d) && (GetWindowLongPtr(d,GWL_STYLE)&WS_VISIBLE));
    check("owner shows again",!ShowWindow(o,SW_SHOWNA) && IsWindowVisible(o));
    destroyed=0;
    DestroyWindow(o);
    check("DestroyWindow(owner) cascades to owned and owned-of-owned",destroyed==3 && !IsWindow(d) && !IsWindow(d2) && !IsWindow(o));
    /* #794 through the SDL adapter: the same relation, plus effective visibility. */
    SDL_Window *so=SDL_CreateWindow("SDL owner",120,80,0), *sd=SDL_CreateWindow("SDL owned",100,60,0);
    check("SDL_SetWindowParent links an owner",so && sd && SDL_SetWindowParent(sd,so) && SDL_GetWindowParent(sd)==so);
    check("cycle refused",!SDL_SetWindowParent(so,sd));
    check("self refused",!SDL_SetWindowParent(sd,sd));
    check("both viewable before the owner hides",settle_viewable(so,1) && settle_viewable(sd,1));
    check("hiding the owner suppresses the owned window's effective visibility",SDL_HideWindow(so) && guc_window_viewable(sd)==0 && !(SDL_GetWindowFlags(sd)&SDL_WINDOW_HIDDEN));
    check("owned activation refused under a hidden owner",!SDL_RaiseWindow(sd));
    check("showing the owner restores it",SDL_ShowWindow(so) && settle_viewable(sd,1));
    SDL_Window *pp=SDL_CreatePopupWindow(sd,2,2,40,20,SDL_WINDOW_POPUP_MENU);
    check("a popup's parent is fixed",pp && !SDL_SetWindowParent(pp,so) && !SDL_SetWindowParent(so,pp));
    check("no close event yet: reason 0",guc_window_close_reason(pp)==GUC_CLOSE_REASON_REQUEST);
    SDL_WindowID idd=SDL_GetWindowID(sd), idp=SDL_GetWindowID(pp);
    SDL_DestroyWindow(so);
    check("SDL_DestroyWindow(owner) destroys the owned window and its popup",!SDL_GetWindowFromID(idd) && !SDL_GetWindowFromID(idp));
    SDL_Window *s=SDL_CreateWindow("SDL hidden probe",120,80,SDL_WINDOW_HIDDEN);
    check("SDL hidden flag",s && (SDL_GetWindowFlags(s)&SDL_WINDOW_HIDDEN));
    SDL_Surface *pixels=SDL_GetWindowSurface(s);
    check("SDL show",SDL_ShowWindow(s) && !(SDL_GetWindowFlags(s)&SDL_WINDOW_HIDDEN));
    check("SDL hide retains surface",SDL_HideWindow(s) && SDL_GetWindowSurface(s)==pixels && (SDL_GetWindowFlags(s)&SDL_WINDOW_HIDDEN));
    check("hidden activation refused",!SDL_RaiseWindow(s));
    check("invalid show refused",!SDL_ShowWindow(NULL));
    SDL_DestroyWindow(s); SDL_Quit();
    printf("LIFECYCLE-DONE failures=%d\n",failures);
    return failures ? 1 : 0;
}
