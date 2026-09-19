#include <Foundation/NSEnumerator.h>
#include <Foundation/NSException.h>
#include <stdio.h>
#include <stdlib.h>
void objc_enumerationMutation(id collection) {
  (void)collection;
  NSException *exception=[[NSException alloc] initWithName:NSGenericException
    reason:@"Collection mutated during fast enumeration" userInfo:nil];
  if(!exception) { fprintf(stderr,"NSFastEnumeration: cannot allocate exception\n"); abort(); }
  @try { [exception raise]; }
  @finally { [exception release]; }
}
