#include <stdlib.h>
@interface Counter {
  int value;
  double fraction;
  void *payload;
}
+ (id)alloc;
+ (int)kind;
- (int)add:(int)n;
- (double)scale:(double)x;
- (float)single:(float)x;
- (void *)pointer:(void *)p;
- (long long)wide:(long long)n;
- (SEL)selector;
- (void)clear;
@end
@implementation Counter
+ (id)alloc { return guc_objc_alloc(self); }
+ (int)kind { return 4; }
- (int)add:(int)n { value += n; return value; }
- (double)scale:(double)x { fraction = x * 1.5; return fraction; }
- (float)single:(float)x { return x + 0.25f; }
- (void *)pointer:(void *)p { payload = p; return payload; }
- (long long)wide:(long long)n { return n + 2; }
- (SEL)selector { return _cmd; }
- (void)clear { value = 0; }
@end
@interface Child : Counter { int extra; }
- (int)add:(int)n;
+ (int)kind;
@end
@implementation Child
- (int)add:(int)n { extra++; return [super add:n] + extra * 10; }
+ (int)kind { return [super kind] + 3; }
@end
@interface Grandchild : Child
@end
@implementation Grandchild
@end
static int receivers, arguments;
static id receiver(id o) { receivers++; return o; }
static int argument(void) { arguments++; return 3; }
int main(void) {
  id object = [Grandchild alloc];
  if (!object) return 1;
  if ([receiver(object) add:argument()] != 13) return 2;
  if (receivers != 1 || arguments != 1) return 3;
  if ([object add:2] != 25 || [Grandchild kind] != 7) return 4;
  if ([object scale:2.5] != 3.75 || [object single:1.0f] != 1.25f) return 5;
  int payload = 9;
  if ([object pointer:&payload] != &payload) return 6;
  if ([object wide:4294967296LL] != 4294967298LL) return 7;
  if ([object selector] != @selector(selector)) return 8;
  [object clear];
  if ([object add:0] != 30) return 9;
  if ([receiver(nil) add:argument()] != 0) return 10;
  if (receivers != 2 || arguments != 2) return 11;
  if ([nil scale:5.0] != 0.0 || [nil single:3.0f] != 0.0f) return 12;
  if ([nil pointer:&payload] != 0 || [nil wide:99LL] != 0) return 13;
  [nil clear];
  guc_objc_dispose(object);
  guc_objc_dispose(nil);
  return 0;
}
