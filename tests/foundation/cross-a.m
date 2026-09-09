#include "cross.h"
int destroyed;
@implementation Tracked
- (void)dealloc { destroyed++; [super dealloc]; }
@end
id create(void) { return guc_objc_alloc(Tracked); }
id keep(id object) { return [object retain]; }
