#include <Foundation/NSException.h>
#include <Foundation/NSAutoreleasePool.h>
#include <stdio.h>
#include <stdlib.h>
#define CHECK(x) do {if(!(x)){printf("bounds check line %d\n",__LINE__);return 1;}}while(0)
static long liveBytes(void) {
  struct __heap_info info; __inspect_heap(&info);
  return info.total_bytes-info.free_bytes-8*info.free_blocks;
}
int main(void) {
  /* Catch an internally owned error without any autorelease pool. */
  unsigned direct=0;
  @try { [@"" characterAtIndex:0]; }
  @catch(NSException *e) {CHECK([[e name] isEqualToString:NSRangeException]);direct++;}
  CHECK(direct==1);
  NSString *heap=[[NSString alloc] initWithUTF8String:"abc"];
  NSString *empty=[[NSString alloc] init];
  unichar units[]={0xd83d,0xde42};
  NSString *wide=[[NSString alloc] initWithCharacters:units length:2];
  CHECK(heap && empty && wide);
  NSString *strings[]={heap,empty,wide,@"abc",@"",@"\U0001f642"};
  long before=liveBytes();
  unsigned caught=0,finallyCount=0;
  for(unsigned round=0;round<128;round++) {
    for(unsigned kind=0;kind<6;kind++) {
      NSString *s=strings[kind];NSUInteger n=[s length],rc=[s retainCount];
      for(unsigned test=0;test<3;test++) {
        NSUInteger index=test==0?n:test==1?n+1:(NSUInteger)-1;
        NSException *saved=nil;
        @autoreleasepool {
          @try {
            @try { [s characterAtIndex:index];CHECK(0); }
            @catch(NSException *e) {
              CHECK([[e name] isEqualToString:NSRangeException]);
              CHECK([[e name] isEqualToString:@"NSRangeException"]);
              CHECK(![[e name] isEqualToString:NSInvalidArgumentException]);
              CHECK([[e reason] length]>0 && [e userInfo]==nil);
              saved=[e retain];
              @throw;
            } @finally {finallyCount++;}
          } @catch(NSException *e) {CHECK(e==saved);caught++;}
        }
        /* Both catch scopes and the pool are gone; the explicit retain owns
         * the exception and its copied strings until this release. */
        CHECK(saved && [[saved name] isEqualToString:NSRangeException]);
        CHECK([[saved reason] length]>0);[saved release];
        CHECK([s retainCount]==rc && [s length]==n);
        if(n) CHECK([s characterAtIndex:n-1]==(kind==2||kind==5?0xde42:'c'));
      }
    }
  }
  CHECK(caught==2304 && finallyCount==2304);
  if(liveBytes()!=before) {printf("bounds live heap before %ld after %ld\n",before,liveBytes());return 1;}
  [heap release];[empty release];[wide release];
  puts("FOUNDATION catchable range bounds ownership cleanup PASS");
  return 0;
}
