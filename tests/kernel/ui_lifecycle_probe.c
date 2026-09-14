/* #789 real compiled SDL/User32 lifecycle assertions. No manual input claimed. */
#include <windows.h>
#include <SDL3/SDL.h>
#include <stdio.h>
static int failures, notifications;
static void check(const char *name, int ok) { printf("%s %s\n", ok ? "ok" : "FAIL", name); if (!ok) failures++; }
static LRESULT proc(HWND h, UINT m, WPARAM w, LPARAM l) {
    if (m == WM_SHOWWINDOW) notifications++;
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
