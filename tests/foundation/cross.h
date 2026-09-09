#include <Foundation/Foundation.h>
extern int destroyed;
@interface Tracked : NSObject
- (void)dealloc;
@end
id create(void);
id keep(id object);
void later(id object);
void finish(id pool);
