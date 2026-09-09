#include "cross.h"
#include <stdio.h>
int main(void) {
  NSAutoreleasePool *pool=[NSAutoreleasePool new];
  id a=create(); if(keep(a)!=a) return 1;
  later(a); finish(pool); if(destroyed) return 2;
  [a release]; if(destroyed!=1) return 3;
  puts("FOUNDATION cross-TU PASS"); return 0;
}
