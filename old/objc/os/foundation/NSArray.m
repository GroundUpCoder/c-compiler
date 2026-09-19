#include <Foundation/NSArray.h>
#include <Foundation/NSException.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <limits.h>

struct ArrayStorage {
  id *slots;
  NSUInteger count, capacity;
  unsigned long generation;
  int phase; /* 0 fresh, 1 initializing, 2 live, 3 deallocating */
};
@interface _GUCArray : NSArray { struct ArrayStorage _storage; }
- (id)init;
- (id)initWithObjects:(const id *)objects count:(NSUInteger)count;
- (id)initWithArray:(NSArray *)array;
- (NSUInteger)count;
- (id)objectAtIndex:(NSUInteger)index;
- (id)copy;
- (void)dealloc;
@end
@interface _GUCMutableArray : NSMutableArray { struct ArrayStorage _storage; }
- (id)init;
- (id)initWithObjects:(const id *)objects count:(NSUInteger)count;
- (id)initWithArray:(NSArray *)array;
- (id)initWithCapacity:(NSUInteger)capacity;
- (NSUInteger)count;
- (id)objectAtIndex:(NSUInteger)index;
- (void)insertObject:(id)object atIndex:(NSUInteger)index;
- (void)removeObjectAtIndex:(NSUInteger)index;
- (void)replaceObjectAtIndex:(NSUInteger)index withObject:(id)object;
- (void)removeAllObjects;
- (NSUInteger)countByEnumeratingWithState:(NSFastEnumerationState *)state objects:(id *)buffer count:(NSUInteger)length;
- (void)dealloc;
@end

static void arrayError(NSString *name, NSString *reason) {
  NSException *e=[[NSException alloc] initWithName:name reason:reason userInfo:nil];
  if(!e) { fprintf(stderr,"NSArray: cannot allocate exception\n"); abort(); }
  @try { [e raise]; } @finally { [e release]; }
}
static void abstractOperation(void) {
  arrayError(NSInvalidArgumentException,@"NSArray subclass must override this storage operation");
}
static void allocationFailure(void) {
  fprintf(stderr,"NSArray: allocation or capacity exhausted\n"); abort();
}
static id *allocateSlots(NSUInteger count) {
  if(count>UINT_MAX/sizeof(id)) allocationFailure();
  id *p=count ? malloc(count*sizeof(id)) : NULL;
  if(count && !p) allocationFailure();
  return p;
}
/* Balanced finally traversal: one release invocation per owned slot, including
 * duplicates; later ordinary exceptions replace earlier ones under ObjC EH.
 * At most 31 source recursion levels for a checked wasm32 vector.
 * Generated EH and engine frames are measured separately, as is user recursion.
 * Process termination/cancellation follows the existing EH boundary contract. */
static void releaseRange(id *slots, NSUInteger lo, NSUInteger count) {
  if(!count) return;
  if(count==1) { id object=slots[lo]; slots[lo]=nil; [object release]; return; }
  NSUInteger left=count/2;
  @try { releaseRange(slots,lo,left); }
  @finally { releaseRange(slots,lo+left,count-left); }
}
static void disposeSlots(id *slots, NSUInteger count) {
  @try { releaseRange(slots,0,count); }
  @finally { free(slots); }
}
static void beginInit(struct ArrayStorage *s) {
  if(s->phase) arrayError(NSInvalidArgumentException,@"NSArray receiver is already initialized or initializing");
  s->phase=1;
}
static void live(struct ArrayStorage *s) {
  if(s->phase!=2) arrayError(NSInvalidArgumentException,@"NSMutableArray receiver is not live");
}
static void generationRoom(struct ArrayStorage *s) {
  live(s);
  if(s->generation==ULONG_MAX) arrayError(NSGenericException,@"NSMutableArray mutation generation exhausted");
}
static void indexCheck(NSUInteger index, NSUInteger count, BOOL insertion) {
  if(index>count || (!insertion && index==count)) arrayError(NSRangeException,@"NSArray index out of bounds");
}
static void elementCheck(id object) {
  if(!object) arrayError(NSInvalidArgumentException,@"NSArray cannot contain nil");
}
/* Scratch input pointers are copied before any user retain. Only successful
 * acquisitions join the owned vector. Failure disposes the unpublished receiver. */
