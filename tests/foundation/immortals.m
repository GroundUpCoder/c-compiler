#include <Foundation/Foundation.h>
#include <limits.h>
#include <stdio.h>
/* ABI provider fixture solely for runtime provenance testing. This is NOT
   the real NSString/NSConstantString implementation funded by #778. */
@interface NSString : NSObject @end
@implementation NSString @end
@interface NSConstantString : NSString {
  unsigned flags, length, bytes, hash;
  const void *data;
}
@end
@implementation NSConstantString @end
static int loaded;
@interface LoadProbe : NSObject
+ (void)load;
@end
@implementation LoadProbe
+ (void)load {
  id literal=@"before load";
  [literal retain]; [literal release]; guc_objc_dispose(literal);
  if([literal retainCount]==UINT_MAX) loaded=1;
}
@end
int main(void) {
  if(!loaded) return 1;
  id a=@"a\0\U0001F642", b=[NSConstantString new];
  if([a retain]!=a || [a autorelease]!=a || [a retainCount]!=UINT_MAX) return 2;
  [a release]; guc_objc_dispose(a);
  if([b retainCount]!=1) return 3;
  [b release];
  guc_objc_dispose((id)NSObject);
  if([NSObject class]!=NSObject) return 4;
  puts("FOUNDATION immortal provenance PASS"); return 0;
}
