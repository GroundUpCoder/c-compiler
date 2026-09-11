#include <Foundation/NSException.h>
#include <stdio.h>
#include <stdlib.h>
static void *blocks[131072];
int main(int argc, char **argv) {
  NSString *receiver=[NSString alloc];
  if(!receiver) {fputs("fixture receiver allocation failed\n",stderr);return 2;}
  unsigned count=0;
  while(count<131072 && (blocks[count]=malloc(8))) count++;
  if(count==131072) {fputs("fixture did not exhaust heap\n",stderr);return 2;}
  /* The invalid argument needs a real NSException, but no heap is available.
   * Reporting must terminate once, not recursively allocate another exception
   * or let catch-all convert the fatal diagnostic into ordinary control flow. */
  @try {
    if(argc>1) [@"" characterAtIndex:0];
    else [receiver initWithUTF8String:NULL];
  }
  @catch(...) {fputs("unexpected caught diagnostic exhaustion\n",stderr);return 1;}
  fputs("unexpected return from invalid initializer\n",stderr);return 1;
}
