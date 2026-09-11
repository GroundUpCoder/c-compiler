#ifndef GUC_FOUNDATION_NSENUMERATOR_H
#define GUC_FOUNDATION_NSENUMERATOR_H
#include <Foundation/NSObject.h>
__require_source("foundation/NSEnumerator.m");
typedef struct {
  unsigned long state;
  id *itemsPtr;
  unsigned long *mutationsPtr;
  unsigned long extra[5];
} NSFastEnumerationState;
@protocol NSFastEnumeration
- (NSUInteger)countByEnumeratingWithState:(NSFastEnumerationState *)state objects:(id *)buffer count:(NSUInteger)length;
@end
void objc_enumerationMutation(id collection);
#endif
