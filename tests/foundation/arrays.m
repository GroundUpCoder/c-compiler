#include <Foundation/Foundation.h>
#include <stdio.h>
#include <limits.h>
#define CHECK(x) do { if(!(x)) {printf("arrays failure %d\n",__LINE__);return __LINE__;} } while(0)
static int destroyed;
@interface Item : NSObject
- (void)dealloc;
@end
@implementation Item
- (void)dealloc { destroyed++;[super dealloc]; }
@end
int main(void) {
 @autoreleasepool {
  NSArray *empty=[NSArray array];CHECK([empty count]==0 && ![empty firstObject] && ![empty lastObject]);
  NSMutableArray *a=[NSMutableArray arrayWithCapacity:64];CHECK(![a count]);
  Item *item=[Item new];[a addObject:item];[a addObject:item];[item release];CHECK(!destroyed);
  [a removeObjectAtIndex:0];CHECK(!destroyed && [a count]==1);[a removeAllObjects];CHECK(destroyed==1);
  @autoreleasepool { [a addObject:[NSString stringWithUTF8String:"heap😀"]]; }
  CHECK([[a firstObject] isEqualToString:@"heap😀"]);
  [a insertObject:@"zero" atIndex:0];[a addObject:@"two"];[a replaceObjectAtIndex:1 withObject:[a objectAtIndex:1]];
  CHECK([a count]==3 && [[a firstObject] isEqual:@"zero"] && [[a lastObject] isEqual:@"two"]);
  NSArray *copy=[a copy];NSMutableArray *mutable=[copy mutableCopy];id same=[copy copy];CHECK(same==copy);[same release];
  CHECK([copy isEqualToArray:a] && [copy hash]==[a hash]);[a removeAllObjects];CHECK([copy count]==3 && [mutable count]==3);
  [mutable replaceObjectAtIndex:0 withObject:@"different"];CHECK(![copy isEqual:mutable]);
  CHECK([copy containsObject:[NSString stringWithUTF8String:"two"]]);CHECK(![copy containsObject:nil]);
  CHECK(![copy isEqual:@"zero"] && ![copy isEqualToArray:nil]);
  [copy release];[mutable release];
  int errors=0;
  @try {[a addObject:nil];} @catch(NSException *e){CHECK([[e name] isEqual:NSInvalidArgumentException]);errors++;}
  @try {[a objectAtIndex:0];} @catch(NSException *e){CHECK([[e name] isEqual:NSRangeException]);errors++;}
  @try {[a insertObject:@"x" atIndex:1];} @catch(NSException *e){CHECK([[e name] isEqual:NSRangeException]);errors++;}
  @try {[a replaceObjectAtIndex:0 withObject:@"x"];} @catch(NSException *e){CHECK([[e name] isEqual:NSRangeException]);errors++;}
  @try {[a removeObjectAtIndex:0];} @catch(NSException *e){CHECK([[e name] isEqual:NSRangeException]);errors++;}
  @try {[[NSArray alloc] initWithArray:nil];} @catch(NSException *e){CHECK([[e name] isEqual:NSInvalidArgumentException]);errors++;}
  @try {[a initWithArray:a];} @catch(NSException *e){CHECK([[e name] isEqual:NSInvalidArgumentException]);errors++;}
  CHECK(errors==7 && [a count]==0);
  [a addObject:@"one"];
  NSFastEnumerationState state={0};id buffer[1];CHECK([a countByEnumeratingWithState:&state objects:buffer count:1]==1);
  /* Explicit fault injection into the collection's published token. */
  *state.mutationsPtr=ULONG_MAX;
  @try {[a addObject:@"two"];} @catch(NSException *e){CHECK([[e name] isEqual:NSGenericException]);errors++;}
  CHECK(errors==8 && [a count]==1);
 }
 puts("FOUNDATION arrays PASS");return 0;
}
