#ifndef GUC_FOUNDATION_NSARRAY_H
#define GUC_FOUNDATION_NSARRAY_H
#include <Foundation/NSEnumerator.h>
__require_source("foundation/NSArray.m");
@interface NSArray : NSObject <NSFastEnumeration>
+ (id)alloc;
+ (id)array;
+ (id)arrayWithObject:(id)object;
+ (id)arrayWithObjects:(const id *)objects count:(NSUInteger)count;
+ (id)arrayWithArray:(NSArray *)array;
- (id)init;
- (id)initWithObjects:(const id *)objects count:(NSUInteger)count;
- (id)initWithArray:(NSArray *)array;
- (NSUInteger)count;
- (id)objectAtIndex:(NSUInteger)index;
- (id)firstObject;
- (id)lastObject;
- (BOOL)containsObject:(id)object;
- (BOOL)isEqualToArray:(NSArray *)array;
- (BOOL)isEqual:(id)object;
- (NSUInteger)hash;
- (id)copy;
- (id)mutableCopy;
- (NSUInteger)countByEnumeratingWithState:(NSFastEnumerationState *)state objects:(id *)buffer count:(NSUInteger)length;
@end
@interface NSMutableArray : NSArray
+ (id)alloc;
+ (id)arrayWithCapacity:(NSUInteger)capacity;
- (id)initWithCapacity:(NSUInteger)capacity;
- (void)addObject:(id)object;
- (void)insertObject:(id)object atIndex:(NSUInteger)index;
- (void)removeObjectAtIndex:(NSUInteger)index;
- (void)replaceObjectAtIndex:(NSUInteger)index withObject:(id)object;
- (void)removeAllObjects;
- (NSUInteger)countByEnumeratingWithState:(NSFastEnumerationState *)state objects:(id *)buffer count:(NSUInteger)length;
@end
#endif
