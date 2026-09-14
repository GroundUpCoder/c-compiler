/* #791: process-local font module. All faces are memory-backed; the loader
 * owns filesystem policy. Reuses fontcore's probe/render/tofu pipeline.
 * Codepoint runs are left-to-right integer-advance rasterization, not shaping.
 */
#include "../fontcore.h"
#include <limits.h>
#define FB_FONTS 16
#define FB_FACES 8
#define FB_CACHE 64
#define FB_FONT_BYTES (64*1024*1024)
#define FB_CACHE_BYTES (512*1024)
#define FB_RESULT_BYTES (8*1024*1024)
typedef struct {
 int id,px,flags,ascent,descent,height,cell,n;
 FT_Face face[FB_FACES]; unsigned char *data[FB_FACES]; int sizes[FB_FACES];
 FcGlyph glyph[FB_CACHE]; unsigned cp[FB_CACHE]; unsigned used[FB_CACHE],clock;
 int cache_bytes;
} Font;
static FT_Library library;
static Font fonts[FB_FONTS];
static int next_id=1,font_bytes;
static unsigned char *result;
static int result_cap;
/* width,height,left,top,advance,byte length,bitmap pointer */
static int descriptor[7];
static Font *find(int id){for(int i=0;i<FB_FONTS;i++)if(fonts[i].id==id&&id>0)return &fonts[i];return NULL;}
static void clear_cache(Font *f){for(int i=0;i<FB_CACHE;i++){free(f->glyph[i].bmp);memset(&f->glyph[i],0,sizeof(FcGlyph));f->used[i]=0;}f->cache_bytes=0;f->clock=0;}
int fb_abi(void){return 1;}
void *fb_alloc(int n){return n>0&&n<=FB_FONT_BYTES?malloc(n):NULL;}
void fb_free(void *p){free(p);}
int fb_close(int id){
 Font *f=find(id);if(!f)return -1;
 clear_cache(f);for(int i=0;i<f->n;i++){FT_Done_Face(f->face[i]);free(f->data[i]);font_bytes-=f->sizes[i];}
 memset(f,0,sizeof(*f));return 0;
}
int fb_add_face(int id,const unsigned char *data,int size){
 Font *f=find(id);if(!f||!data||size<=0)return -1;
 if(f->n==FB_FACES||size>FB_FONT_BYTES-font_bytes)return -2;
 unsigned char *copy=malloc(size);if(!copy)return -2;memcpy(copy,data,size);
 FT_Face face=NULL;
 if(FT_New_Memory_Face(library,copy,size,0,&face)){free(copy);return -3;}
 if(FT_Set_Pixel_Sizes(face,0,f->px)){FT_Done_Face(face);free(copy);return -3;}
 int i=f->n++;f->face[i]=face;f->data[i]=copy;f->sizes[i]=size;font_bytes+=size;
 clear_cache(f);return 0;
}
int fb_open(const unsigned char *data,int size,int px,int flags){
 if(px<1||px>256||flags<0||flags>3||next_id==INT_MAX)return -1;
 if(!library&&FT_Init_FreeType(&library))return -3;
 Font *f=NULL;for(int i=0;i<FB_FONTS;i++)if(!fonts[i].id){f=&fonts[i];break;}
 if(!f)return -2;
 f->id=next_id++;f->px=px;f->flags=flags;
 int rc=fb_add_face(f->id,data,size);if(rc<0){memset(f,0,sizeof(*f));return rc;}
 FT_Face face=f->face[0];f->ascent=(face->size->metrics.ascender+63)>>6;
 f->descent=-(face->size->metrics.descender>>6);f->height=(face->size->metrics.height+63)>>6;
 f->cell=px/2;if(f->cell<1)f->cell=1;
 if(!FT_Load_Char(face,'M',fc_load_flags(face)))f->cell=face->glyph->advance.x>>6;
 return f->id;
}
int fb_metric(int id,int field){Font *f=find(id);if(!f)return -1;switch(field){case 0:return f->ascent;case 1:return f->descent;case 2:return f->height;case 3:return f->cell;case 4:return f->cache_bytes;case 5:return f->n;default:return -1;}}
static FcGlyph *lookup(Font *f,unsigned cp){
 if(cp<32||cp>0x10ffff||(cp>=0xd800&&cp<=0xdfff))return NULL;
 if(f->clock==UINT_MAX)clear_cache(f);
 int slot=0;
 for(int i=0;i<FB_CACHE;i++){
  if(f->used[i]&&f->cp[i]==cp){f->used[i]=++f->clock;return &f->glyph[i];}
  if(f->used[i]<f->used[slot])slot=i;
 }
 FcGlyph g={0};FT_UInt index=0;FT_Face face=NULL;
 FcChain chain={0};chain.n=f->n-1;
 for(int i=1;i<f->n;i++){chain.face[i-1]=f->face[i];chain.state[i-1]=1;chain.px[i-1]=f->px;}
 face=fc_probe(f->face[0],&chain,f->px,cp,&index);
 if(face){FcRenderOpts opts={0,(f->flags&1)?0x0555:0,(f->flags&2)?FC_ITALIC_SHEAR:0};int ok=0;fc_render_face_checked(&g,face,index,opts,FB_CACHE_BYTES,&ok);if(!ok){free(g.bmp);return NULL;}}
 else {fc_tofu(&g,f->cell,f->ascent,cp);if(!g.bmp)return NULL;}
 if((g.w>0&&g.h>0&&!g.bmp)||g.w<0||g.h<0||g.w>2048||g.h>2048){free(g.bmp);return NULL;}
 int bytes=g.w*g.h;
 if(bytes>FB_CACHE_BYTES){free(g.bmp);return NULL;}
 if(f->cache_bytes+bytes>FB_CACHE_BYTES||f->clock==UINT_MAX){clear_cache(f);slot=0;}
 FcGlyph *dst=&f->glyph[slot];f->cache_bytes-=dst->w*dst->h;free(dst->bmp);
 *dst=g;f->cache_bytes+=bytes;f->cp[slot]=cp;f->used[slot]=++f->clock;return dst;
}
int *fb_glyph(int id,unsigned cp){Font *f=find(id);if(!f)return NULL;FcGlyph *g=lookup(f,cp);if(!g)return NULL;
 descriptor[0]=g->w;descriptor[1]=g->h;descriptor[2]=g->left;descriptor[3]=g->top;descriptor[4]=g->advance;descriptor[5]=g->w*g->h;descriptor[6]=(int)g->bmp;return descriptor;}
