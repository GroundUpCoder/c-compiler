#define SDL_MAIN_USE_CALLBACKS
#include <SDL.h>
#include <stdio.h>
static SDL_Window *w;
static SDL_Renderer *r;
static SDL_Texture *glyph, *target;
static void color(int red,int green,int blue){SDL_SetRenderDrawColor(r,red,green,blue,255);}
static void rect(float x,float y,float width,float height){SDL_FRect d={x,y,width,height};SDL_RenderFillRect(r,&d);}
static void clip(int x,int y,int width,int height){SDL_Rect c={x,y,width,height};SDL_SetRenderClipRect(r,&c);}
SDL_AppResult SDL_AppInit(void **s,int argc,char **argv){
 (void)s;
 SDL_Init(SDL_INIT_VIDEO);
 w=SDL_CreateWindow("cliptest",192,128,0);
 r=SDL_CreateRenderer(w,argc>1?"software":NULL);
 if(!r){printf("CLIP-FAIL %s\n",SDL_GetError());return SDL_APP_FAILURE;}
 glyph=SDL_CreateTexture(r,SDL_PIXELFORMAT_RGBA32,SDL_TEXTUREACCESS_STATIC,32,48);
 target=SDL_CreateTexture(r,SDL_PIXELFORMAT_RGBA32,SDL_TEXTUREACCESS_TARGET,32,32);
 if(!glyph||!target)return SDL_APP_FAILURE;
 unsigned char pixels[32*48*4];
 for(int y=0;y<48;y++)for(int x=0;x<32;x++){
  int o=(y*32+x)*4;pixels[o]=x*8;pixels[o+1]=y*4;pixels[o+2]=128;pixels[o+3]=255;
 }
 SDL_UpdateTexture(glyph,NULL,pixels,128);SDL_SetTextureScaleMode(glyph,SDL_SCALEMODE_NEAREST);
 SDL_SetTextureBlendMode(glyph,SDL_BLENDMODE_NONE);
 SDL_SetTextureBlendMode(target,SDL_BLENDMODE_NONE);
 printf("CLIP-READY %s\n",argc>1?"CPU":"GPU");fflush(stdout);
 return SDL_APP_CONTINUE;
}
SDL_AppResult SDL_AppIterate(void *s){
 (void)s;
 // Clear ignores even an enabled empty clip left by the previous frame.
 color(12,18,24);SDL_RenderClear(r);
 clip(8,8,64,48);color(255,0,0);rect(0,0,80,64);
 // Translated child Graphics intersects the parent's clip in target pixels.
 clip(24,20,24,16);color(0,255,0);rect(16,16,64,48);
 clip(88,8,16,32);SDL_FRect d={80,0,32,48};SDL_RenderTexture(r,glyph,NULL,&d);
 clip(120,8,24,32);
 SDL_Vertex v[3]={{{112,0},{0,0,1,1},{0,0}},{{176,0},{0,0,1,1},{0,0}},{{112,64},{0,0,1,1},{0,0}}};
 SDL_RenderGeometry(r,NULL,v,3,NULL,0);
 clip(156,24,24,16);SDL_FRect rot={144,8,48,48};
 SDL_SetTextureColorMod(glyph,255,0,255);SDL_RenderTextureRotated(r,glyph,NULL,&rot,45,NULL,SDL_FLIP_NONE);SDL_SetTextureColorMod(glyph,255,255,255);
 // Each target owns its clip; clear must cover all 32x32 every time.
 clip(8,80,32,32);SDL_SetRenderTarget(r,target);
 color(0,255,255);SDL_RenderClear(r);
 clip(8,8,16,16);color(255,255,0);rect(0,0,32,32);
 SDL_SetRenderTarget(r,NULL);SDL_FRect td={8,80,32,32};SDL_RenderTexture(r,target,NULL,&td);
 // Queue ordering: disabling must not alter any earlier batch's clip.
 SDL_SetRenderClipRect(r,NULL);color(255,255,255);rect(64,80,16,16);
 clip(1000,1000,20,20);color(255,0,255);rect(0,0,192,128);
 clip(0,0,0,128);rect(0,0,192,128);
 SDL_RenderPresent(r);
 static int announced; if(!announced){announced=1;puts("CLIP-FRAME");fflush(stdout);}
 return SDL_APP_CONTINUE;
}
SDL_AppResult SDL_AppEvent(void *s,SDL_Event *e){(void)s;return e->type==SDL_EVENT_QUIT?SDL_APP_SUCCESS:SDL_APP_CONTINUE;}
void SDL_AppQuit(void *s,SDL_AppResult result){(void)s;(void)result;SDL_DestroyTexture(glyph);SDL_DestroyTexture(target);SDL_DestroyRenderer(r);SDL_DestroyWindow(w);}
