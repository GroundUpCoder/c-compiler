#include <Foundation/Foundation.h>
#include <stdio.h>
#include <stdlib.h>
#define CHECK(x) do{if(!(x)){printf("array-subclasses failure %d\n",__LINE__);return __LINE__;}}while(0)
@interface Custom : NSArray { id *slots;NSUInteger size; }
- (id)init;
- (id)initWithObjects:(const id *)objects count:(NSUInteger)count;
- (id)initWithArray:(NSArray *)array;
- (NSUInteger)count;
- (id)objectAtIndex:(NSUInteger)index;
- (void)dealloc;
@end
@implementation Custom
- (id)init {return self;}
- (id)initWithObjects:(const id *)objects count:(NSUInteger)count {
 slots=malloc(count*sizeof(id));if(count && !slots)abort();size=count;
 for(NSUInteger i=0;i<count;i++)slots[i]=[objects[i] retain];return self;
}
- (id)initWithArray:(NSArray *)a {
 NSUInteger count=[a count];id *items=malloc(count*sizeof(id));if(count && !items)abort();
 for(NSUInteger i=0;i<count;i++)items[i]=[a objectAtIndex:i];
 [self initWithObjects:items count:count];free(items);return self;
}
- (NSUInteger)count {return size;}
- (id)objectAtIndex:(NSUInteger)i {if(i>=size)abort();return slots[i];}
- (void)dealloc {for(NSUInteger i=0;i<size;i++)[slots[i] release];free(slots);[super dealloc];}
@end
@interface CustomMutable : NSMutableArray {id slots[64];NSUInteger size;unsigned long version;}
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
@implementation CustomMutable
- (id)init {return self;}
- (id)initWithObjects:(const id *)objects count:(NSUInteger)n {for(NSUInteger i=0;i<n;i++)[self addObject:objects[i]];return self;}
- (id)initWithArray:(NSArray *)a {for(id x in a)[self addObject:x];return self;}
- (id)initWithCapacity:(NSUInteger)c {if(c>64)abort();return self;}
- (NSUInteger)count {return size;}
- (id)objectAtIndex:(NSUInteger)i {if(i>=size)abort();return slots[i];}
- (void)insertObject:(id)x atIndex:(NSUInteger)i {
 if(!x || i>size || size==64)abort();[x retain];for(NSUInteger k=size;k>i;k--)slots[k]=slots[k-1];slots[i]=x;size++;version++;
}
- (void)removeObjectAtIndex:(NSUInteger)i {
 if(i>=size)abort();id old=slots[i];size--;for(NSUInteger k=i;k<size;k++)slots[k]=slots[k+1];version++;[old release];
}
- (void)replaceObjectAtIndex:(NSUInteger)i withObject:(id)x {
 if(i>=size || !x)abort();[x retain];id old=slots[i];slots[i]=x;version++;[old release];
}
- (void)removeAllObjects {
 id old[64];NSUInteger n=size;for(NSUInteger i=0;i<n;i++)old[i]=slots[i];size=0;version++;
 for(NSUInteger i=0;i<n;i++)[old[i] release];
}
- (NSUInteger)countByEnumeratingWithState:(NSFastEnumerationState *)s objects:(id *)b count:(NSUInteger)n {
 s->mutationsPtr=&version;s->itemsPtr=b;NSUInteger i=s->state,k=0;
 while(i<size && k<n)b[k++]=slots[i++];s->state=i;return k;
}
- (void)dealloc {[self removeAllObjects];[super dealloc];}
@end
@interface MissingEnumeration : NSMutableArray
- (id)init;
@end
@implementation MissingEnumeration
- (id)init {return self;}
@end
static CustomMutable *owner;
@interface AddOnRelease : NSObject
- (void)dealloc;
@end
@implementation AddOnRelease
- (void)dealloc {[owner addObject:@"new"];[super dealloc];}
@end
int main(void) {
 @autoreleasepool {
  Custom *c=[Custom array];CHECK([c class]==[Custom class] && ![c count]);
  c=[Custom arrayWithObject:@"one"];CHECK([c class]==[Custom class] && [[c lastObject] isEqual:@"one"]);
  Custom *d=[Custom arrayWithArray:c];CHECK([d class]==[Custom class] && [d isEqual:c]);
  NSArray *copy=[c copy];CHECK(copy!=c && [copy isEqual:c]);[copy release];
  NSMutableArray *m=[c mutableCopy];[m addObject:@"two"];CHECK([m count]==2 && [c count]==1);[m release];
  owner=[CustomMutable arrayWithCapacity:4];CHECK([owner class]==[CustomMutable class] && ![owner count]);
  [owner addObject:@"one"];[owner insertObject:@"zero" atIndex:0];CHECK([[owner firstObject] isEqual:@"zero"]);
  int count=0;for(id x in owner)count++;CHECK(count==2);
  int caught=0;@try {for(id x in owner)[owner replaceObjectAtIndex:0 withObject:@"zero"];}
  @catch(NSException *e){CHECK([[e name] isEqual:NSGenericException]);caught++;}CHECK(caught==1);
  copy=[owner copy];CHECK([copy isEqual:owner]);[copy release];
  CustomMutable *other=[CustomMutable arrayWithArray:owner];CHECK([other class]==[CustomMutable class] && [other count]==2);
  [owner removeAllObjects];AddOnRelease *r=[AddOnRelease new];[owner addObject:r];[r release];[owner removeAllObjects];
  CHECK([owner count]==1 && [[owner firstObject] isEqual:@"new"]);
  @try {for(id x in [MissingEnumeration array])CHECK(0);}
  @catch(NSException *e){CHECK([[e name] isEqual:NSInvalidArgumentException]);caught++;}CHECK(caught==2);
 }
 puts("FOUNDATION array-subclasses PASS");return 0;
}
