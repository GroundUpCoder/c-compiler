#include <Foundation/Foundation.h>
#include <stdio.h>
static int destroyed;
@interface Item : NSObject
- (void)dealloc;
@end
@implementation Item
- (void)dealloc { destroyed++; [super dealloc]; }
@end
static void done(void) {}
static void voidExpression(void) {
  @autoreleasepool { [[Item new] autorelease]; return done(); }
}
int main(void) {
  int i=0;
repeat:
  @autoreleasepool {
    [[Item new] autorelease];
    if(++i<4) goto repeat;
  }
  if(destroyed!=4) return 1;
  for(i=0;i<3;i++) {
    @autoreleasepool {
      [[Item new] autorelease];
      switch(i) { case 0: continue; case 1: break; default: break; }
      NSAutoreleasePool *p=[NSAutoreleasePool new];
      [[Item new] autorelease]; [p drain];
    }
  }
  if(destroyed!=9) return 2;
  voidExpression(); if(destroyed!=10) return 3;
  puts("FOUNDATION scope flow PASS"); return 0;
}
