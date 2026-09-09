#include <Foundation/Foundation.h>
#include <stdlib.h>
static NSAutoreleasePool *pool;
@interface Recursor : NSObject
- (void)dealloc;
@end
@implementation Recursor
- (void)dealloc { [pool drain]; [super dealloc]; }
@end
int main(int argc, char **argv) {
  pool=[NSAutoreleasePool new];
  int kind=argc>1 ? atoi(argv[1]) : 0;
  if(kind==0) [pool retain];
  if(kind==1) [pool autorelease];
  if(kind==2) { [[Recursor new] autorelease]; [pool drain]; }
  return 2;
}
