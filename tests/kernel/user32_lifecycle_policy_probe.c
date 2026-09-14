/* Real user32 functions, synthetic HWNDs and deterministic SDL lifecycle seam.
 * No OS boot; the e2e fixture separately exercises public creation/transport. */
static int failures, shown, hidden, raised, sized, notices;
static bool test_show(SDL_Window *w) { (void)w; shown++; return 1; }
static bool test_hide(SDL_Window *w) { (void)w; hidden++; return 1; }
static bool test_raise(SDL_Window *w) { (void)w; raised++; return 1; }
static bool test_size(SDL_Window *w, int x, int y) { (void)w; (void)x; (void)y; sized++; return 1; }
static LRESULT test_proc(HWND h, UINT m, WPARAM w, LPARAM l) {
    (void)h; (void)w; (void)l;
    if (m == WM_SHOWWINDOW) notices++;
    return 0;
}
static void check(const char *name, int ok) {
    printf("%s %s\n", ok ? "ok" : "FAIL", name);
    if (!ok) failures++;
}
static void key(HWND top, HWND target, int expected, const char *name) {
    SDL_Event e = {0}; e.type=SDL_EVENT_KEY_DOWN;
    e.key.key='9'; e.key.scancode=38;
    g_qh=g_qn=0; g_activeTop=top;
    SetFocus(target);
    __u32_feed_sdl_event(e);
    check(name, g_qn==expected && (!expected ||
        (g_q[0].m.hwnd==target && g_q[0].m.message==WM_KEYDOWN && g_q[0].m.wParam=='9')));
}
int main(void) {
    struct __HWND top={0}, child={0};
    top.top=&top; top.enabled=1; top.proc=test_proc;
    child.top=&top; child.parent=&top; child.enabled=1; child.proc=test_proc;
    WINDOWPLACEMENT wp={0}; wp.length=sizeof wp;
    wp.rcNormalPosition.right=top.w=120; wp.rcNormalPosition.bottom=top.h=80;
    wp.showCmd=SW_SHOWNA;
    check("placement unchanged geometry shows without activation", SetWindowPlacement(&top,&wp) && top.visible && shown==1 && raised==0 && sized==1);
    wp.showCmd=SW_SHOWNORMAL;
    check("placement already visible requests activation", SetWindowPlacement(&top,&wp) && raised==1 && notices==1);
    wp.showCmd=SW_HIDE;
    check("placement hides", SetWindowPlacement(&top,&wp) && !top.visible && hidden==1);
    wp.showCmd=SW_SHOWNOACTIVATE;
    check("placement restores without activation", SetWindowPlacement(&top,&wp) && top.visible && raised==1);
    wp.length=0;
    check("invalid placement length refuses before effects", !SetWindowPlacement(&top,&wp) && shown==3 && hidden==1);
    top.visible=1;
    key(&top,&child,1,"explicitly focused hidden child receives key");
    child.visible=1;
    key(&top,&child,1,"visible focused child receives key");
    child.enabled=0;
    key(&top,&child,0,"disabled focus target rejects key");
    child.enabled=1; top.visible=0;
    key(&top,&child,0,"hidden top rejects key");
    top.visible=1; top.enabled=0;
    key(&top,&child,0,"disabled ancestor rejects key");
    printf("USER32-LIFECYCLE-POLICY failures=%d\n",failures);
    return failures ? 1 : 0;
}
