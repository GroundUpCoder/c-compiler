#include <stdio.h>
/* A genuine Foundation-free object and compatible protocol ABI. */
typedef struct {unsigned long state;id *itemsPtr;unsigned long *mutationsPtr;unsigned long extra[5];} IterationState;
@interface Plain { @public unsigned long generation;id items[2]; }
+ (id)new;
- (unsigned int)countByEnumeratingWithState:(IterationState *)state objects:(id *)buffer count:(unsigned int)length;
@end
@implementation Plain
+ (id)new {return guc_objc_alloc(self);}
- (unsigned int)countByEnumeratingWithState:(IterationState *)s objects:(id *)b count:(unsigned int)n {
 (void)b;(void)n;s->itemsPtr=items;s->mutationsPtr=&generation;if(s->state)return 0;s->state=1;return 2;
}
@end
static int detected;
#ifndef OMIT_PROVIDER
void objc_enumerationMutation(id object) {(void)object;detected++;}
#endif
int main(void) {
 Plain *p=[Plain new];p->items[0]=p;p->items[1]=p;int count=0;
 for(id x in p){if(x!=p)return 1;if(!count)p->generation++;count++;}
 guc_objc_dispose(p);
 if(count!=2 || detected!=1)return 2;
 puts("FOUNDATION array-provider PASS");return 0;
}
