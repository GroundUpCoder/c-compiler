#include <Foundation/Foundation.h>
#include <stdlib.h>
int main(void) {
  NSAutoreleasePool *pool=[NSAutoreleasePool new];
  NSObject *a=[NSObject new];
  if(!pool || !a) return 1;
  while(malloc(8)) {}
  [a autorelease];
  return 2;
}
