#include <Foundation/Foundation.h>
#include <stdlib.h>
int main(void) {
  while(malloc(8)) {}
  @autoreleasepool { return 2; }
}
