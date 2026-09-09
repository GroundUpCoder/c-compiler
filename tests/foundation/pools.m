#include <Foundation/Foundation.h>
#include <stdio.h>
static int destroyed, spawned;
@interface Item : NSObject { @public int reenter; }
- (void)dealloc;
@end
@implementation Item
- (void)dealloc {
  destroyed++;
  if(reenter) {
    Item *a=[Item new]; [a autorelease]; spawned++;
    NSAutoreleasePool *p=[NSAutoreleasePool new];
    [[Item new] autorelease]; [p drain];
  }
  [super dealloc];
}
@end
int main(void) {
  NSAutoreleasePool *outer=[NSAutoreleasePool new];
  Item *a=[Item new];
  if([a autorelease]!=a || destroyed) return 1;
  [a retain]; [a autorelease];
  NSAutoreleasePool *inner=[NSAutoreleasePool new];
  Item *b=[Item new]; b->reenter=1; [b autorelease];
  [inner drain]; if(destroyed!=3 || spawned!=1) return 2;
  if([a retainCount]!=2) return 3;
  [outer release]; if(destroyed!=4) return 4;
  outer=[NSAutoreleasePool new];
  [[Item new] autorelease];
  inner=[NSAutoreleasePool new]; [[Item new] autorelease];
  [outer drain]; if(destroyed!=6) return 5;
  outer=[NSAutoreleasePool new]; [NSAutoreleasePool addObject:nil]; [outer addObject:nil]; [outer drain];
  puts("FOUNDATION pools PASS"); return 0;
}
