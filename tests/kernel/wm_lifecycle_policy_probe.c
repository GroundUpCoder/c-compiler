/* Included after the real wm.c by test_wm_lifecycle_policy.js.
 * Only WM socket reads/writes are replaced; policy handlers run compiled C. */
#undef main
static unsigned char input[128];
static int sent_type[512], sent_args[512][3], nsent, failures;
static int test_read(int fd, void *buf, int len) { (void)fd; memcpy(buf,input,len); return 0; }
static int test_send(int fd, uint32_t type, const int32_t *args, int n) {
    (void)fd;
    if (nsent < 512) { sent_type[nsent]=type; for(int i=0;i<n && i<3;i++) sent_args[nsent][i]=args[i]; nsent++; }
    return 0;
}
static void check(int ok, const char *name) { printf("%s %s\n",ok?"ok":"FAIL",name); if(!ok)failures++; }
static void event(uint32_t type, void *payload, int size) {
    memcpy(input,payload,size); wmp_hdr h; h.type=type; h.plen=size; handle_event(&h);
}
static wmp_rec record(int sid) {
    wmp_rec r; memset(&r,0,sizeof r); r.sid=sid; r.pid=42;
    r.x=100; r.y=90; r.w=r.dst_w=300; r.h=r.dst_h=200; r.flags=WMP_F_RESIZABLE;
    return r;
}
static int command(int type,int sid,int x,int y) {
    for(int i=0;i<nsent;i++)if(sent_type[i]==type&&sent_args[i][0]==sid&&sent_args[i][1]==x&&sent_args[i][2]==y)return 1;
    return 0;
}
int main(void) {
    scr_w=1000; scr_h=700; own_pid=1;
    wmp_rec r=record(100);
    event(WMP_EV_CREATED,&r,sizeof r);
    title_activate(r.sid);
    check(find(100)->maximized,"title activation maximizes");
    r.flags|=WMP_F_HIDDEN; event(WMP_EV_VISIBILITY,&r,sizeof r);
    check(!find(100),"hidden leaves selectable set");
    /* Fill all visible slots after hiding, then attempt show at capacity. */
    for(int i=0;i<MAX_WIN;i++){wmp_rec other=record(i+200);event(WMP_EV_CREATED,&other,sizeof other);}
    r.flags&=~WMP_F_HIDDEN; event(WMP_EV_VISIBILITY,&r,sizeof r);
    check(!find(100),"capacity remains bounded");
    int sid=200; event(WMP_EV_DESTROYED,&sid,4);
    event(WMP_EV_VISIBILITY,&r,sizeof r);
    check(find(100)&&find(100)->maximized,"retry show preserves maximize history");
    nsent=0;title_activate(100);
    check(command(WMP_MOVE,100,100,90)&&command(WMP_RESIZE,100,300,200),"restore after hide and capacity pressure uses floating rect");
    snap_to(find(100),1);
    r.flags|=WMP_F_HIDDEN;event(WMP_EV_VISIBILITY,&r,sizeof r);
    int32_t moved[3]={100,0,28};event(WMP_EV_MOVED,moved,12);
    int32_t sized[3]={100,500,636};event(WMP_EV_CONFIGURED,sized,12);
    check(hidden_wins&&hidden_wins->value.w==500&&hidden_wins->value.x==0,"hidden geometry echoes retained");
    nsent=0;scr_w=800;scr_h=600;
    screen_changed();
    check(command(WMP_RESIZE,100,400,536),"screen resize refits hidden snapped window");
    r.flags&=~WMP_F_HIDDEN;event(WMP_EV_VISIBILITY,&r,sizeof r);
    nsent=0;restore_floating(find(100));
    check(command(WMP_MOVE,100,100,90)&&command(WMP_RESIZE,100,300,200),"snap restore survives hidden resize");
    printf("WM-LIFECYCLE-POLICY failures=%d\n",failures);return failures?1:0;
}