static id initializeObjects(id receiver, struct ArrayStorage *s, const id *objects, NSUInteger count) {
  beginInit(s);
  id *scratch=NULL,*owned=NULL; NSUInteger acquired=0; BOOL complete=NO;
  @try {
    if(count && !objects) arrayError(NSInvalidArgumentException,@"NSArray requires an object buffer");
    scratch=allocateSlots(count); owned=allocateSlots(count);
    for(NSUInteger i=0;i<count;i++) { elementCheck(objects[i]); scratch[i]=objects[i]; }
    for(NSUInteger i=0;i<count;i++) { [scratch[i] retain]; owned[acquired++]=scratch[i]; }
    s->slots=owned;s->count=count;s->capacity=count;s->phase=2;complete=YES;
    return receiver;
  } @finally {
    free(scratch);
    if(!complete) {
      @try { disposeSlots(owned,acquired); }
      @finally { guc_objc_dispose(receiver); }
    }
  }
}
static id initializeArray(id receiver, struct ArrayStorage *s, NSArray *source) {
  beginInit(s);
  id *owned=NULL; NSUInteger acquired=0,capacity=0; BOOL complete=NO;
  @try {
    if(!source) arrayError(NSInvalidArgumentException,@"NSArray requires a source array");
    capacity=[source count];owned=allocateSlots(capacity);
    NSFastEnumerationState state={0};id buffer[16];
    NSUInteger n=[source countByEnumeratingWithState:&state objects:buffer count:16];
    unsigned long generation=n ? *state.mutationsPtr : 0;
    while(n) {
      for(NSUInteger i=0;i<n;i++) {
        if(*state.mutationsPtr!=generation) objc_enumerationMutation(source);
        id object=state.itemsPtr[i];elementCheck(object);
        if(acquired==capacity) objc_enumerationMutation(source);
        [object retain];owned[acquired++]=object;
        if(*state.mutationsPtr!=generation) objc_enumerationMutation(source);
      }
      n=[source countByEnumeratingWithState:&state objects:buffer count:16];
    }
    if(acquired!=capacity) objc_enumerationMutation(source);
    s->slots=owned;s->count=acquired;s->capacity=capacity;s->phase=2;complete=YES;
    return receiver;
  } @finally {
    if(!complete) {
      @try { disposeSlots(owned,acquired); }
      @finally { guc_objc_dispose(receiver); }
    }
  }
}
static id initializeCapacity(id receiver, struct ArrayStorage *s, NSUInteger capacity) {
  beginInit(s);s->slots=allocateSlots(capacity);s->capacity=capacity;s->phase=2;
  return receiver;
}
static void reserve(struct ArrayStorage *s, NSUInteger wanted) {
  if(wanted<=s->capacity) return;
  if(wanted>UINT_MAX/sizeof(id)) allocationFailure();
  NSUInteger cap=s->capacity;
  if(cap<4) cap=4;
  while(cap<wanted) {
    if(cap>UINT_MAX/sizeof(id)/2) {cap=wanted;break;}
    cap*=2;
  }
  id *p=allocateSlots(cap);
  if(s->count) memcpy(p,s->slots,s->count*sizeof(id));
  free(s->slots);s->slots=p;s->capacity=cap;
}
static void insertOrReplace(struct ArrayStorage *s,id object,NSUInteger index,BOOL insertion) {
  elementCheck(object);generationRoom(s);indexCheck(index,s->count,insertion);
  BOOL acquired=NO,transferred=NO;
  @try {
    [object retain];acquired=YES;
    /* retain is user code: every state/index/capacity decision is made anew. */
    generationRoom(s);indexCheck(index,s->count,insertion);
    id old=nil;
    if(insertion) {
      if(s->count==UINT_MAX/sizeof(id)) allocationFailure();
      reserve(s,s->count+1);
      memmove(s->slots+index+1,s->slots+index,(s->count-index)*sizeof(id));
      s->count++;
    } else old=s->slots[index];
    s->slots[index]=object;s->generation++;transferred=YES;
    [old release];
  } @finally { if(acquired && !transferred) [object release]; }
}
static void detachAll(struct ArrayStorage *s,BOOL deallocating) {
  if(deallocating) s->phase=3;
  else generationRoom(s);
  id *old=s->slots;NSUInteger count=s->count;
  s->slots=NULL;s->count=0;s->capacity=0;
  if(!deallocating) s->generation++;
  disposeSlots(old,count);
}
static NSUInteger enumerate(NSArray *array,NSFastEnumerationState *state,id *buffer,NSUInteger length,unsigned long *generation) {
  state->mutationsPtr=generation;state->itemsPtr=buffer;
  NSUInteger count=[array count],position=state->state;
  if(position>=count || !length) return 0;
  NSUInteger n=count-position;if(n>length)n=length;
  for(NSUInteger i=0;i<n;i++) buffer[i]=[array objectAtIndex:position+i];
  state->state=position+n;return n;
}
@implementation NSArray
+ (id)alloc { return guc_objc_alloc(self==[NSArray class] ? [_GUCArray class] : self); }
+ (id)array { return [[[self alloc] init] autorelease]; }
+ (id)arrayWithObject:(id)object { return [self arrayWithObjects:&object count:1]; }
+ (id)arrayWithObjects:(const id *)objects count:(NSUInteger)count { return [[[self alloc] initWithObjects:objects count:count] autorelease]; }
+ (id)arrayWithArray:(NSArray *)array { return [[[self alloc] initWithArray:array] autorelease]; }
- (id)init { abstractOperation();return nil; }
- (id)initWithObjects:(const id *)objects count:(NSUInteger)count { abstractOperation();return nil; }
- (id)initWithArray:(NSArray *)array { abstractOperation();return nil; }
- (NSUInteger)count { abstractOperation();return 0; }
- (id)objectAtIndex:(NSUInteger)index { abstractOperation();return nil; }
- (id)firstObject { return [self count] ? [self objectAtIndex:0] : nil; }
- (id)lastObject { NSUInteger n=[self count];return n ? [self objectAtIndex:n-1] : nil; }
- (BOOL)containsObject:(id)object {
  NSUInteger n=[self count];for(NSUInteger i=0;i<n;i++) if([[self objectAtIndex:i] isEqual:object])return YES;
  return NO;
}
- (BOOL)isEqualToArray:(NSArray *)array {
  if(self==array)return YES;if(!array)return NO;
  NSUInteger n=[self count];if(n!=[array count])return NO;
  for(NSUInteger i=0;i<n;i++) if(![[self objectAtIndex:i] isEqual:[array objectAtIndex:i]])return NO;
  return YES;
}
- (BOOL)isEqual:(id)object { return [object isKindOfClass:[NSArray class]] && [self isEqualToArray:object]; }
- (NSUInteger)hash { return [self count]; }
- (id)copy { return [[NSArray alloc] initWithArray:self]; }
- (id)mutableCopy { return [[NSMutableArray alloc] initWithArray:self]; }
- (NSUInteger)countByEnumeratingWithState:(NSFastEnumerationState *)state objects:(id *)buffer count:(NSUInteger)length {
  return enumerate(self,state,buffer,length,&state->extra[0]);
}
@end
@implementation NSMutableArray
+ (id)alloc { return guc_objc_alloc(self==[NSMutableArray class] ? [_GUCMutableArray class] : self); }
+ (id)arrayWithCapacity:(NSUInteger)capacity { return [[[self alloc] initWithCapacity:capacity] autorelease]; }
- (id)initWithCapacity:(NSUInteger)capacity { abstractOperation();return nil; }
- (void)addObject:(id)object { [self insertObject:object atIndex:[self count]]; }
- (void)insertObject:(id)object atIndex:(NSUInteger)index { abstractOperation(); }
- (void)removeObjectAtIndex:(NSUInteger)index { abstractOperation(); }
- (void)replaceObjectAtIndex:(NSUInteger)index withObject:(id)object { abstractOperation(); }
- (void)removeAllObjects { while([self count]) [self removeObjectAtIndex:[self count]-1]; }
- (NSUInteger)countByEnumeratingWithState:(NSFastEnumerationState *)state objects:(id *)buffer count:(NSUInteger)length {
  arrayError(NSInvalidArgumentException,@"NSMutableArray subclass must override fast enumeration");return 0;
}
@end
@implementation _GUCArray
- (id)init { return initializeObjects(self,&_storage,NULL,0); }
- (id)initWithObjects:(const id *)objects count:(NSUInteger)count { return initializeObjects(self,&_storage,objects,count); }
- (id)initWithArray:(NSArray *)array { return initializeArray(self,&_storage,array); }
- (NSUInteger)count { return _storage.count; }
- (id)objectAtIndex:(NSUInteger)index { indexCheck(index,_storage.count,NO);return _storage.slots[index]; }
- (id)copy { return [self class]==[_GUCArray class] ? [self retain] : [super copy]; }
- (void)dealloc { @try { detachAll(&_storage,YES); } @finally { [super dealloc]; } }
@end
@implementation _GUCMutableArray
- (id)init { return initializeObjects(self,&_storage,NULL,0); }
- (id)initWithObjects:(const id *)objects count:(NSUInteger)count { return initializeObjects(self,&_storage,objects,count); }
- (id)initWithArray:(NSArray *)array { return initializeArray(self,&_storage,array); }
- (id)initWithCapacity:(NSUInteger)capacity { return initializeCapacity(self,&_storage,capacity); }
- (NSUInteger)count { return _storage.count; }
- (id)objectAtIndex:(NSUInteger)index { indexCheck(index,_storage.count,NO);return _storage.slots[index]; }
- (void)insertObject:(id)object atIndex:(NSUInteger)index { insertOrReplace(&_storage,object,index,YES); }
- (void)replaceObjectAtIndex:(NSUInteger)index withObject:(id)object { insertOrReplace(&_storage,object,index,NO); }
- (void)removeObjectAtIndex:(NSUInteger)index {
  generationRoom(&_storage);indexCheck(index,_storage.count,NO);
  id old=_storage.slots[index];_storage.count--;
  memmove(_storage.slots+index,_storage.slots+index+1,(_storage.count-index)*sizeof(id));
  _storage.generation++;[old release];
}
- (void)removeAllObjects { detachAll(&_storage,NO); }
- (NSUInteger)countByEnumeratingWithState:(NSFastEnumerationState *)state objects:(id *)buffer count:(NSUInteger)length {
  return enumerate(self,state,buffer,length,&_storage.generation);
}
- (void)dealloc { @try { detachAll(&_storage,YES); } @finally { [super dealloc]; } }
@end
