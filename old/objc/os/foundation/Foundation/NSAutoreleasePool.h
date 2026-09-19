#ifndef GUC_FOUNDATION_NSAUTORELEASEPOOL_H
#define GUC_FOUNDATION_NSAUTORELEASEPOOL_H
#include <Foundation/NSObject.h>
struct __guc_pool_chunk;
@interface NSAutoreleasePool : NSObject {
@private
  NSAutoreleasePool *_parent;
  struct __guc_pool_chunk *_chunk;
  int _active;
  int _draining;
}
- (id)init;
+ (void)addObject:(id)object;
- (void)addObject:(id)object;
- (void)drain;
- (void)release;
- (void)dealloc;
- (id)retain;
- (id)autorelease;
@end
#endif
