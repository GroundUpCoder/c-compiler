#include <Foundation/Foundation.h>
static BOOL subclass(Class cls, Class parent) {
  for (; cls; cls=cls->parent) if(cls==parent) return YES;
  return NO;
}
@implementation NSObject
+ (id)alloc { return guc_objc_alloc(self); }
+ (id)new { return [[self alloc] init]; }
- (id)init { return self; }
- (void)dealloc { guc_objc_dispose(self); }
- (id)retain { return __guc_objc_retain(self); }
- (void)release { if(__guc_objc_release(self)) [self dealloc]; }
- (id)autorelease { if(!__guc_objc_is_immortal(self)) [NSAutoreleasePool addObject:self]; return self; }
- (NSUInteger)retainCount { return __guc_objc_retain_count(self); }
+ (id)retain { return self; }
+ (void)release {}
+ (id)autorelease { return self; }
+ (NSUInteger)retainCount { return 0xffffffffU; }
+ (Class)class { return self; }
- (Class)class { return *(Class *)self; }
+ (Class)superclass { return self->parent; }
- (Class)superclass { return (*(Class *)self)->parent; }
+ (id)self { return self; }
- (id)self { return self; }
+ (BOOL)isEqual:(id)object { return (id)self==object; }
- (BOOL)isEqual:(id)object { return self==object; }
+ (NSUInteger)hash { return (NSUInteger)self >> 2; }
- (NSUInteger)hash { return (NSUInteger)self >> 2; }
- (BOOL)isKindOfClass:(Class)cls { return subclass(*(Class *)self,cls); }
- (BOOL)isMemberOfClass:(Class)cls { return *(Class *)self==cls; }
+ (BOOL)isSubclassOfClass:(Class)cls { return subclass(self,cls); }
+ (BOOL)respondsToSelector:(SEL)selector { return selector && __guc_objc_find(self->isa,selector)!=0; }
- (BOOL)respondsToSelector:(SEL)selector { return selector && __guc_objc_find(*(Class *)self,selector)!=0; }
+ (BOOL)instancesRespondToSelector:(SEL)selector { return selector && __guc_objc_find(self,selector)!=0; }
@end
