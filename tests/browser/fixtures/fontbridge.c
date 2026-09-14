#define SDL_MAIN_USE_CALLBACKS
#include <SDL.h>
#include <gucos/fontbridge.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
static SDL_Window *window;
static SDL_Renderer *renderer;
static SDL_Texture *text;
static int font,width,height,left,top,frame;
static double cold[32],warm[128];
static const char *mode;
static const char *message="Shared fonts: editor tools 0123456789";
static int make_text(void){
 int result=__font_codepoint_run(font,message,strlen(message));if(result<=0)return 0;
 width=__font_result_field(result,0);height=__font_result_field(result,1);
 left=__font_result_field(result,2);top=__font_result_field(result,3);
 int bytes=__font_result_field(result,5);void *pixels=malloc(bytes);
 if(!pixels){__font_result_release(result);return 0;}
 if(__font_result_copy(result,pixels,bytes,0xffffffffu)!=bytes){free(pixels);__font_result_release(result);return 0;}
 text=SDL_CreateTexture(renderer,SDL_PIXELFORMAT_RGBA32,SDL_TEXTUREACCESS_STATIC,width,height);
 int ok=text&&SDL_UpdateTexture(text,NULL,pixels,width*4);
 free(pixels);__font_result_release(result);return ok;
}
static void report(const char *name,double *values,int n){
 for(int i=1;i<n;i++){double v=values[i];int j=i;while(j>0&&values[j-1]>v){values[j]=values[j-1];j--;}values[j]=v;}
 printf("FONT-PERF %s %s n=%d p50=%.3f p95=%.3f p99=%.3f ms\n",mode,name,n,values[(n*50+99)/100-1],values[(n*95+99)/100-1],values[(n*99+99)/100-1]);
}
SDL_AppResult SDL_AppInit(void **state,int argc,char **argv){
 (void)state;(void)argv;mode=argc>1?"CPU":"GPU";
 SDL_Init(SDL_INIT_VIDEO);window=SDL_CreateWindow("fontbridge",512,192,0);
 renderer=SDL_CreateRenderer(window,argc>1?"software":NULL);if(!renderer||__font_abi()!=1)return SDL_APP_FAILURE;
 return SDL_APP_CONTINUE;
}
SDL_AppResult SDL_AppIterate(void *state){
 (void)state;if(frame>=160)return SDL_APP_CONTINUE;
 Uint64 begin=SDL_GetPerformanceCounter();
 if(frame<32){
  if(text){SDL_DestroyTexture(text);text=NULL;}
  if(font>0)__font_close(font);
  font=__font_open(NULL,20,0);if(font<=0||!make_text())return SDL_APP_FAILURE;
 }
 SDL_SetRenderDrawColor(renderer,16,24,40,255);SDL_RenderClear(renderer);
 SDL_SetRenderClipRect(renderer,NULL);
 SDL_SetRenderDrawColor(renderer,0,160,96,255);SDL_RenderLine(renderer,16,64,480,64);
 SDL_FRect first={16+left,64-top,width,height};SDL_RenderTexture(renderer,text,NULL,&first);
 SDL_Rect child={80,96,220,40};SDL_SetRenderClipRect(renderer,&child);
 SDL_FRect second={32+left,124-top,width,height};SDL_RenderTexture(renderer,text,NULL,&second);
 SDL_SetRenderClipRect(renderer,NULL);
 SDL_RenderPresent(renderer);
 double elapsed=(double)(SDL_GetPerformanceCounter()-begin)*1000.0/SDL_GetPerformanceFrequency();
 if(frame<32)cold[frame]=elapsed;else warm[frame-32]=elapsed;
 frame++;
 if(frame==160){
  report("cold-open-raster-upload-submit",cold,32);report("warm-cached-texture-submit",warm,128);
  printf("FONT-READY %s width=%d height=%d left=%d top=%d ascent=%d descent=%d cache=%d\n",mode,width,height,left,top,__font_metric(font,0),__font_metric(font,1),__font_metric(font,4));fflush(stdout);
 }
 return SDL_APP_CONTINUE;
}
SDL_AppResult SDL_AppEvent(void *state,SDL_Event *event){(void)state;return event->type==SDL_EVENT_QUIT?SDL_APP_SUCCESS:SDL_APP_CONTINUE;}
void SDL_AppQuit(void *state,SDL_AppResult result){(void)state;(void)result;SDL_DestroyTexture(text);__font_dispose();SDL_DestroyRenderer(renderer);SDL_DestroyWindow(window);}
