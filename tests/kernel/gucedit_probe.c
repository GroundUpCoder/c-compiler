#include "../../os/win32/gucedit.h"
#include <stdio.h>
#include <string.h>
#include <stdlib.h>

static int fails;
static void *noalloc(size_t n) { (void)n; return NULL; }
#define OK(n,x) do { if (x) printf("ok %s\n",n); else { printf("FAIL %s\n",n); fails++; } } while (0)
typedef struct { uint32_t size,version,text_generation,count; GUCEDIT_STYLE_V1 s[2]; } Batch;
#define B(x) ((GUCEDIT_BATCH_V1 *)&(x))
static Batch good(const char *text) {
    Batch x; memset(&x,0,sizeof x); x.size=sizeof(GUCEDIT_BATCH_V1)+sizeof(GUCEDIT_STYLE_V1);
    x.version=GUCEDIT_ABI_VERSION;x.text_generation=7;x.count=1;
    x.s[0]=(GUCEDIT_STYLE_V1){0,1,0x112233,0x445566,GUES_BG_VALID|GUES_UNDERLINE|GUES_BOX};
    (void)text; return x;
}
int main(void) {
    const char *text="a\té\nZ"; Batch x=good(text);
    OK("valid batch",gucedit_check_batch(B(x),text,6,7)==GUCEDIT_CHECK_OK);
    x.text_generation=6;OK("stale distinct",gucedit_check_batch(B(x),text,6,7)==GUCEDIT_CHECK_STALE);x=good(text);
    x.size--;OK("checked size",gucedit_check_batch(B(x),text,7,7)==GUCEDIT_CHECK_INVALID);x=good(text);
    x.count=GUCEDIT_MAX_STYLES+1;OK("checked count",gucedit_check_batch(B(x),text,7,7)==GUCEDIT_CHECK_INVALID);x=good(text);
    x.s[0].flags|=8;OK("unknown flags",gucedit_check_batch(B(x),text,7,7)==GUCEDIT_CHECK_INVALID);x=good(text);
    x.s[0].foreground|=0xff000000u;OK("invalid color",gucedit_check_batch(B(x),text,7,7)==GUCEDIT_CHECK_INVALID);x=good(text);
    x.s[0].start=3;x.s[0].end=4;OK("UTF-8 continuation start",gucedit_check_batch(B(x),text,7,7)==GUCEDIT_CHECK_INVALID);x=good(text);
    x.s[0].start=4;x.s[0].end=6;OK("LF crossing",gucedit_check_batch(B(x),text,7,7)==GUCEDIT_CHECK_INVALID);x=good(text);
    x.s[0].start=1;x.s[0].end=2;OK("BOX on tab",gucedit_check_batch(B(x),text,7,7)==GUCEDIT_CHECK_INVALID);x=good(text);
    x.s[0].start=2;x.s[0].end=4;OK("BOX on one UTF-8 scalar",gucedit_check_batch(B(x),text,7,7)==GUCEDIT_CHECK_OK);
    x=good(text);x.count=0;x.size=sizeof(GUCEDIT_BATCH_V1);OK("empty batch is valid no-style state",gucedit_check_batch(B(x),text,6,7)==GUCEDIT_CHECK_OK);x=good(text);x.count=2;x.size=sizeof(GUCEDIT_BATCH_V1)+2*sizeof(GUCEDIT_STYLE_V1);x.s[0].flags=0;x.s[1]=(GUCEDIT_STYLE_V1){0,1,1,0,0};OK("overlap rejected",gucedit_check_batch(B(x),text,6,7)==GUCEDIT_CHECK_INVALID);x=good(text);
    GUCEDIT_BATCH_V1 *slot=malloc(x.size);memset(slot,0x5a,x.size);GUCEDIT_BATCH_V1 *prior=slot;OK("OOM preserves prior allocation",!gucedit_replace_batch(&slot,B(x),noalloc)&&slot==prior);OK("replacement copies valid allocation",gucedit_replace_batch(&slot,B(x),malloc)&&slot!=prior&&slot->count==1);free(slot);
    return fails?1:0;
}
