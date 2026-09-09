#include <Foundation/Foundation.h>
#include <stdlib.h>
#include <stdio.h>
/* Harness caps Wasm memory at its initial pages, preserving implementation
   code. Exhaust it without making a host-wide allocation-pressure test. */
int main(void) {
  while(malloc(8)) {}
  if([NSObject alloc]!=nil || [NSObject new]!=nil) return 1;
  puts("FOUNDATION allocation failure PASS"); return 0;
}
