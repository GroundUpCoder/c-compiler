#include <Foundation/Foundation.h>
#include <stdio.h>
#include <limits.h>
#define CHECK(x) do{if(!(x)){printf("array-reentrancy failure %d\n",__LINE__);return __LINE__;}}while(0)
static NSMutableArray *owner;
static int action,dead;
static id thrown=@"release threw";
@interface Callback : NSObject { @public int failRelease; }
- (id)retain;
- (void)release;
- (void)dealloc;
@end
@implementation Callback
- (id)retain {
 int a=action;action=0;
 if(a==1) [owner replaceObjectAtIndex:1 withObject:@"changed"];
 if(a==2) {NSFastEnumerationState s={0};id b[1];[owner countByEnumeratingWithState:&s objects:b count:1];*s.mutationsPtr=ULONG_MAX;}
 if(a==3) [owner removeAllObjects];
 return [super retain];
}
- (void)release {int fail=failRelease;[super release];if(fail)@throw thrown;}
- (void)dealloc {dead++;[super dealloc];}
@end
int main(void) {
 @autoreleasepool {
  owner=[NSMutableArray array];Callback *p=[Callback new];[owner addObject:p];[owner addObject:@"old"];
  action=1;int caught=0;
  @try {[[NSArray alloc] initWithArray:owner];} @catch(NSException *e){CHECK([[e name] isEqual:NSGenericException]);caught++;}
  CHECK(caught==1 && [[owner lastObject] isEqual:@"changed"]);
  [owner removeAllObjects];[p release];CHECK(dead==1);
  [owner addObject:@"old"];p=[Callback new];action=3;
  @try {[owner insertObject:p atIndex:1];} @catch(NSException *e){CHECK([[e name] isEqual:NSRangeException]);caught++;}
  CHECK(caught==2 && ![owner count]);[p release];CHECK(dead==2);
  p=[Callback new];[owner addObject:p];[p release];p->failRelease=1;
  @try {[owner replaceObjectAtIndex:0 withObject:@"committed"];} @catch(id e){CHECK(e==thrown);caught++;}
  CHECK(caught==3 && dead==3 && [[owner firstObject] isEqual:@"committed"]);
  [owner removeAllObjects];p=[Callback new];[owner addObject:p];[p release];p->failRelease=1;
  @try {[owner removeObjectAtIndex:0];} @catch(id e){CHECK(e==thrown);caught++;}
  CHECK(caught==4 && dead==4 && ![owner count]);
  [owner addObject:@"old"];p=[Callback new];action=2;
  @try {[owner insertObject:p atIndex:1];} @catch(NSException *e){CHECK([[e name] isEqual:NSGenericException]);caught++;}
  CHECK(caught==5 && [owner count]==1);[p release];CHECK(dead==5);
 }
 puts("FOUNDATION array-reentrancy PASS");return 0;
}
