#include <Foundation/Foundation.h>
#include <stdio.h>
static int destroyed;
@interface Item : NSObject
- (void)dealloc;
@end
@implementation Item
- (void)dealloc { destroyed++; [super dealloc]; }
@end
int main(void) {
  Item *a=[Item new];
  if([a autorelease]!=a || destroyed || [a retainCount]!=1) return 1;
  [a release]; if(destroyed!=1) return 2;
  puts("FOUNDATION missing pool PASS"); return 0;
}
