#include <Foundation/Foundation.h>
#include <stdio.h>
static int destroyed, created;
@interface Item : NSObject { @public int spawn; }
- (id)init;
- (void)dealloc;
@end
@implementation Item
- (id)init { self=[super init]; if(self) created++; return self; }
- (void)dealloc {
  destroyed++;
  if(spawn) {
    for(int i=0;i<130;i++) [[Item new] autorelease];
    [NSAutoreleasePool new];
    [[Item new] autorelease];
  }
  [super dealloc];
}
@end
static void cycle(void) {
  NSAutoreleasePool *outer=[NSAutoreleasePool new];
  NSAutoreleasePool *inner=[NSAutoreleasePool new];
  for(int i=0;i<130;i++) { Item *a=[Item new]; a->spawn=i==129; [a autorelease]; }
  Item *survivor=[Item new]; [survivor retain];
  [outer addObject:survivor]; [inner addObject:survivor];
  [outer drain];
}
int main(void) {
  cycle();
  if(created!=262 || destroyed!=created) return 1;
  unsigned pages=__builtin(memory_size);
  for(int i=0;i<300;i++) { cycle(); if(destroyed!=created) return 2; }
  if(__builtin(memory_size)!=pages) return 3;
  puts("FOUNDATION reentrant growth PASS"); return 0;
}
