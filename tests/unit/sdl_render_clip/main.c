#include <SDL.h>
#include <stdio.h>
#include <limits.h>
int main(void) {
 SDL_Init(SDL_INIT_VIDEO);
 SDL_Window *w=SDL_CreateWindow("clip",64,64,0);
 SDL_Renderer *r=SDL_CreateRenderer(w,NULL);
 SDL_Rect a={-10,20,INT_MAX,0}, b={0};
 printf("default %d %d\n",SDL_RenderClipEnabled(r),SDL_GetRenderClipRect(r,&b)&&b.w==0);
 SDL_SetRenderClipRect(r,&a); SDL_GetRenderClipRect(r,&b);
 printf("roundtrip %d\n",SDL_RenderClipEnabled(r)&&b.x==-10&&b.y==20&&b.w==INT_MAX&&b.h==0);
 SDL_Texture *t=SDL_CreateTexture(r,SDL_PIXELFORMAT_RGBA32,SDL_TEXTUREACCESS_TARGET,16,16);
 SDL_SetRenderTarget(r,t); printf("target default %d\n",!SDL_RenderClipEnabled(r));
 SDL_Rect tc={2,3,4,5}; SDL_SetRenderClipRect(r,&tc);
 SDL_SetRenderTarget(r,NULL); SDL_GetRenderClipRect(r,&b); printf("window restore %d\n",b.x==-10&&b.w==INT_MAX);
 SDL_SetRenderTarget(r,t); SDL_GetRenderClipRect(r,&b); printf("target restore %d\n",b.x==2&&b.h==5);
 SDL_DestroyTexture(t); SDL_GetRenderClipRect(r,&b); printf("destroy restore %d\n",b.x==-10&&b.w==INT_MAX);
 SDL_SetRenderClipRect(r,NULL); SDL_GetRenderClipRect(r,&b); printf("disabled %d\n",!SDL_RenderClipEnabled(r)&&!b.x&&!b.y&&!b.w&&!b.h);
 tc.w=-1; SDL_SetRenderClipRect(r,&tc); printf("negative disables %d\n",!SDL_RenderClipEnabled(r));
 printf("null renderer %d\n",!SDL_SetRenderClipRect(NULL,&a)&&!SDL_GetRenderClipRect(NULL,&b)&&!SDL_RenderClipEnabled(NULL));
 SDL_DestroyRenderer(r); SDL_DestroyWindow(w); SDL_Quit();
}
