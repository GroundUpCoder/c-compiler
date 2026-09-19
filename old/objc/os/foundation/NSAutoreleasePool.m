#include <Foundation/Foundation.h>
#include <stdlib.h>
#include <stdio.h>
struct __guc_pool_chunk { struct __guc_pool_chunk *previous; unsigned count; id objects[64]; };
static NSAutoreleasePool *current;
static void poolFailure(const char *reason) {
  fprintf(stderr,"Foundation NSAutoreleasePool: %s\n",reason);
  abort();
}
@implementation NSAutoreleasePool
- (id)init {
  self=[super init];
  if(self && !_active) { _parent=current; current=self; _active=1; }
  return self;
}
+ (void)addObject:(id)object {
  if(!object) return;
  if(!current) { fprintf(stderr,"Foundation: autorelease without a pool; object not released\n"); return; }
  [current addObject:object];
}
- (void)addObject:(id)object {
  if(!object) return;
  if(!_active) poolFailure("adding to an uninitialized pool");
  if(!_chunk || _chunk->count==64) {
    struct __guc_pool_chunk *chunk=malloc(sizeof(struct __guc_pool_chunk));
    if(!chunk) poolFailure("cannot allocate autorelease bookkeeping");
    chunk->previous=_chunk; chunk->count=0; _chunk=chunk;
  }
  _chunk->objects[_chunk->count++]=object;
}
- (void)drain { [self dealloc]; }
- (void)release { [self dealloc]; }
- (id)retain { poolFailure("pools cannot be retained"); return nil; }
- (id)autorelease { poolFailure("pools cannot be autoreleased"); return nil; }
- (void)dealloc {
  if(_draining) poolFailure("recursive drain of an active draining pool");
  _draining=1;
  if(_active) {
    for(;;) {
      while(current!=self) {
        if(!current) poolFailure("invalid pool stack");
        [current drain];
      }
      if(!_chunk) break;
      if(!_chunk->count) {
        struct __guc_pool_chunk *empty=_chunk;
        _chunk=empty->previous; free(empty); continue;
      }
      id object=_chunk->objects[--_chunk->count];
      [object release];
    }
    current=_parent; _active=0;
  }
  [super dealloc];
}
@end
id __guc_objc_pool_push(void) {
  id pool=[NSAutoreleasePool new];
  if(!pool) poolFailure("cannot allocate scoped autorelease pool");
  return pool;
}
void __guc_objc_pool_pop(id pool) { [(NSAutoreleasePool *)pool drain]; }