/* Input is validated Unicode scalar values, supplied in a contiguous u32 array.
 * Two passes keep metrics and pixels coherent across cache eviction. */
int *fb_run(int id,const unsigned *cps,int count){
 Font *f=find(id);if(!f||count<0||count>4096||(!cps&&count))return NULL;
 int pen=0,left=0,right=0,top=0,bottom=0;
 for(int i=0;i<count;i++){
  FcGlyph *g=lookup(f,cps[i]);if(!g)return NULL;
  if(pen+g->left<left)left=pen+g->left;
  if(pen+g->left+g->w>right)right=pen+g->left+g->w;
  if(g->top>top)top=g->top;if(g->h-g->top>bottom)bottom=g->h-g->top;
  pen+=g->advance;if(pen<0||pen>1048576)return NULL;
 }
 int width=right-left,height=top+bottom;
 if(width<0||height<0||height>2048||width>1048576||((long long)width*height)>FB_RESULT_BYTES)return NULL;
 int bytes=width*height;
 if(bytes>result_cap){unsigned char *p=realloc(result,bytes);if(!p)return NULL;result=p;result_cap=bytes;}
 if(bytes)memset(result,0,bytes);int x=-left;
 for(int i=0;i<count;i++){
  FcGlyph *g=lookup(f,cps[i]);if(!g)return NULL;
  for(int y=0;y<g->h;y++)for(int xx=0;xx<g->w;xx++){
   int dst=(top-g->top+y)*width+x+g->left+xx;
   unsigned a=g->bmp[y*g->w+xx],old=result[dst];result[dst]=a+((old*(255-a)+127)/255);
  }
  x+=g->advance;
 }
 descriptor[0]=width;descriptor[1]=height;descriptor[2]=left;descriptor[3]=top;descriptor[4]=pen;descriptor[5]=bytes;descriptor[6]=(int)result;return descriptor;
}
void fb_dispose(void){for(int i=0;i<FB_FONTS;i++)if(fonts[i].id)fb_close(fonts[i].id);free(result);result=NULL;result_cap=0;if(library)FT_Done_FreeType(library);library=NULL;}
int main(void){return 0;}
__export fb_abi=fb_abi;
__export fb_alloc=fb_alloc;
__export fb_free=fb_free;
__export fb_open=fb_open;
__export fb_add_face=fb_add_face;
__export fb_close=fb_close;
__export fb_metric=fb_metric;
__export fb_glyph=fb_glyph;
__export fb_run=fb_run;
__export fb_dispose=fb_dispose;
