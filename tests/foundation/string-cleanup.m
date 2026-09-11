#include <Foundation/NSException.h>
#include <Foundation/NSAutoreleasePool.h>
#include <stdio.h>
#include <stdlib.h>
#define CHECK(x) do {if(!(x)){printf("cleanup check line %d\n",__LINE__);return 1;}}while(0)
static id token;
static unsigned receiverDeaths,exceptionDeaths;
static unsigned placeholderDeaths;
static unsigned factoryDeaths,factoryPrimitiveCalls,factoryOverrideCalls;
static BOOL factoryReturnsNil;
@interface FactoryPrimitive : NSString
- (id)initWithCharacters:(const unichar *)p length:(NSUInteger)n;
- (void)dealloc;
@end
@implementation FactoryPrimitive
- (id)initWithCharacters:(const unichar *)p length:(NSUInteger)n {
  factoryPrimitiveCalls++;
  [self release];
  if(factoryReturnsNil) return nil;
  return [[NSString alloc] initWithCharacters:p length:n];
}
- (void)dealloc {factoryDeaths++;[super dealloc];}
@end
@interface FactoryOverride : FactoryPrimitive
- (id)initWithString:(NSString *)s;
@end
@implementation FactoryOverride
- (id)initWithString:(NSString *)s {factoryOverrideCalls++;return [super initWithString:s];}
@end
@interface TrackedConstant : NSConstantString
- (void)dealloc;
@end
@implementation TrackedConstant
- (void)dealloc {placeholderDeaths++;[super dealloc];}
@end
@interface ThrowingString : NSString { @public unsigned calls,throwAt; BOOL throwLength; }
- (NSUInteger)length;
- (unichar)characterAtIndex:(NSUInteger)i;
@end
@implementation ThrowingString
- (NSUInteger)length {if(throwLength) @throw token;return 32;}
- (unichar)characterAtIndex:(NSUInteger)i {if(++calls==throwAt) @throw token;return 'x';}
@end
@interface ConsumingString : NSString
- (id)initWithCharacters:(const unichar *)p length:(NSUInteger)n;
- (void)dealloc;
@end
@implementation ConsumingString
- (id)initWithCharacters:(const unichar *)p length:(NSUInteger)n {
  [self release]; @throw token;
}
- (void)dealloc {receiverDeaths++;[super dealloc];}
@end
@interface TrackedException : NSException
- (void)dealloc;
@end
@implementation TrackedException
- (void)dealloc {exceptionDeaths++;[super dealloc];}
@end
/* Existing allocator inspection reports free payload and free block count.
 * Include each free block's 8-byte header to measure live allocated storage,
 * independent of pool growth or coalescing. No replacement allocator. */
static long liveBytes(void) {
  struct __heap_info info; __inspect_heap(&info);
  return info.total_bytes-info.free_bytes-8*info.free_blocks;
}
int main(void) { @autoreleasepool {
  token=[NSObject new];
  ThrowingString *source=[ThrowingString new];
  CHECK(token && source);
  long before=liveBytes();
  unsigned caught=0;
  for(unsigned round=0;round<128;round++) {
    NSString *receiver=[NSString alloc];CHECK(receiver);
    source->calls=0;source->throwAt=5;
    @try {[receiver initWithString:source];CHECK(0);}
    @catch(id e) {CHECK(e==token);caught++;}
    source->calls=0;source->throwAt=37; /* First encoding pass is 32 calls. */
    @try {[source UTF8String];CHECK(0);}
    @catch(id e) {CHECK(e==token);caught++;}
    @try {[[ConsumingString alloc] initWithUTF8String:"temporary decoded units"];CHECK(0);}
    @catch(id e) {CHECK(e==token);caught++;}
    source->calls=0;source->throwAt=5;
    @try {[[TrackedException alloc] initWithName:source reason:@"reason" userInfo:nil];CHECK(0);}
    @catch(id e) {CHECK(e==token);caught++;}
    source->calls=0;source->throwAt=5;
    @try {[[TrackedException alloc] initWithName:@"completed name" reason:source userInfo:nil];CHECK(0);}
    @catch(id e) {CHECK(e==token);caught++;}
    @try {[[TrackedConstant alloc] initWithCharacters:NULL length:1];CHECK(0);}
    @catch(NSException *e) {CHECK([[e name] isEqualToString:NSInvalidArgumentException]);caught++;}
    source->throwLength=YES;
    @try {[[TrackedException alloc] initWithName:source reason:nil userInfo:nil];CHECK(0);}
    @catch(id e) {CHECK(e==token);caught++;}
    source->throwLength=NO;
    source->calls=0;source->throwAt=5;
    @try {[NSString stringWithString:source];CHECK(0);}
    @catch(id e) {CHECK(e==token);caught++;}
    source->calls=0;
    @try {[FactoryPrimitive stringWithString:source];CHECK(0);}
    @catch(id e) {CHECK(e==token);caught++;}
    source->calls=0;
    @try {[FactoryOverride stringWithString:source];CHECK(0);}
    @catch(id e) {CHECK(e==token);caught++;}
    source->throwLength=YES;
    @try {[NSString stringWithString:source];CHECK(0);}
    @catch(id e) {CHECK(e==token);caught++;}
    @try {[FactoryPrimitive stringWithString:source];CHECK(0);}
    @catch(id e) {CHECK(e==token);caught++;}
    source->throwLength=NO;
    @try {[ConsumingString stringWithUTF8String:"factory dispatch"];CHECK(0);}
    @catch(id e) {CHECK(e==token);caught++;}
    @try {[NSString stringWithString:nil];CHECK(0);}
    @catch(NSException *e) {CHECK([[e name] isEqualToString:NSInvalidArgumentException]);caught++;}
    @try {[NSString stringWithUTF8String:NULL];CHECK(0);}
    @catch(NSException *e) {CHECK([[e name] isEqualToString:NSInvalidArgumentException]);caught++;}
    @autoreleasepool {
      factoryReturnsNil=YES;
      CHECK([FactoryPrimitive stringWithUTF8String:"nil replacement"]==nil);
      factoryReturnsNil=NO;
      NSString *value=[FactoryPrimitive stringWithUTF8String:"owned replacement"];
      CHECK([value isEqualToString:@"owned replacement"] && [value retainCount]==1);
    }
  }
  CHECK(caught==1920 && receiverDeaths==256 && exceptionDeaths==384 && placeholderDeaths==128);
  CHECK(factoryDeaths==640 && factoryPrimitiveCalls==256 && factoryOverrideCalls==128);
  long after=liveBytes();
  if(before!=after) {printf("live heap before %ld after %ld\n",before,after);return 1;}
  [source release];[token release];
  puts("FOUNDATION exceptional temporary cleanup PASS");
}return 0;}
