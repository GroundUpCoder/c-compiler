#undef main
int main(void) {
    wmp_rec rec={0}; strcpy(rec.title,"startup"); rec.sid=17;
    char *args[2]={"startup",NULL};
    int failures=0;
#define CHECK(name, cond) do { int ok=(cond); printf("%s %s\n",ok?"ok":"FAIL",name); failures+=!ok; } while(0)
    CHECK("existence is not visibility", wm_cond_met("win",args,&rec,1)==1 && wm_cond_met("visible",args,&rec,1)==0);
    rec.flags=WMP_F_HIDDEN;
    CHECK("hidden startup does not satisfy visible", wm_cond_met("visible",args,&rec,1)==0);
    char flags[10]; rec_flags(&rec,flags);
    CHECK("hidden state exposed in list", strchr(flags,'H')!=NULL);
    rec.flags=WMP_F_VIEWABLE;
    CHECK("viewable startup satisfies visible", wm_cond_met("visible",args,&rec,1)==1);
    rec.flags=WMP_F_MINIMIZED;
    CHECK("minimized does not satisfy visible", wm_cond_met("visible",args,&rec,1)==0);
    CHECK("missing title does not satisfy visible", wm_cond_met("visible",args,&rec,0)==0);
    printf("WMCTL-VISIBILITY-POLICY failures=%d\n",failures);
    return failures?1:0;
}
