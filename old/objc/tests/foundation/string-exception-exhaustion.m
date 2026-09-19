#include <Foundation/NSException.h>
#include <Foundation/NSAutoreleasePool.h>
#include <stdio.h>
#include <stdlib.h>
#define CHECK(x) do {if(!(x)){printf("exception OOM check line %d\n",__LINE__);return 1;}}while(0)
static unsigned deaths;
@interface ExhaustedException : NSException
- (void)dealloc;
@end
@implementation ExhaustedException
- (void)dealloc {deaths++;[super dealloc];}
@end
static void *blocks[131072];
static long liveBytes(void) {
  struct __heap_info info;__inspect_heap(&info);
  return info.total_bytes-info.free_bytes-8*info.free_blocks;
}
int main(void) { @autoreleasepool {
  NSString *name=@"exception name snapshot uses owned storage";
  NSString *reason=@"exception reason snapshot uses separate owned storage";
  NSObject *info=[NSObject new];CHECK(info);
  unsigned failures=0,successes=0;
  long baseline=liveBytes();
  /* Vary real available heap space across receiver/name/reason allocations.
   * This exercises libc failure, without an allocator stub or host pressure. */
  for(unsigned spareSize=0;spareSize<=640;spareSize+=8) {
    NSException *exception=[ExhaustedException alloc];CHECK(exception);
    void *spare=spareSize?malloc(spareSize):NULL;CHECK(!spareSize || spare);
    unsigned count=0;
    while(count<131072 && (blocks[count]=malloc(8))) count++;
    CHECK(count<131072);free(spare);
    exception=[exception initWithName:name reason:reason userInfo:(NSDictionary *)info];
    if(exception) {
      CHECK([[exception name] isEqualToString:name] && [[exception reason] isEqualToString:reason]);
      CHECK([exception userInfo]==(NSDictionary *)info && [info retainCount]==2);
      successes++;[exception release];
    } else failures++;
    while(count) free(blocks[--count]);
    CHECK([info retainCount]==1);
    long after=liveBytes();
    if(after!=baseline) {printf("live heap spare %u before %ld after %ld\n",spareSize,baseline,after);return 1;}
  }
  CHECK(failures>0 && successes>0 && deaths==81);
  [info release];
  printf("FOUNDATION exception allocation rollback PASS failures=%u successes=%u\n",failures,successes);
}return 0;}
