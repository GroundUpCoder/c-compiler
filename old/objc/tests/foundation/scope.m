#include <Foundation/Foundation.h>
#include <stdio.h>
static int destroyed;
@interface Item : NSObject
- (void)dealloc;
@end
@implementation Item
- (void)dealloc { destroyed++; [super dealloc]; }
@end
struct Value { int n; double d; };
static struct Value make(void) {
  @autoreleasepool {
    [[Item new] autorelease];
    return (struct Value){destroyed, 7.5};
  }
}
static int scalar(void) {
  @autoreleasepool { [[Item new] autorelease]; return destroyed; }
}
static void nothing(void) {
  @autoreleasepool { [[Item new] autorelease]; return; }
}
int main(void) {
  struct Value v=make();
  if(v.n!=0 || v.d!=7.5 || destroyed!=1) return 1;
  if(scalar()!=1 || destroyed!=2) return 2;
  nothing(); if(destroyed!=3) return 3;
  for(int i=0;i<3;i++) {
    @autoreleasepool {
      [[Item new] autorelease];
      if(i<2) continue;
      break;
    }
  }
  if(destroyed!=6) return 4;
  @autoreleasepool {
    [[Item new] autorelease];
    for(int i=0;i<3;i++) { if(i<2) continue; break; }
    switch(2) { case 2: break; default: return 5; }
    if(destroyed!=6) return 6;
    int x=0;
again:
    x++; if(x<2) goto again;
    @autoreleasepool { [[Item new] autorelease]; goto out; }
  }
out:
  if(destroyed!=8) return 7;
  @autoreleasepool { [[Item new] autorelease]; }
  if(destroyed!=9) return 8;
  puts("FOUNDATION scope PASS"); return 0;
}
