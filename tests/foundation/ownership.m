#include <Foundation/Foundation.h>
#include <stdio.h>
static int destroyed, parents, initialized;
@interface Parent : NSObject { @public int zero; double other; id child; }
- (id)init;
- (void)dealloc;
@end
@implementation Parent
- (id)init { self=[super init]; if(self) { if(zero || other || child) return nil; initialized++; zero=23; } return self; }
- (void)dealloc { parents++; [child release]; [super dealloc]; }
@end
@interface Child : Parent
- (void)dealloc;
@end
@implementation Child
- (void)dealloc { destroyed++; [super dealloc]; }
@end
@interface Failing : NSObject
- (id)init;
@end
@implementation Failing
- (id)init { [self release]; return nil; }
@end
static id replacement;
@interface Replacing : NSObject
- (id)init;
@end
@implementation Replacing
- (id)init { [self release]; return [replacement retain]; }
@end
int main(void) {
  Child *a=[Child new];
  if(!a || a->zero!=23 || initialized!=1 || [a retainCount]!=1) return 1;
  if([a retain]!=a || [a retainCount]!=2) return 2;
  [a release]; if(destroyed || [a retainCount]!=1) return 3;
  a->child=[Child new]; [a release];
  if(destroyed!=2 || parents!=2) return 4;
  if([Failing new]!=nil) return 5;
  replacement=[NSObject new]; id b=[Replacing new];
  if(b!=replacement || [b retainCount]!=2) return 6;
  [b release]; [replacement release];
  NSObject *n=nil; [n release]; if([n retain] || [n autorelease] || [n init]) return 7;
  puts("FOUNDATION ownership PASS"); return 0;
}
