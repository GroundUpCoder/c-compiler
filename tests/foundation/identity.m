#include <Foundation/Foundation.h>
#include <limits.h>
#include <stdio.h>
@interface Base : NSObject
- (int)value;
+ (int)classValue;
@end
@implementation Base
- (int)value { return 7; }
+ (int)classValue { return 9; }
@end
@interface Sub : Base @end
@implementation Sub @end
@interface Other : NSObject
- (void)unrelated;
@end
@implementation Other
- (void)unrelated {}
@end
int main(void) {
  Sub *a=[Sub new]; Sub *b=[Sub new];
  if([a class]!=Sub || [Sub class]!=Sub || [a superclass]!=Base || [Sub superclass]!=Base) return 1;
  NSObject *root=[NSObject new];
  if([NSObject superclass]!=Nil || [root superclass]!=Nil) return 2;
  [root release];
  if([a self]!=a || [Sub self]!=(id)Sub) return 3;
  if(![a isEqual:a] || [a isEqual:b] || [a isEqual:nil] || [a hash]!=[a hash]) return 4;
  if(![a isKindOfClass:Base] || ![a isKindOfClass:NSObject] || [a isKindOfClass:Other] || [a isKindOfClass:Nil]) return 5;
  if(![a isMemberOfClass:Sub] || [a isMemberOfClass:Base]) return 6;
  if(![Sub isSubclassOfClass:Base] || ![Sub isSubclassOfClass:Sub] || [Sub isSubclassOfClass:Other]) return 7;
  if(![a respondsToSelector:@selector(value)] || [a respondsToSelector:@selector(classValue)] || [a respondsToSelector:@selector(unrelated)] || [a respondsToSelector:(SEL)0]) return 8;
  if(![Sub respondsToSelector:@selector(classValue)] || [Sub respondsToSelector:@selector(value)]) return 9;
  if(![Sub instancesRespondToSelector:@selector(value)] || [Sub instancesRespondToSelector:@selector(classValue)]) return 10;
  if([Sub retain]!=(id)Sub || [Sub autorelease]!=(id)Sub || [Sub retainCount]!=UINT_MAX) return 11;
  [Sub release]; if([Sub classValue]!=9) return 12;
  [a release]; [b release]; puts("FOUNDATION identity PASS"); return 0;
}
